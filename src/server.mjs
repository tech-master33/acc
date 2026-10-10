/**
 * ACC's HTTP server: the Anthropic surface Claude clients use, plus the small
 * JSON API behind the control panel.
 */

import http from "node:http";

import { anthropicError, estimateTokens, sse } from "./anthropic.mjs";
import { collectModels, encodeCatalog, invalidateCatalog } from "./catalog.mjs";
import { configPath, loadConfig, saveConfig, updateProvider } from "./config.mjs";
import { connectClaudeCode, connectClaudeDesktop, disconnectClaudeCode, disconnectClaudeDesktop, desktopPaths, claudeCodeSettingsPath } from "./connect.mjs";
import { decodeModelId, splitRef } from "./ids.mjs";
import { ADAPTERS, getAdapter } from "./providers.mjs";
import { panelHtml } from "./ui.mjs";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const PANEL_TARGETS = new Set(["claude-code", "claude-desktop"]);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  response.end(html);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be JSON"), { status: 400 });
  }
}

function authorized(request, config) {
  if (!config.authToken) return true;
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey === config.authToken) return true;
  const authorization = request.headers.authorization ?? "";
  return authorization.toLowerCase() === `bearer ${config.authToken}`.toLowerCase();
}

/**
 * Accept both ids ACC advertises and bare `provider/model` refs, which is the
 * form the control panel stores as the fallback model.
 */
function decodeAny(raw) {
  if (typeof raw !== "string") return null;
  let decoded = null;
  try {
    decoded = decodeModelId(raw);
  } catch (error) {
    throw Object.assign(error, { status: 400 });
  }
  if (decoded) return decoded;
  const ref = splitRef(raw);
  if (ref && getAdapter(ref.providerId)) return { ...ref, forceNoThinking: false };
  return null;
}

/** Resolve the requested model to `{ providerId, upstreamModel, forceNoThinking }`. */
function resolveTarget(body, config) {
  const requested = body?.model;
  let decoded = decodeAny(requested);
  if (!decoded && config.defaultModel) {
    decoded = decodeAny(config.defaultModel);
  }
  if (!decoded) {
    const enabled = Object.entries(ADAPTERS)
      .filter(([id]) => config.providers?.[id]?.enabled)
      .map(([id]) => id);
    throw Object.assign(
      new Error(
        enabled.length
          ? `No model "${requested ?? "(none)"}" is served here, and no fallback model is set. Pick one in the ACC panel (${enabled.join(", ")} enabled).`
          : `No model "${requested ?? "(none)"}" is served, and no provider is enabled. Turn one on in the ACC panel.`
      ),
      { status: 400 }
    );
  }
  const providerConfig = config.providers?.[decoded.providerId];
  if (!providerConfig?.enabled) {
    throw Object.assign(
      new Error(
        `Provider "${decoded.providerId}" is disabled. Enable it in the ACC control panel.`
      ),
      { status: 400 }
    );
  }
  return {
    providerId: decoded.providerId,
    upstreamModel: decoded.upstreamModel,
    forceNoThinking: decoded.forceNoThinking,
  };
}

export function createServer({ onConfigChange } = {}) {
  let config = loadConfig();
  const startedAt = Date.now();

  function persist(next) {
    config = next;
    saveConfig(config);
    invalidateCatalog();
    onConfigChange?.(config);
    return config;
  }

  async function adaptersState() {
    const { models, errors } = await collectModels(config);
    const byProvider = new Map();
    for (const model of models) {
      byProvider.set(model.providerId, (byProvider.get(model.providerId) ?? 0) + 1);
    }
    return {
      adapters: Object.values(ADAPTERS).map((adapter) => {
        const providerConfig = config.providers?.[adapter.id] ?? {};
        const described = adapter.describe(providerConfig);
        return {
          id: adapter.id,
          label: adapter.label,
          enabled: described.enabled,
          ready: described.ready,
          detail: errors[adapter.id] ? `${described.detail} (${errors[adapter.id]})` : described.detail,
          apiKey: Boolean(providerConfig.apiKey),
          hasKeyInput: adapter.id !== "opencode-registry",
          alwaysKeyed: adapter.id !== "opencode-registry",
          baseUrl: providerConfig.baseUrl ?? "",
          docsUrl: adapter.docsUrl ?? null,
          keyUrl: adapter.keyUrl ?? null,
          modelCount: byProvider.get(adapter.id) ?? 0,
        };
      }),
      models,
      errors,
    };
  }

  async function statePayload() {
    const { adapters, models, errors } = await adaptersState();
    return {
      host: config.host,
      port: config.port,
      views: ["Claude Code", "Claude Desktop"],
      adapters,
      models: models.map((model) => ({
        ref: model.ref,
        displayName: model.displayName,
        providerId: model.providerId,
        source: model.source,
        contextWindow: model.contextWindow ?? null,
        maxOutput: model.maxOutput ?? null,
      })),
      errors,
      defaultModel: config.defaultModel,
      hideClaudeModels: config.hideClaudeModels,
      authToken: config.authToken,
      configPath: configPath(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      paths: {
        claudeCode: claudeCodeSettingsPath(),
        claudeDesktop: desktopPaths().profile,
      },
    };
  }

  async function handleMessages(request, response) {
    const body = await readJson(request);
    if (!Array.isArray(body.messages)) {
      throw Object.assign(new Error("`messages` is required"), { status: 400 });
    }
    const target = resolveTarget(body, config);
    const adapter = getAdapter(target.providerId);

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.on("close", abort);

    try {
      const result = await adapter.handle({
        config: config.providers[target.providerId],
        upstreamModel: target.upstreamModel,
        forceNoThinking: target.forceNoThinking,
        body,
        signal: controller.signal,
      });

      if (!result.stream) {
        sendJson(response, 200, result.message);
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-acc-provider": target.providerId,
      });
      response.write(sse("ping", { type: "ping" }));
      for await (const frame of result.frames) {
        if (response.writableEnded) break;
        response.write(frame);
      }
      response.end();
    } finally {
      request.off("close", abort);
    }
  }

  async function handleApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, await statePayload());
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/registry") {
      const adapter = getAdapter("opencode-registry");
      const catalog = await adapter.catalog();
      const accounts = config.providers["opencode-registry"]?.accounts ?? {};
      sendJson(response, 200, {
        providers: catalog.map((provider) => ({
          ...provider,
          enabled: Boolean(accounts[provider.id]?.enabled),
          hasKey: Boolean(accounts[provider.id]?.apiKey),
          baseUrl: accounts[provider.id]?.baseUrl || provider.baseUrl || "",
        })),
      });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/registry") {
      const body = await readJson(request);
      const providerId = String(body.providerId ?? "").trim();
      if (!providerId) throw Object.assign(new Error("providerId is required"), { status: 400 });
      const accounts = { ...(config.providers["opencode-registry"]?.accounts ?? {}) };
      const current = accounts[providerId] ?? { enabled: false, apiKey: "", baseUrl: "" };
      accounts[providerId] = {
        ...current,
        enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
        apiKey: body.apiKey ? String(body.apiKey) : current.apiKey,
        baseUrl: body.baseUrl ? String(body.baseUrl) : current.baseUrl,
      };
      if (!accounts[providerId].enabled && !accounts[providerId].apiKey) delete accounts[providerId];
      persist(updateProvider(config, "opencode-registry", { accounts }));
      sendJson(response, 200, { ok: true, accounts });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/config") {
      const body = await readJson(request);
      let next = { ...config };
      if (body.providers && typeof body.providers === "object") {
        for (const [id, patch] of Object.entries(body.providers)) {
          if (!ADAPTERS[id]) throw Object.assign(new Error(`Unknown provider: ${id}`), { status: 400 });
          next = updateProvider(next, id, patch);
        }
      }
      if (typeof body.defaultModel === "string") next.defaultModel = body.defaultModel.trim();
      if (typeof body.hideClaudeModels === "boolean") next.hideClaudeModels = body.hideClaudeModels;
      if (typeof body.authToken === "string" && body.authToken.trim()) next.authToken = body.authToken.trim();
      if (body.port !== undefined) {
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw Object.assign(new Error("port must be 1-65535"), { status: 400 });
        }
        next.port = port;
      }
      persist(next);
      sendJson(response, 200, { ok: true, restartRequired: next.port !== config.port });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      invalidateCatalog();
      const { models, errors } = await collectModels(config, { refresh: true });
      sendJson(response, 200, { models, errors });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/connect") {
      const body = await readJson(request);
      const target = String(body.target ?? "");
      if (!PANEL_TARGETS.has(target)) {
        throw Object.assign(new Error("target must be claude-code or claude-desktop"), { status: 400 });
      }
      const action = body.action === "disconnect" ? "disconnect" : "connect";
      const result =
        target === "claude-code"
          ? action === "connect"
            ? connectClaudeCode(config)
            : disconnectClaudeCode()
          : action === "connect"
            ? connectClaudeDesktop(config)
            : disconnectClaudeDesktop();
      sendJson(response, 200, {
        ok: true,
        action,
        target,
        message: result.message,
        path: result.path,
      });
      return true;
    }
    return false;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/panel")) {
        sendHtml(response, panelHtml());
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          enabledProviders: Object.entries(ADAPTERS)
            .filter(([id]) => config.providers?.[id]?.enabled)
            .map(([id]) => id),
        });
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
        if (!(await handleApi(request, response, url))) {
          sendJson(response, 404, { error: "Unknown endpoint" });
        }
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        if (!authorized(request, config)) {
          sendJson(response, 401, {
            type: "error",
            error: { type: "authentication_error", message: "Missing or invalid ACC token." },
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/models") {
          const view =
            url.searchParams.get("view") ??
            request.headers["x-acc-model-view"] ??
            "claude";
          const { models } = await collectModels(config, { refresh: url.searchParams.has("refresh") });
          sendJson(
            response,
            200,
            encodeCatalog(
              {
                models,
                hideClaudeModels: config.hideClaudeModels,
                defaultModelRef: config.defaultModel,
              },
              view === "claude-desktop" ? "claude-desktop" : "claude"
            )
          );
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
          const body = await readJson(request);
          sendJson(response, 200, {
            input_tokens: estimateTokens(JSON.stringify(body.messages ?? [])) + estimateTokens(body.system ?? ""),
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/messages") {
          await handleMessages(request, response);
          return;
        }
      }
      sendJson(response, 404, { error: "Unknown endpoint" });
    } catch (error) {
      const status = error.status ?? 500;
      if (response.headersSent) {
        response.end();
        return;
      }
      const { body } = anthropicError(status, status === 400 ? "invalid_request_error" : "api_error", error.message);
      sendJson(response, status, body);
    }
  });

  server.on("clientError", (_error, socket) => socket.destroy());
  return {
    server,
    getConfig: () => config,
    reload: () => {
      config = loadConfig();
      invalidateCatalog();
    },
  };
}
