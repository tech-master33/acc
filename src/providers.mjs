/**
 * Provider adapters.
 *
 * Every adapter answers the same three questions:
 *
 *   describe()   — is this provider switched on, and is it usable?
 *   listModels() — what models can ACC advertise for it?
 *   handle()     — run one Anthropic Messages request upstream.
 *
 * Two upstream shapes are supported, matching reality:
 *   `anthropic`   — upstream speaks Messages (OpenCode Zen: `/v1/messages`).
 *   `openai-chat` — upstream speaks `POST /chat/completions` (Codebuff, and
 *                   the OpenAI-compatible providers in OpenCode's registry).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  fromOpenAIChatResponse,
  openAIStreamToAnthropic,
  toOpenAIChatRequest,
} from "./anthropic.mjs";

const ANTHROPIC_VERSION = "2023-06-01";
const OLLAMA_DEFAULT_BASE = "http://localhost:11434";
const CREDENTIAL_CACHE_MS = 10_000;
const REGISTRY_CATALOG_URL = "https://models.opencode.ai/api.json";
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MODELS_PER_REGISTRY_ACCOUNT = 400;

/**
 * Where an OpenCode sign-in keeps its credential. The free OpenCode-hosted
 * models need an OpenCode account credential rather than a third-party
 * provider key, so ACC reads the one the CLI already wrote instead of asking
 * the user to paste it again.
 */
function openCodeAuthPaths() {
  if (process.env.ACC_OPENCODE_AUTH) return [process.env.ACC_OPENCODE_AUTH];
  const home = os.homedir();
  const paths = [
    path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode", "auth.json"),
    path.join(home, ".config", "opencode", "auth.json"),
  ];
  if (process.env.APPDATA) paths.push(path.join(process.env.APPDATA, "opencode", "auth.json"));
  if (process.env.LOCALAPPDATA) paths.push(path.join(process.env.LOCALAPPDATA, "opencode", "auth.json"));
  return paths;
}

let credentialCache = { at: 0, value: null };

/** Force the next lookup to re-read the OpenCode credential from disk. */
export function invalidateCredentialCache() {
  credentialCache = { at: 0, value: null };
}

/**
 * Find an OpenCode credential: the environment first, then the file written by
 * `opencode auth login`. Returns `{ key, source }` or null.
 */
export function readOpenCodeCredential({ now = Date.now(), refresh = false } = {}) {
  if (!refresh && credentialCache.value && now - credentialCache.at < CREDENTIAL_CACHE_MS) {
    return credentialCache.value;
  }
  let value = null;
  if (process.env.OPENCODE_API_KEY) {
    value = { key: process.env.OPENCODE_API_KEY.trim(), source: "OPENCODE_API_KEY" };
  }
  if (!value) {
    for (const file of openCodeAuthPaths()) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        const entry = parsed?.opencode ?? parsed?.["opencode-zen"];
        const key = typeof entry === "string" ? entry : (entry?.key ?? entry?.access);
        if (typeof key === "string" && key.trim()) {
          value = { key: key.trim(), source: file };
          break;
        }
      } catch {
        /* missing or unreadable: try the next candidate */
      }
    }
  }
  credentialCache = { at: now, value };
  return value;
}

/** The key to use for a provider that can borrow the OpenCode sign-in. */
function resolveKey(config) {
  if (config.apiKey) return { key: config.apiKey, source: "panel" };
  if (config.useAccountCredential === false) return { key: "", source: null };
  const credential = readOpenCodeCredential();
  return credential ? { key: credential.key, source: credential.source } : { key: "", source: null };
}

/**
 * OpenCode's registry describes OpenAI-compatible providers by package name but
 * ships no base URL, so ACC carries the well-known ones and lets the user
 * override anything else in the panel.
 */
export const KNOWN_OPENAI_BASES = {
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  together: "https://api.together.xyz/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  novita: "https://api.novita.ai/openai/v1",
  sambanova: "https://api.sambanova.ai/v1",
  hyperbolic: "https://api.hyperbolic.xyz/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  nebius: "https://api.studio.nebius.com/v1",
  baseten: "https://inference.baseten.co/v1",
  scaleway: "https://api.scaleway.ai/v1",
  siliconflow: "https://api.siliconflow.com/v1",
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  llamacpp: "http://localhost:8080/v1",
};

/**
 * Model ids OpenCode Zen publishes. Used only to populate the picker before a
 * key is present; once a key is saved ACC refreshes from `GET {base}/models`.
 * The `free` suffix models are the ones Zen prices at zero.
 */
export const ZEN_BUILTIN_MODELS = [
  { id: "big-pickle", displayName: "Big Pickle", free: true },
  { id: "space-bunny-free", displayName: "Space Bunny (free)", free: true },
  { id: "longcat-2.5-preview-free", displayName: "LongCat 2.5 preview (free)", free: true },
  { id: "step-5-preview-free", displayName: "Step 5 preview (free)", free: true },
  { id: "exo-free", displayName: "Exo (free)", free: true },
  { id: "mimo-v2.6-flash-free", displayName: "MiMo 2.6 Flash (free)", free: true },
  { id: "mimo-v2.5-free", displayName: "MiMo 2.5 (free)", free: true },
  { id: "ling-3.1-flash-free", displayName: "Ling 3.1 Flash (free)", free: true },
  { id: "nemotron-3-ultra-free", displayName: "Nemotron 3 Ultra (free)", free: true },
  { id: "nemotron-3.5-lightning-free", displayName: "Nemotron 3.5 Lightning (free)", free: true },
  { id: "muse-spark-1.3-contributor-free", displayName: "Muse Spark 1.3 Contributor (free)", free: true },
  { id: "jev-1.13-free", displayName: "Jev 1.13 (free)", free: true },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
  { id: "claude-opus-5", displayName: "Claude Opus 5" },
  { id: "gpt-5.5", displayName: "GPT-5.5" },
  { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
  { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash" },
  { id: "grok-4.6", displayName: "Grok 4.6" },
  { id: "kimi-k3", displayName: "Kimi K3" },
  { id: "glm-5.2", displayName: "GLM-5.2" },
  { id: "qwen3.7-max", displayName: "Qwen3.7 Max" },
  { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
  { id: "minimax-m2.7", displayName: "MiniMax M2.7" },
];

/**
 * The models OpenCode hosts itself and prices at zero. These need no
 * third-party provider, only an OpenCode account credential.
 */
export const OPENCODE_BUILTIN_MODELS = ZEN_BUILTIN_MODELS.filter((row) => row.free);

/**
 * The model ids the Codebuff/Freebuff desktop agent itself routes to, read from
 * its bundled orchestrator. ACC exposes them as selectable names; actually
 * calling them needs the user's own Codebuff API key.
 */
export const CODEBUFF_BUILTIN_MODELS = [
  "anthropic/claude-opus-5.5",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-luna-pro",
  "openai/gpt-5.5",
  "openai/gpt-5.5-pro",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.1",
  "google/gemini-3.8-flash",
  "google/gemini-3.7-flash",
  "google/gemini-3.1-pro-preview",
  "google/gemini-2.5-pro",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k2.7-code",
  "minimax/minimax-m3",
  "z-ai/glm-5",
];

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, "")}${suffix}`;
}

/** Upstream Messages path: `/v1/messages` unless the base already ends in `/v1`. */
function anthropicMessagesUrl(base) {
  const trimmed = String(base).replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

function openAIChatUrl(base) {
  const trimmed = String(base).replace(/\/+$/, "");
  return trimmed.endsWith("/v1") || trimmed.endsWith("/api/v1")
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`;
}

function registryCachePath() {
  return path.join(os.homedir(), ".acc", "cache", "opencode-registry.json");
}

function readJsonCached(file) {
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > REGISTRY_CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonCache(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  } catch {
    /* a cache miss is never fatal */
  }
}

function upstreamError(status, text) {
  const snippet = String(text ?? "").slice(0, 500);
  const error = new Error(
    status === 401 || status === 403
      ? `Upstream rejected the credential (HTTP ${status}). Check the API key in the ACC panel.`
      : `Upstream returned HTTP ${status}: ${snippet}`
  );
  error.status = status === 401 || status === 403 ? 401 : 502;
  error.upstreamStatus = status;
  return error;
}

/** Turn a transport failure into something a user can act on. */
async function requestOrExplain(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const reason = error?.cause?.code ?? error?.code ?? error?.message ?? "unknown error";
    const hint =
      url.includes("localhost") || url.includes("127.0.0.1")
        ? " Is the local server running?"
        : " Check the base URL and your connection.";
    throw Object.assign(new Error(`Could not reach ${url}: ${reason}.${hint}`), { status: 502 });
  }
}

/** Shared request runner for OpenAI-compatible upstreams. */
async function runOpenAIChat({ fetchImpl, baseUrl, apiKey, headers = {}, model, body, signal }) {
  const response = await requestOrExplain(fetchImpl, openAIChatUrl(baseUrl), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    body: JSON.stringify(toOpenAIChatRequest(body, { model })),
  });
  if (!response.ok) throw upstreamError(response.status, await response.text());
  return response;
}

/**
 * Shared Anthropic Messages request runner. Both OpenCode providers use it,
 * because Zen already speaks Messages and a pass-through is the highest
 * fidelity path available.
 */
async function runAnthropicMessages({ fetchImpl, baseUrl, apiKey, model, body, forceNoThinking, signal }) {
  const payload = { ...body, model };
  if (forceNoThinking) delete payload.thinking;

  const response = await requestOrExplain(fetchImpl, anthropicMessagesUrl(baseUrl), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      ...(apiKey ? { "x-api-key": apiKey, authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw upstreamError(response.status, await response.text());

  if (!body.stream) return { stream: false, message: await response.json() };
  return {
    stream: true,
    frames: (async function* () {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
    })(),
  };
}

/** ---- OpenCode Zen ---------------------------------------------------- */

const zen = {
  id: "opencode-zen",
  label: "OpenCode Zen",
  transport: "anthropic",
  docsUrl: "https://opencode.ai/docs/zen/",
  keyUrl: "https://opencode.ai/auth",

  describe(config) {
    return {
      enabled: Boolean(config.enabled),
      ready: Boolean(config.enabled && config.apiKey),
      detail: config.apiKey
        ? "Key saved. Zen is used only for the models you pick."
        : "Off by default. Paste an OpenCode Zen API key to switch it on.",
    };
  },

  async listModels(config, ctx = {}) {
    // Zen never borrows the OpenCode sign-in: its key is its own.
    return listZenCompatibleModels(config, config.apiKey, {
      ...ctx,
      fallback: ZEN_BUILTIN_MODELS,
    });
  },

  async handle({ config, upstreamModel, body, forceNoThinking, signal, fetchImpl = fetch }) {
    return runAnthropicMessages({
      fetchImpl,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: upstreamModel,
      body,
      forceNoThinking,
      signal,
    });
  },
};

/** ---- OpenCode built-in models (free, via the OpenCode sign-in) -------- */

async function listZenCompatibleModels(
  config,
  key,
  { fetchImpl = fetch, fallback = OPENCODE_BUILTIN_MODELS } = {}
) {
  if (key) {
    try {
      const response = await requestOrExplain(
        fetchImpl,
        `${String(config.baseUrl).replace(/\/+$/, "")}/models`,
        { headers: { authorization: `Bearer ${key}`, "x-api-key": key } }
      );
      if (response.ok) {
        const payload = await response.json();
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        const models = rows
          .map((row) => ({
            id: row.id,
            displayName: row.name || row.id,
            contextWindow: row.context_length ?? row.limit?.context ?? null,
            maxOutput: row.max_output_tokens ?? row.limit?.output ?? null,
            supportsReasoning: row.reasoning ?? null,
          }))
          .filter((row) => Boolean(row.id));
        if (models.length) return { models, source: "live" };
      }
    } catch (error) {
      if (error.status === 401) throw error;
      /* otherwise fall back to the built-in catalog */
    }
  }
  return {
    models: fallback.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      free: Boolean(row.free),
    })),
    source: "builtin",
  };
}

const opencodeBuiltin = {
  id: "opencode-builtin",
  label: "OpenCode built-in models (free)",
  transport: "anthropic",
  docsUrl: "https://opencode.ai/docs/zen/",
  keyUrl: "https://opencode.ai/auth",

  describe(config) {
    const resolved = resolveKey(config);
    const enabled = Boolean(config.enabled);
    if (!enabled) {
      return {
        enabled,
        ready: false,
        detail: resolved.key
          ? "Off by default. Your OpenCode sign-in was found, so switching this on needs no key."
          : "Off by default. Run `opencode auth login`, or paste an OpenCode API key, to use the free models.",
      };
    }
    if (!resolved.key) {
      return {
        enabled,
        ready: false,
        detail: "Enabled, but no OpenCode credential was found. Run `opencode auth login` or paste a key.",
      };
    }
    return {
      enabled,
      ready: true,
      detail:
        resolved.source === "panel"
          ? "Using the OpenCode API key saved here. No third-party provider needed."
          : `Using the OpenCode credential from ${resolved.source}. No third-party provider needed.`,
    };
  },

  async listModels(config, ctx = {}) {
    return listZenCompatibleModels(config, resolveKey(config).key, ctx);
  },

  async handle({ config, upstreamModel, body, forceNoThinking, signal, fetchImpl = fetch }) {
    const { key } = resolveKey(config);
    if (!key) {
      throw Object.assign(
        new Error("No OpenCode credential. Run `opencode auth login` or paste a key in the ACC panel."),
        { status: 401 }
      );
    }
    return runAnthropicMessages({
      fetchImpl,
      baseUrl: config.baseUrl,
      apiKey: key,
      model: upstreamModel,
      body,
      forceNoThinking,
      signal,
    });
  },
};

/** ---- Ollama (local, no key) ------------------------------------------ */

const ollama = {
  id: "ollama",
  label: "Ollama (local)",
  transport: "openai-chat",
  docsUrl: "https://docs.ollama.com/api/openai-compatibility",

  describe(config) {
    const enabled = Boolean(config.enabled);
    return {
      enabled,
      ready: enabled,
      detail: enabled
        ? `Using the Ollama server at ${config.baseUrl}. Models are whatever you have pulled locally.`
        : `Off by default. Point this at your Ollama server (default ${OLLAMA_DEFAULT_BASE}); no API key needed.`,
    };
  },

  async listModels(config, { fetchImpl = fetch } = {}) {
    const base = String(config.baseUrl || OLLAMA_DEFAULT_BASE).replace(/\/+$/, "");
    // Ollama's native tag list is the source of truth for pulled models.
    try {
      const response = await requestOrExplain(fetchImpl, `${base}/api/tags`, {});
      if (response.ok) {
        const payload = await response.json();
        const models = (payload?.models ?? [])
          .map((row) => ({
            id: row.name ?? row.model,
            displayName: row.name ?? row.model,
            contextWindow: null,
            maxOutput: null,
          }))
          .filter((row) => Boolean(row.id));
        return { models, source: "live" };
      }
    } catch (error) {
      if (error.status === 502) throw error;
    }
    const response = await requestOrExplain(fetchImpl, `${base}/v1/models`, {});
    if (!response.ok) throw upstreamError(response.status, await response.text());
    const payload = await response.json();
    return {
      models: (payload?.data ?? [])
        .map((row) => ({
          id: row.id,
          displayName: row.id,
          contextWindow: row.context_length ?? null,
        }))
        .filter((row) => Boolean(row.id)),
      source: "live",
    };
  },

  async handle({ config, upstreamModel, body, signal, fetchImpl = fetch }) {
    const response = await runOpenAIChat({
      fetchImpl,
      baseUrl: config.baseUrl || OLLAMA_DEFAULT_BASE,
      apiKey: config.apiKey,
      model: upstreamModel,
      body,
      signal,
    });
    if (!body.stream) {
      return {
        stream: false,
        message: fromOpenAIChatResponse(await response.json(), { model: upstreamModel }),
      };
    }
    return { stream: true, frames: openAIStreamToAnthropic(response.body, { model: upstreamModel }) };
  },
};

/** ---- Codebuff / Freebuff (documented API key) ------------------------ */

const codebuff = {
  id: "codebuff",
  label: "Codebuff / Freebuff models",
  transport: "openai-chat",
  docsUrl: "https://www.codebuff.com/docs/advanced/sdk",
  keyUrl: "https://www.codebuff.com/api-keys",

  describe(config) {
    return {
      enabled: Boolean(config.enabled),
      ready: Boolean(config.enabled && config.apiKey),
      detail: config.apiKey
        ? "Using your own Codebuff API key (bring-your-own-key)."
        : "Needs your own Codebuff API key. Freebuff's included free tier cannot be proxied; see README.",
    };
  },

  async listModels() {
    return {
      models: CODEBUFF_BUILTIN_MODELS.map((id) => ({ id, displayName: id })),
      source: "builtin",
    };
  },

  async handle({ config, upstreamModel, body, signal, fetchImpl = fetch }) {
    const response = await runOpenAIChat({
      fetchImpl,
      baseUrl: `${String(config.baseUrl).replace(/\/+$/, "")}/api/v1`,
      apiKey: config.apiKey,
      model: upstreamModel,
      body,
      signal,
    });
    if (!body.stream) {
      return { stream: false, message: fromOpenAIChatResponse(await response.json(), { model: upstreamModel }) };
    }
    return {
      stream: true,
      frames: openAIStreamToAnthropic(response.body, { model: upstreamModel }),
    };
  },
};

/** ---- OpenCode built-in provider registry ---------------------------- */

const registry = {
  id: "opencode-registry",
  label: "OpenCode built-in providers",
  transport: "openai-chat",
  docsUrl: "https://opencode.ai/docs/providers/",

  describe(config) {
    const accounts = Object.values(config.accounts ?? {});
    const enabled = accounts.filter((account) => account?.enabled);
    return {
      enabled: Boolean(config.enabled),
      ready: enabled.length > 0,
      detail: enabled.length
        ? `${enabled.length} provider account(s) enabled.`
        : "Off by default. Enable individual OpenCode providers with your own keys.",
    };
  },

  async catalog({ fetchImpl = fetch } = {}) {
    const cacheFile = registryCachePath();
    const cached = readJsonCached(cacheFile);
    if (cached) return cached;
    const response = await fetchImpl(REGISTRY_CATALOG_URL);
    if (!response.ok) throw new Error(`Registry catalog HTTP ${response.status}`);
    const payload = await response.json();
    const providers = Object.entries(payload).map(([id, entry]) => ({
      id,
      name: entry?.name ?? id,
      env: entry?.env ?? [],
      doc: entry?.doc ?? null,
      modelCount: Object.keys(entry?.models ?? {}).length,
      baseUrl: KNOWN_OPENAI_BASES[id] ?? null,
    }));
    providers.sort((a, b) => a.id.localeCompare(b.id));
    writeJsonCache(cacheFile, providers);
    return providers;
  },

  async listModels(config, ctx = {}) {
    const accounts = Object.entries(config.accounts ?? {}).filter(([, value]) => value?.enabled);
    if (!accounts.length) return { models: [], source: "builtin" };
    const response = await (ctx.fetchImpl ?? fetch)(config.baseUrl ?? REGISTRY_CATALOG_URL);
    if (!response.ok) throw new Error(`Registry catalog HTTP ${response.status}`);
    const payload = await response.json();

    const models = [];
    for (const [providerId, account] of accounts) {
      const entry = payload[providerId];
      if (!entry?.models) continue;
      let count = 0;
      for (const [modelId, info] of Object.entries(entry.models)) {
        if (count++ >= MAX_MODELS_PER_REGISTRY_ACCOUNT) break;
        if (info?.status === "deprecated") continue;
        models.push({
          id: `${providerId}/${modelId}`,
          displayName: `${entry.name ?? providerId}: ${info?.name ?? modelId}`,
          contextWindow: info?.limit?.context ?? null,
          maxOutput: info?.limit?.output ?? null,
          supportsReasoning: info?.reasoning ?? null,
        });
      }
    }
    return { models, source: "live" };
  },

  async handle({ config, upstreamModel, body, signal, fetchImpl = fetch }) {
    const separator = String(upstreamModel).indexOf("/");
    if (separator <= 0) {
      const error = new Error(
        `Registry model ids look like "<provider>/<model>" (got "${upstreamModel}").`
      );
      error.status = 400;
      throw error;
    }
    const providerId = upstreamModel.slice(0, separator);
    const modelId = upstreamModel.slice(separator + 1);
    const account = config.accounts?.[providerId];
    if (!account?.enabled) {
      const error = new Error(`OpenCode provider "${providerId}" is not enabled in the ACC panel.`);
      error.status = 400;
      throw error;
    }
    const baseUrl = account.baseUrl || KNOWN_OPENAI_BASES[providerId];
    if (!baseUrl) {
      const error = new Error(
        `No base URL is known for OpenCode provider "${providerId}". Add one in the ACC panel.`
      );
      error.status = 400;
      throw error;
    }
    const response = await runOpenAIChat({
      fetchImpl,
      baseUrl,
      apiKey: account.apiKey,
      model: modelId,
      body,
      signal,
    });
    if (!body.stream) {
      return { stream: false, message: fromOpenAIChatResponse(await response.json(), { model: modelId }) };
    }
    return { stream: true, frames: openAIStreamToAnthropic(response.body, { model: modelId }) };
  },
};

export const ADAPTERS = {
  [zen.id]: zen,
  [opencodeBuiltin.id]: opencodeBuiltin,
  [ollama.id]: ollama,
  [codebuff.id]: codebuff,
  [registry.id]: registry,
};

export function getAdapter(providerId) {
  return ADAPTERS[providerId] ?? null;
}

export { joinUrl };
