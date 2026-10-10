/**
 * Anthropic Messages <-> OpenAI Chat Completions translation plus SSE framing.
 *
 * ACC's clients only ever speak Anthropic Messages. Upstreams come in two
 * shapes:
 *
 *  - `anthropic`   — the upstream already speaks Messages (OpenCode Zen exposes
 *                    `/v1/messages`), so ACC streams it through untouched.
 *  - `openai-chat` — the upstream speaks `POST /chat/completions`, so requests
 *                    and responses are converted here.
 */

const STOP_REASON_MAP = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

export function anthropicError(status, type, message) {
  return { status, body: { type: "error", error: { type, message } } };
}

/** Rough token estimate; only used for `/count_tokens`, never for billing. */
export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.max(1, Math.ceil(text.length / 4));
}

export function textFromAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "thinking") return block.thinking ?? "";
      return "";
    })
    .join("");
}

function toolResultText(block) {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((part) => (part?.type === "text" ? part.text ?? "" : JSON.stringify(part)))
      .join("\n");
  }
  return JSON.stringify(block.content ?? "");
}

function userContentToOpenAI(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");

  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push({ type: "text", text: block });
    } else if (block?.type === "text") {
      parts.push({ type: "text", text: block.text ?? "" });
    } else if (block?.type === "image" && block.source?.type === "base64") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      });
    } else if (block?.type === "image" && block.source?.type === "url") {
      parts.push({ type: "image_url", image_url: { url: block.source.url } });
    }
  }
  // Collapse to a plain string when there is nothing but text, which every
  // OpenAI-compatible upstream accepts.
  if (parts.length && parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("\n");
  }
  return parts.length ? parts : "";
}

/**
 * Convert an Anthropic Messages request body into an OpenAI Chat Completions
 * request. `model` is the upstream model id, not the ACC id.
 */
export function toOpenAIChatRequest(body, { model, defaultMaxTokens = 8192 } = {}) {
  const messages = [];

  const systemText = textFromAnthropicContent(body.system ?? "");
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const message of body.messages ?? []) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;

    if (role === "assistant") {
      const text = textFromAnthropicContent(content);
      const toolCalls = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          }
        }
      }
      const out = { role, content: text || null };
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
      continue;
    }

    // Anthropic delivers tool results as user blocks; OpenAI wants one
    // `role: "tool"` message per result ahead of any user text.
    const results = Array.isArray(content)
      ? content.filter((block) => block?.type === "tool_result")
      : [];
    const rest = Array.isArray(content)
      ? content.filter((block) => block?.type !== "tool_result")
      : content;

    for (const block of results) {
      messages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: toolResultText(block),
      });
    }
    const converted = userContentToOpenAI(rest);
    if (converted !== "" && !(Array.isArray(converted) && converted.length === 0)) {
      messages.push({ role: "user", content: converted });
    }
  }

  const request = {
    model,
    messages,
    max_tokens: body.max_tokens ?? defaultMaxTokens,
    stream: Boolean(body.stream),
  };
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;

  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }));
    const choice = body.tool_choice;
    if (choice?.type === "tool" && choice.name) {
      request.tool_choice = { type: "function", function: { name: choice.name } };
    } else if (choice?.type === "any") {
      request.tool_choice = "required";
    } else if (choice?.type === "auto") {
      request.tool_choice = "auto";
    } else if (choice?.type === "none") {
      request.tool_choice = "none";
    }
  }

  if (request.stream) request.stream_options = { include_usage: true };
  return request;
}

/** Convert a non-streaming OpenAI chat completion into an Anthropic message. */
export function fromOpenAIChatResponse(payload, { model }) {
  const choice = payload?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];
  if (message.reasoning_content) {
    content.push({ type: "thinking", thinking: message.reasoning_content, signature: "" });
  }
  const text = textFromAnthropicContent(
    typeof message.content === "string" ? message.content : (message.content ?? "")
  );
  if (text) content.push({ type: "text", text });
  for (const call of message.tool_calls ?? []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {
      input = { raw: call.function?.arguments ?? "" };
    }
    content.push({
      type: "tool_use",
      id: call.id ?? `toolu_${Date.now()}`,
      name: call.function?.name ?? "unknown",
      input,
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });

  return {
    id: payload?.id ?? `msg_acc_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: STOP_REASON_MAP[choice.finish_reason] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: payload?.usage?.prompt_tokens ?? 0,
      output_tokens: payload?.usage?.completion_tokens ?? 0,
    },
  };
}

/** Minimal SSE helper for the server's own responses. */
export function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Translate an OpenAI Chat Completions SSE stream into Anthropic Messages
 * events. Yields SSE frames ready to write to the client.
 */
export async function* openAIStreamToAnthropic(stream, { model, fallbackId }) {
  const messageId = fallbackId ?? `msg_acc_${Date.now()}`;
  let started = false;
  let textBlockOpen = false;
  let textIndex = -1;
  let nextIndex = 0;
  let finished = false;
  const toolBlocks = new Map();
  let usage = { input_tokens: 0, output_tokens: 0 };
  let finishReason = "end_turn";
  let buffer = "";

  const decoder = new TextDecoder();
  const reader = stream.getReader();

  const startMessage = function* () {
    started = true;
    yield sse("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const closeText = function* () {
    if (!textBlockOpen) return;
    textBlockOpen = false;
    yield sse("content_block_stop", { type: "content_block_stop", index: textIndex });
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        let chunk;
        try {
          chunk = JSON.parse(raw);
        } catch {
          continue;
        }
        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
            output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (!started) yield* startMessage();

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          if (textBlockOpen) yield* closeText();
          const index = nextIndex++;
          yield sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "" },
          });
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: delta.reasoning_content },
          });
          yield sse("content_block_stop", { type: "content_block_stop", index });
        }

        if (typeof delta.content === "string" && delta.content) {
          if (!textBlockOpen) {
            textIndex = nextIndex++;
            textBlockOpen = true;
            yield sse("content_block_start", {
              type: "content_block_start",
              index: textIndex,
              content_block: { type: "text", text: "" },
            });
          }
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index: textIndex,
            delta: { type: "text_delta", text: delta.content },
          });
        }

        for (const call of delta.tool_calls ?? []) {
          const slot = call.index ?? 0;
          let block = toolBlocks.get(slot);
          if (!block) {
            if (textBlockOpen) yield* closeText();
            block = {
              index: nextIndex++,
              id: call.id ?? `toolu_acc_${slot}_${Date.now()}`,
              name: call.function?.name ?? "",
              started: false,
            };
            toolBlocks.set(slot, block);
          }
          if (call.id) block.id = call.id;
          if (call.function?.name) block.name = call.function.name;
          if (!block.started) {
            block.started = true;
            yield sse("content_block_start", {
              type: "content_block_start",
              index: block.index,
              content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            });
          }
          if (call.function?.arguments) {
            yield sse("content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: call.function.arguments },
            });
          }
        }

        if (choice.finish_reason) {
          finishReason = STOP_REASON_MAP[choice.finish_reason] ?? "end_turn";
        }
      }
    }

    if (!started) yield* startMessage();
    yield* closeText();
    for (const block of toolBlocks.values()) {
      if (block.started) {
        yield sse("content_block_stop", { type: "content_block_stop", index: block.index });
      }
    }
    yield sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: finishReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    yield sse("message_stop", { type: "message_stop" });
    finished = true;
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        /* the client already went away */
      }
    }
  }
}
