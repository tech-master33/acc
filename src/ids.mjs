/**
 * Model-id encoding for the two Claude surfaces ACC serves.
 *
 * Both Claude Code and Claude Desktop discover models from `GET /v1/models`
 * and then echo the advertised id back in `/v1/messages`. The ids therefore
 * have to be reversible, and they have to satisfy two client-side quirks:
 *
 *  - Claude Code treats any id containing `claude-3-` as "no thinking", so the
 *    no-thinking variant of a Claude Code id smuggles that substring in.
 *  - Claude Desktop rewrites/parses ids itself, so ids there are hex so that a
 *    `provider/model` ref survives verbatim.
 *
 * The prefixes are ACC-specific (`claude-acc`, `claude-3-acc`) so ACC ids never
 * collide with Free Claude Code's ids when both proxies are installed.
 */

export const CLAUDE_MODEL_PREFIX = "anthropic";
export const CLAUDE_NO_THINKING_PREFIX = "claude-3-acc-no-thinking";
export const DESKTOP_MODEL_PREFIX = "claude-acc";
export const DESKTOP_NO_THINKING_PREFIX = "claude-3-acc";

const DESKTOP_PREFIXES = new Set([DESKTOP_MODEL_PREFIX, DESKTOP_NO_THINKING_PREFIX]);

/** `provider/model` -> Claude Code-discoverable id. */
export function claudeModelId(ref, { noThinking = false } = {}) {
  const prefix = noThinking ? CLAUDE_NO_THINKING_PREFIX : CLAUDE_MODEL_PREFIX;
  return `${prefix}/${ref}`;
}

/** `provider/model` -> Claude Desktop-discoverable id. */
export function desktopModelId(ref, { noThinking = false } = {}) {
  const prefix = noThinking ? DESKTOP_NO_THINKING_PREFIX : DESKTOP_MODEL_PREFIX;
  return `${prefix}/${Buffer.from(ref, "utf8").toString("hex")}`;
}

/** The id to advertise for one model in one view. */
export function modelIdForView(ref, view, { noThinking = false } = {}) {
  return view === "claude-desktop"
    ? desktopModelId(ref, { noThinking })
    : claudeModelId(ref, { noThinking });
}

/**
 * Decode an id advertised by ACC (or a bare `provider/model` ref).
 * Returns null when the id is not one of ours, so callers can apply their
 * default-model fallback (for example a plain `claude-sonnet-4-...` request).
 */
export function decodeModelId(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name) return null;

  const separator = name.indexOf("/");
  if (separator === -1) return null;
  const prefix = name.slice(0, separator);
  const rest = name.slice(separator + 1);

  if (DESKTOP_PREFIXES.has(prefix)) {
    if (!rest) throw new Error("Invalid ACC desktop model id");
    const hex = rest.toLowerCase();
    if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error("Invalid ACC desktop model id");
    }
    const decoded = Buffer.from(hex, "hex").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("hex") !== hex) {
      throw new Error("Invalid ACC desktop model id");
    }
    const ref = splitRef(decoded);
    if (!ref) throw new Error("Invalid ACC desktop model id");
    return { ...ref, forceNoThinking: prefix === DESKTOP_NO_THINKING_PREFIX };
  }

  const forceNoThinking = prefix === CLAUDE_NO_THINKING_PREFIX;
  if (!forceNoThinking && prefix !== CLAUDE_MODEL_PREFIX) return null;
  const ref = splitRef(rest);
  if (!ref) return null;
  return { ...ref, forceNoThinking };
}

/** Split a `provider/model` ref, allowing the model part to contain slashes. */
export function splitRef(value) {
  if (typeof value !== "string") return null;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    providerId: value.slice(0, separator),
    upstreamModel: value.slice(separator + 1),
  };
}

export function modelRef(providerId, upstreamModel) {
  return `${providerId}/${upstreamModel}`;
}
