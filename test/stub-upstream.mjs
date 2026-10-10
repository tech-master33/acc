/**
 * A stub model upstream used by the ACC tests.
 *
 * It speaks both shapes ACC talks to, so no real provider or API key is needed
 * to verify request translation, streaming and error handling:
 *
 *   POST /api/v1/chat/completions, POST /v1/chat/completions  (OpenAI)
 *   POST /v1/messages                                          (Anthropic)
 *   GET  /v1/models  and  GET /models
 *   GET  /registry.json                                        (OpenCode catalog)
 */

import http from "node:http";

const ANTHROPIC_REPLY =
  "Hello from the stub Anthropic upstream. " +
  "This reply exists only so the proxy can be tested without a provider key.";

/**
 * @param keys            credentials the stub accepts
 * @param allowAnonymous  whether a missing credential is allowed, so a keyless
 *                        local provider (Ollama) and a keyed one can both be
 *                        exercised. A *wrong* credential is always refused.
 */
export function startStubUpstream({
  keys = ["test-key", "opencode-account-key"],
  allowAnonymous = true,
} = {}) {
  const accepted = new Set(keys);
  const rejected = (value) => {
    if (!value) return !allowAnonymous;
    return !accepted.has(value);
  };
  const seen = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ method: request.method, path: url.pathname, body, headers: request.headers });

    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "stub-small", name: "Stub Small", context_length: 8000 },
            { id: "stub-large", name: "Stub Large", context_length: 200000 },
          ],
        })
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b", size: 2019393189 }] })
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/registry.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          stubprovider: {
            id: "stubprovider",
            name: "Stub Provider",
            env: ["STUB_API_KEY"],
            doc: "https://example.invalid",
            models: {
              "stub-model": {
                id: "stub-model",
                name: "Stub Model",
                reasoning: false,
                limit: { context: 32000, output: 4096 },
              },
            },
          },
        })
      );
      return;
    }

    if (request.method === "POST" && url.pathname.endsWith("/v1/messages")) {
      const apiKey = request.headers["x-api-key"];
      if (rejected(typeof apiKey === "string" ? apiKey : "")) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { message: "bad key" } }));
        return;
      }
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frames = [
          { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", content: [], model: body.model, usage: { input_tokens: 5, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ];
        for (const frame of frames) {
          response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
        }
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: ANTHROPIC_REPLY }],
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 11 },
        })
      );
      return;
    }

    if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      const authorization = request.headers.authorization ?? "";
      const bearer = authorization.replace(/^Bearer\s+/i, "");
      if (rejected(authorization ? bearer : "")) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunks = [
          { choices: [{ delta: { content: "Hello" } }] },
          { choices: [{ delta: { content: " from" } }] },
          { choices: [{ delta: { content: " OpenAI" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3 } },
        ];
        for (const chunk of chunks) {
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "Hello from the stub OpenAI upstream." },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 6 },
        })
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `no stub route for ${url.pathname}` } }));
  });

  return {
    seen,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      return { port, origin: `http://127.0.0.1:${port}` };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
