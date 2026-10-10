/**
 * ACC test suite. No network access and no provider keys are required: a stub
 * upstream stands in for both upstream shapes.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fromOpenAIChatResponse, openAIStreamToAnthropic, toOpenAIChatRequest } from "../src/anthropic.mjs";
import { applyBoot, bootStatus } from "../src/boot.mjs";
import { collectModels, encodeCatalog, invalidateCatalog } from "../src/catalog.mjs";
import { loadConfig } from "../src/config.mjs";
import { claudeModelId, decodeModelId, desktopModelId } from "../src/ids.mjs";
import { createServer } from "../src/server.mjs";
import {
  ACC_DESKTOP_ID,
  connectClaudeCode,
  connectClaudeDesktop,
  desktopPaths,
  disconnectClaudeCode,
  disconnectClaudeDesktop,
  uuidv5,
} from "../src/connect.mjs";
import {
  clientStatuses,
  gatewayStatus,
  makeOnlyGateway,
  restoreGateways,
  sameGatewayUrl,
  toggleClient,
} from "../src/gateway.mjs";
import { readOpenCodeCredential } from "../src/providers.mjs";
import { startStubUpstream } from "./stub-upstream.mjs";

const TOKEN = "test-token";
const results = [];
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "acc.mjs");
const cliVersion = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

function runCli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    results.push({ name, ok: false, error });
    process.stdout.write(`FAIL ${name}\n     ${error.message}\n`);
  }
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `acc-${label}-`));
}

async function postJson(pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return response.json();
}

async function readSse(response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()));
}

/* ------------------------------------------------------------------ unit tests */

await test("model ids round-trip for both views", () => {
  const ref = "opencode-zen/big-pickle";
  const claude = claudeModelId(ref);
  assert.equal(claude, "anthropic/opencode-zen/big-pickle");
  assert.deepEqual(decodeModelId(claude), {
    providerId: "opencode-zen",
    upstreamModel: "big-pickle",
    forceNoThinking: false,
  });

  const desktop = desktopModelId(ref);
  const decoded = decodeModelId(desktop);
  assert.equal(decoded.providerId, "opencode-zen");
  assert.equal(decoded.upstreamModel, "big-pickle");
  assert.equal(decoded.forceNoThinking, false);

  const noThinking = decodeModelId(claudeModelId(ref, { noThinking: true }));
  assert.equal(noThinking.forceNoThinking, true);

  // Plain Anthropic ids are not ours, so the fallback path handles them.
  assert.equal(decodeModelId("claude-sonnet-4-20250514"), null);
  assert.throws(() => decodeModelId("claude-acc/not-hex"));
});

await test("Anthropic request becomes an OpenAI chat request", () => {
  const request = toOpenAIChatRequest(
    {
      system: "be brief",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "toolu_1", name: "read", input: { file: "a.txt" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "data" }] },
      ],
      tools: [{ name: "read", description: "read a file", input_schema: { type: "object" } }],
      max_tokens: 256,
      stream: true,
    },
    { model: "stub-model" }
  );

  assert.equal(request.model, "stub-model");
  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages[2].tool_calls[0].function.name, "read");
  assert.equal(request.messages[3].role, "tool");
  assert.equal(request.messages[3].tool_call_id, "toolu_1");
  assert.equal(request.tools[0].function.name, "read");
  assert.equal(request.max_tokens, 256);
  assert.equal(request.stream, true);
});

await test("OpenAI response becomes an Anthropic message", () => {
  const message = fromOpenAIChatResponse(
    {
      id: "chatcmpl-1",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "thinking out loud",
            tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"file":"a.txt"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    },
    { model: "stub-model" }
  );
  assert.equal(message.type, "message");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content[1].input, { file: "a.txt" });
  assert.equal(message.usage.output_tokens, 4);
});

await test("OpenAI SSE becomes Anthropic SSE", async () => {
  const frames = [
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });

  const out = [];
  for await (const chunk of openAIStreamToAnthropic(stream, { model: "stub-model" })) {
    const line = chunk.split("\n").find((value) => value.startsWith("event:"));
    if (line) out.push(line.slice(7).trim());
  }
  assert.deepEqual(out, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
});

/* ---------------------------------------------------------- integration tests */

const stub = startStubUpstream();
const { port: stubPort, origin: stubOrigin } = await stub.listen();

const root = tempDir("home");
process.env.ACC_CONFIG_PATH = path.join(root, "config.json");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
process.env.ACC_CLAUDE_DESKTOP_ROOT = path.join(root, "Claude-3p");
// Never touch the real Startup folder or the real OpenCode sign-in.
process.env.ACC_BOOT_ENTRY = path.join(root, "boot-entry.vbs");
const openCodeAuthPath = path.join(root, "opencode-auth.json");
process.env.ACC_OPENCODE_AUTH = openCodeAuthPath;
fs.writeFileSync(
  openCodeAuthPath,
  JSON.stringify({ opencode: { type: "api", key: "opencode-account-key" } })
);

fs.mkdirSync(path.dirname(process.env.ACC_CONFIG_PATH), { recursive: true });
fs.writeFileSync(
  process.env.ACC_CONFIG_PATH,
  JSON.stringify({
    host: "127.0.0.1",
    port: 0,
    authToken: TOKEN,
    hideClaudeModels: true,
    defaultModel: "codebuff/stub-fallback",
    providers: {
      "opencode-zen": { enabled: true, apiKey: "test-key", baseUrl: `${stubOrigin}/v1` },
      "opencode-builtin": { enabled: true, apiKey: "", baseUrl: `${stubOrigin}/v1` },
      ollama: { enabled: true, apiKey: "", baseUrl: stubOrigin },
      codebuff: { enabled: true, apiKey: "test-key", baseUrl: stubOrigin },
      "opencode-registry": {
        enabled: true,
        baseUrl: `${stubOrigin}/registry.json`,
        accounts: { stubprovider: { enabled: true, apiKey: "test-key", baseUrl: stubOrigin } },
      },
    },
  })
);

const { server } = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

await test("/v1/models requires the ACC token", async () => {
  const response = await fetch(`${base}/v1/models`);
  assert.equal(response.status, 401);
});

await test("/v1/models hides Claude ids and lists provider models", async () => {
  const response = await fetch(`${base}/v1/models`, { headers: { "x-api-key": TOKEN } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  const ids = payload.data.map((model) => model.id);
  // Zen has a key, so its live `/models` list wins over the built-in catalog.
  assert.ok(ids.includes("anthropic/opencode-zen/stub-small"), "zen live model advertised");
  assert.ok(
    ids.some((id) => id.includes("opencode-zen/stub-large")),
    "second zen model advertised"
  );
  assert.ok(ids.includes("anthropic/codebuff/anthropic/claude-opus-5.5"), "codebuff model advertised");
  assert.ok(
    ids.includes("anthropic/opencode-registry/stubprovider/stub-model"),
    "registry model advertised"
  );
  assert.ok(!ids.some((id) => /claude-(sonnet|opus)-4-/.test(id)), "Claude ids hidden");
  assert.ok(!ids.some((id) => id.startsWith("claude-3-5")), "Claude 3.5 ids hidden");
});

await test("Zen streams through the Anthropic passthrough", async () => {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/opencode-zen/big-pickle",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"text_delta","text":"Hello"/);
  assert.match(text, /event: message_stop/);
  const upstream = stub.seen.at(-1);
  assert.equal(upstream.headers["x-api-key"], "test-key");
  assert.equal(upstream.body.model, "big-pickle");
});

await test("Zen non-streaming passthrough returns an Anthropic message", async () => {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/opencode-zen/big-pickle",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.type, "message");
  assert.equal(payload.content[0].type, "text");
});

await test("An OpenAI upstream is translated for a streaming client", async () => {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/codebuff/openai/gpt-5.5",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 200);
  const events = await readSse(response);
  const types = events.map((event) => event.type ?? event.constructor?.name);
  assert.ok(types.includes("message_start"), "message_start present");
  const text = events
    .map((event) => event.delta?.text ?? "")
    .join("");
  assert.equal(text, "Hello from OpenAI");
  assert.ok(types.includes("message_stop"), "message_stop present");
  const upstream = stub.seen.at(-1);
  assert.equal(upstream.path, "/api/v1/chat/completions");
  assert.equal(upstream.body.model, "openai/gpt-5.5");
  assert.equal(upstream.body.stream, true);
});

await test("An OpenAI upstream is translated for a non-streaming client", async () => {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/codebuff/openai/gpt-5.5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const payload = await response.json();
  assert.equal(payload.content[0].text, "Hello from the stub OpenAI upstream.");
  assert.equal(payload.stop_reason, "end_turn");
});

await test("registry models route to their provider base URL", async () => {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/opencode-registry/stubprovider/stub-model",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const payload = await response.json();
  assert.equal(payload.content[0].text, "Hello from the stub OpenAI upstream.");
  assert.equal(stub.seen.at(-1).body.model, "stub-model");
});

await test("Claude Desktop ids are accepted in /v1/messages", async () => {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-acc-model-view": "claude-desktop", "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: desktopModelId("codebuff/openai/gpt-5.5"),
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(stub.seen.at(-1).body.model, "openai/gpt-5.5");
});

await test("an unknown Claude model falls back to the configured default model", async () => {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 200);
  const upstream = stub.seen.at(-1);
  // The panel stores the fallback as a bare `provider/model` ref.
  assert.equal(upstream.body.model, "stub-fallback");
});

await test("a request with no usable model is rejected with a helpful 400", async () => {
  const configure = (defaultModel) =>
    fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultModel }),
    });
  await configure("");
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "hi" }] }),
  });
  const payload = await response.json();
  await configure("codebuff/stub-fallback");

  assert.equal(response.status, 400);
  assert.match(payload.error.message, /ACC panel/i);
});

await test("the desktop view advertises desktop-shaped ids", async () => {
  const response = await fetch(`${base}/v1/models`, {
    headers: { "x-api-key": TOKEN, "x-acc-model-view": "claude-desktop" },
  });
  const payload = await response.json();
  assert.ok(payload.data.some((model) => model.id.startsWith("claude-acc/")));
  assert.ok(payload.default_model_id.startsWith("claude-acc/"));
});

await test("a rejected upstream credential surfaces as 401 with an Anthropic error body", async () => {
  const configure = (apiKey) =>
    fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers: { codebuff: { apiKey } } }),
    });

  await configure("wrong-key");
  const rejected = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/codebuff/openai/gpt-5.5",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(rejected.status, 401);
  const payload = await rejected.json();
  assert.equal(payload.type, "error");
  assert.match(payload.error.message, /credential/i);

  await configure("test-key");
  const accepted = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/codebuff/openai/gpt-5.5",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(accepted.status, 200);
});

await test("control panel state reports providers, clients, boot and gateway", async () => {
  const response = await fetch(`${base}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.port, 0);
  assert.deepEqual(
    state.adapters.map((adapter) => adapter.id).sort(),
    ["codebuff", "ollama", "opencode-builtin", "opencode-registry", "opencode-zen"]
  );
  assert.equal(state.adapters.find((a) => a.id === "opencode-zen").enabled, true);
  // Ollama takes no key, so the panel must not offer a key field for it.
  assert.equal(state.adapters.find((a) => a.id === "ollama").hasKeyInput, false);
  assert.ok(state.models.length >= 3);
  assert.ok(state.paths.claudeCode.endsWith("settings.json"));
  assert.equal(typeof state.clients.claudeCode.connected, "boolean");
  assert.equal(typeof state.clients.claudeDesktop.connected, "boolean");
  assert.equal(state.boot.enabled, false);
  assert.equal(state.gateway.exclusive, false);
});

await test("disabling a provider removes its models from the catalog", async () => {
  const patch = await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: { "opencode-zen": { enabled: false } } }),
  });
  assert.equal(patch.status, 200);
  invalidateCatalog();
  const response = await fetch(`${base}/v1/models`, { headers: { "x-api-key": TOKEN } });
  const payload = await response.json();
  assert.ok(!payload.data.some((model) => model.id.includes("opencode-zen")));
  // put it back for the remaining tests
  await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: { "opencode-zen": { enabled: true } } }),
  });
});

await test("hiding Claude models can be switched off", async () => {
  await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hideClaudeModels: false }),
  });
  invalidateCatalog();
  const response = await fetch(`${base}/v1/models`, { headers: { "x-api-key": TOKEN } });
  const payload = await response.json();
  assert.ok(payload.data.some((model) => model.id === "claude-fable-5"));
  await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hideClaudeModels: true }),
  });
});

/* ------------------------------------------------------------ wiring tests */

await test("uuidv5 is deterministic and version 5", () => {
  const first = uuidv5("1b4e28ba-2fa1-11d2-883f-0016d3cca427", "acc");
  const second = uuidv5("1b4e28ba-2fa1-11d2-883f-0016d3cca427", "acc");
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

await test("connecting Claude Code writes the gateway env block", () => {
  const config = { host: "127.0.0.1", port: 8788, authToken: TOKEN, defaultModel: "opencode-zen/big-pickle" };
  connectClaudeCode(config);
  const settings = JSON.parse(fs.readFileSync(path.join(root, "claude", "settings.json"), "utf8"));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8788");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, TOKEN);
  assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(settings.model, "opencode-zen/big-pickle");

  disconnectClaudeCode();
  const after = JSON.parse(fs.readFileSync(path.join(root, "claude", "settings.json"), "utf8"));
  assert.equal(after.env, undefined);
});

await test("connecting Claude Desktop writes an ACC library entry", () => {
  const config = { host: "127.0.0.1", port: 8788, authToken: TOKEN };
  const result = connectClaudeDesktop(config);
  const profile = JSON.parse(fs.readFileSync(result.path, "utf8"));
  assert.equal(profile.inferenceProvider, "gateway");
  assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:8788");
  assert.equal(profile.inferenceGatewayApiKey, TOKEN);
  assert.equal(profile.inferenceGatewayAuthScheme, "bearer");
  assert.equal(profile.modelDiscoveryEnabled, true);
  assert.equal(profile.inferenceCustomHeaders["X-ACC-Model-View"], "claude-desktop");

  const meta = JSON.parse(fs.readFileSync(path.join(root, "Claude-3p", "configLibrary", "_meta.json"), "utf8"));
  assert.equal(meta.appliedId, ACC_DESKTOP_ID);
  assert.ok(meta.entries.some((entry) => entry.id === ACC_DESKTOP_ID && entry.name === "ACC"));
  const mode = JSON.parse(fs.readFileSync(path.join(root, "Claude-3p", "claude_desktop_config.json"), "utf8"));
  assert.equal(mode.deploymentMode, "3p");

  disconnectClaudeDesktop();
  const afterMeta = JSON.parse(fs.readFileSync(path.join(root, "Claude-3p", "configLibrary", "_meta.json"), "utf8"));
  assert.notEqual(afterMeta.appliedId, ACC_DESKTOP_ID);
  assert.ok(!afterMeta.entries.some((entry) => entry.id === ACC_DESKTOP_ID));
  assert.ok(!fs.existsSync(result.path));
});

await test("connecting Claude Desktop preserves another vendor's entry", () => {
  const libraryDir = path.join(root, "Claude-3p", "configLibrary");
  const metaPath = path.join(libraryDir, "_meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.entries.push({ id: "dfa3d5c4-9f50-5e40-8aac-a12c8c32a0e0", name: "FCC" });
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  connectClaudeDesktop({ host: "127.0.0.1", port: 8788, authToken: TOKEN });
  const after = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert.ok(after.entries.some((entry) => entry.name === "FCC"), "FCC entry untouched");
});

/* ------------------------------------------- startup, gateway and the new providers */

await test("sameGatewayUrl treats localhost and 127.0.0.1 as one gateway", () => {
  assert.equal(sameGatewayUrl("http://127.0.0.1:8788", "http://localhost:8788/"), true);
  assert.equal(sameGatewayUrl("http://127.0.0.1:8788", "http://127.0.0.1:8082"), false);
  assert.equal(sameGatewayUrl("not a url", "http://127.0.0.1:8788"), false);
});

await test("the OpenCode sign-in credential is discovered automatically", () => {
  const credential = readOpenCodeCredential({ refresh: true });
  assert.ok(credential, "a credential was found");
  assert.equal(credential.key, "opencode-account-key");
  assert.equal(credential.source, openCodeAuthPath);
});

await test("OpenCode built-in models work with no third-party provider key", async () => {
  const response = await fetch(`${base}/v1/models`, { headers: { "x-api-key": TOKEN } });
  const payload = await response.json();
  assert.ok(
    payload.data.some((model) => model.id.startsWith("anthropic/opencode-builtin/")),
    "built-in models are advertised"
  );

  const call = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/opencode-builtin/stub-small",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(call.status, 200);
  const upstream = stub.seen.at(-1);
  assert.equal(upstream.headers["x-api-key"], "opencode-account-key");
  assert.equal(upstream.body.model, "stub-small");
});

await test("Ollama models come from the local tag list and keep their tag", async () => {
  const response = await fetch(`${base}/v1/models`, { headers: { "x-api-key": TOKEN } });
  const payload = await response.json();
  assert.ok(
    payload.data.some((model) => model.id === "anthropic/ollama/llama3.2:3b"),
    "local model advertised with its tag intact"
  );

  const call = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/ollama/llama3.2:3b",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const message = await call.json();
  assert.equal(message.content[0].text, "Hello from the stub OpenAI upstream.");
  const upstream = stub.seen.at(-1);
  assert.equal(upstream.body.model, "llama3.2:3b");
  assert.equal(upstream.path, "/v1/chat/completions");
});

await test("an unreachable local provider explains itself instead of hanging", async () => {
  await postJson("/api/config", { providers: { ollama: { baseUrl: "http://127.0.0.1:9" } } });
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/ollama/llama3.2:3b",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const payload = await response.json();
  await postJson("/api/config", { providers: { ollama: { baseUrl: stubOrigin } } });
  assert.equal(response.status, 502);
  assert.match(payload.error.message, /Could not reach/);
  assert.match(payload.error.message, /local server running/i);
});

await test("acc --version prints the version instead of starting a server", () => {
  const output = execFileSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" });
  assert.equal(output.trim(), cliVersion);
});

await test("an unknown flag is refused, it does not fall through to starting the server", () => {
  const result = runCli("--definitely-not-a-command");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command "--definitely-not-a-command"/);
  // Usage goes to stderr on the error path so it never pollutes piped output.
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stdout + result.stderr, /already in use/);
});

await test("acc --help still prints usage", () => {
  const result = runCli("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

await test("start-at-sign-in writes one entry and removing it cleans up", () => {
  assert.equal(bootStatus().enabled, false);
  assert.equal(applyBoot(true).enabled, true);
  assert.ok(fs.existsSync(process.env.ACC_BOOT_ENTRY));
  assert.match(fs.readFileSync(process.env.ACC_BOOT_ENTRY, "utf8"), /acc\.mjs/);
  assert.equal(applyBoot(false).enabled, false);
  assert.ok(!fs.existsSync(process.env.ACC_BOOT_ENTRY));
});

await test("the panel startup control toggles the entry", async () => {
  const on = await postJson("/api/boot", {});
  assert.equal(on.runAtBoot, true);
  assert.ok(fs.existsSync(process.env.ACC_BOOT_ENTRY));
  const off = await postJson("/api/boot", {});
  assert.equal(off.runAtBoot, false);
  assert.ok(!fs.existsSync(process.env.ACC_BOOT_ENTRY));
});

await test("one control per client: it connects, then disconnects", async () => {
  const config = loadConfig();
  if (clientStatuses(config).claudeCode.connected) toggleClient(config, "claude-code");

  const first = await postJson("/api/connect", { target: "claude-code" });
  assert.equal(first.changed, true);
  assert.equal(first.state.claudeCode.connected, true);

  const second = await postJson("/api/connect", { target: "claude-code" });
  assert.equal(second.changed, true);
  assert.equal(second.state.claudeCode.connected, false);

  const forced = await postJson("/api/connect", { target: "claude-code", action: "connect" });
  assert.equal(forced.state.claudeCode.connected, true);

  // An explicit connect must not re-connect something already connected.
  const redundant = await postJson("/api/connect", { target: "claude-code", action: "connect" });
  assert.equal(redundant.changed, false);
  assert.match(redundant.message, /Already connected/);
});

await test("exclusive mode sets other gateways aside and restores them", () => {
  const config = loadConfig();
  const paths = desktopPaths();
  const otherId = "dfa3d5c4-9f50-5e40-8aac-a12c8c32a0e0";
  const otherProfile = path.join(paths.library, `${otherId}.json`);
  fs.mkdirSync(paths.library, { recursive: true });
  fs.writeFileSync(
    otherProfile,
    JSON.stringify({ inferenceProvider: "gateway", inferenceGatewayBaseUrl: "http://127.0.0.1:8082" })
  );
  const meta = JSON.parse(fs.readFileSync(paths.meta, "utf8"));
  if (!meta.entries.some((entry) => entry.id === otherId)) {
    meta.entries.push({ id: otherId, name: "FCC" });
  }
  fs.writeFileSync(paths.meta, JSON.stringify(meta));

  const only = makeOnlyGateway(config);
  assert.equal(gatewayStatus(config).exclusive, true);
  assert.ok(only.movedProfiles.some((item) => item.name === "FCC"));
  assert.equal(fs.existsSync(otherProfile), false, "other profile moved aside");
  assert.equal(fs.existsSync(`${otherProfile}.acc-disabled`), true, "and kept, not deleted");
  const afterMeta = JSON.parse(fs.readFileSync(paths.meta, "utf8"));
  assert.equal(afterMeta.appliedId, ACC_DESKTOP_ID);
  assert.ok(!afterMeta.entries.some((entry) => entry.id === otherId));
  assert.equal(clientStatuses(config).claudeDesktop.connected, true);

  const back = restoreGateways(config);
  assert.equal(gatewayStatus(config).exclusive, false);
  assert.ok(back.restored.includes("FCC"));
  assert.equal(fs.existsSync(otherProfile), true, "other profile restored");
  assert.ok(
    JSON.parse(fs.readFileSync(paths.meta, "utf8")).entries.some((entry) => entry.id === otherId),
    "and listed again"
  );
});

await test("the panel gateway control toggles exclusive mode", async () => {
  const on = await postJson("/api/gateway", {});
  assert.equal(on.active, true);
  const off = await postJson("/api/gateway", {});
  assert.equal(off.active, false);
});

/* ------------------------------------------------------------------ teardown */

await test("catalog collection reports provider errors instead of throwing", async () => {
  const broken = {
    providers: {
      "opencode-registry": {
        enabled: true,
        baseUrl: "http://127.0.0.1:1/registry.json",
        accounts: { gone: { enabled: true, apiKey: "x", baseUrl: "http://127.0.0.1:1" } },
      },
    },
    providersEnabled: true,
  };
  invalidateCatalog();
  const { models, errors } = await collectModels(broken, { refresh: true });
  assert.ok(Array.isArray(models));
  assert.ok(errors["opencode-registry"], "error recorded for the broken provider");
});

await new Promise((resolve) => server.close(resolve));
await stub.close();
fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) {
  for (const result of failed) {
    process.stdout.write(`\n${result.name}\n${result.error?.stack ?? result.error}\n`);
  }
  process.exitCode = 1;
}
