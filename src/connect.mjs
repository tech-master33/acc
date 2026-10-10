/**
 * Wiring ACC into the two Claude surfaces by writing their config files.
 *
 * Claude Code is easy: it honours `ANTHROPIC_BASE_URL` plus a credential, and
 * reads them from `~/.claude/settings.json`.
 *
 * Claude Desktop is different on purpose: it ignores `ANTHROPIC_BASE_URL` and
 * instead reads a named profile from its third-party-inference "library" under
 * `Claude-3p/configLibrary`, with `deploymentMode: "3p"` selected. ACC writes
 * its own entry there and leaves any other entry (for example Free Claude
 * Code's) untouched.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ACC_NAMESPACE = "https://github.com/tech-master33/acc/integrations/claude-desktop";
const ACC_ENTRY_NAME = "ACC";
const VIEW_HEADER = "X-ACC-Model-View";

/** The env keys ACC owns; disconnect removes exactly these. */
const CLAUDE_CODE_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
];

export function gatewayUrl(config) {
  return `http://${config.host}:${config.port}`;
}

/** Deterministic UUIDv5 so reconnecting never orphans an old profile. */
export function uuidv5(namespace, name) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(nsBytes).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export const ACC_DESKTOP_ID = uuidv5(ACC_NAMESPACE, "acc");
export const DEFAULT_DESKTOP_ID = uuidv5(ACC_NAMESPACE, "acc/default");

/* ---------------------------------------------------------------- Claude Code */

export function claudeCodeSettingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

export function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    if (!text.trim()) return {};
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Could not parse ${file}: ${error.message}`);
  }
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.acc-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) {
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function connectClaudeCode(config) {
  const file = claudeCodeSettingsPath();
  const settings = readJsonFile(file);
  const env = { ...(settings.env ?? {}) };
  env.ANTHROPIC_BASE_URL = gatewayUrl(config);
  env.ANTHROPIC_AUTH_TOKEN = config.authToken;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  if (config.defaultModel) env.ANTHROPIC_MODEL = config.defaultModel;
  settings.env = env;
  if (config.defaultModel) settings.model = config.defaultModel;
  writeJsonFile(file, settings);
  return {
    message: `Claude Code now points at ${gatewayUrl(config)}. Restart any running session.`,
    path: file,
  };
}

export function disconnectClaudeCode() {
  const file = claudeCodeSettingsPath();
  if (!fs.existsSync(file)) return { message: "Claude Code was not connected.", path: file };
  const settings = readJsonFile(file);
  if (settings.env) {
    for (const key of CLAUDE_CODE_KEYS) delete settings.env[key];
    if (!Object.keys(settings.env).length) delete settings.env;
  }
  if (typeof settings.model === "string" && settings.model.startsWith("anthropic/")) {
    delete settings.model;
  }
  writeJsonFile(file, settings);
  return { message: "Removed ACC's Claude Code settings.", path: file };
}

/* -------------------------------------------------------------- Claude Desktop */

export function desktopRoot() {
  if (process.env.ACC_CLAUDE_DESKTOP_ROOT) return process.env.ACC_CLAUDE_DESKTOP_ROOT;
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Claude-3p");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude-3p");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude-3p");
}

export function desktopPaths(root = desktopRoot()) {
  const library = path.join(root, "configLibrary");
  return {
    root,
    library,
    meta: path.join(library, "_meta.json"),
    profile: path.join(library, `${ACC_DESKTOP_ID}.json`),
    defaultProfile: path.join(library, `${DEFAULT_DESKTOP_ID}.json`),
    settings: path.join(root, "claude_desktop_config.json"),
  };
}

function desktopProfileValues(config) {
  const url = gatewayUrl(config);
  if (!config.authToken) throw new Error("Desktop needs a non-empty ACC auth token.");
  return {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: url,
    inferenceCredentialKind: "static",
    inferenceGatewayApiKey: config.authToken,
    inferenceGatewayAuthScheme: "bearer",
    modelDiscoveryEnabled: true,
    inferenceCustomHeaders: { [VIEW_HEADER]: "claude-desktop" },
  };
}

export function connectClaudeDesktop(config, root = desktopRoot()) {
  const paths = desktopPaths(root);
  if (process.platform === "win32" && !fs.existsSync(paths.root)) {
    const legacy = path.join(process.env.APPDATA || "", "Claude-3p");
    if (legacy && fs.existsSync(legacy)) {
      throw new Error(
        `Claude Desktop has not migrated its data yet (found ${legacy}). Open Desktop once, then retry.`
      );
    }
  }

  const meta = readJsonFile(paths.meta);
  const entries = Array.isArray(meta.entries) ? [...meta.entries] : [];

  if (!entries.length) {
    writeJsonFile(paths.defaultProfile, {});
    entries.push({ id: DEFAULT_DESKTOP_ID, name: "Default" });
  }
  writeJsonFile(paths.profile, desktopProfileValues(config));
  if (!entries.some((entry) => entry?.id === ACC_DESKTOP_ID)) {
    entries.push({ id: ACC_DESKTOP_ID, name: ACC_ENTRY_NAME });
  }
  writeJsonFile(paths.meta, { ...meta, entries, appliedId: ACC_DESKTOP_ID });

  const settings = readJsonFile(paths.settings);
  delete settings.hybridPointer;
  writeJsonFile(paths.settings, { ...settings, deploymentMode: "3p" });

  return {
    message:
      "Claude Desktop is set to the ACC gateway. Quit and reopen Desktop so it picks up the new profile.",
    path: paths.profile,
    paths,
  };
}

export function disconnectClaudeDesktop(root = desktopRoot()) {
  const paths = desktopPaths(root);
  if (!fs.existsSync(paths.meta)) {
    return { message: "Claude Desktop was not connected.", path: paths.meta, paths };
  }
  const meta = readJsonFile(paths.meta);
  const entries = Array.isArray(meta.entries) ? [...meta.entries] : [];
  const appliedId = meta.appliedId === ACC_DESKTOP_ID ? DEFAULT_DESKTOP_ID : meta.appliedId;

  if (appliedId === DEFAULT_DESKTOP_ID && !fs.existsSync(paths.defaultProfile)) {
    writeJsonFile(paths.defaultProfile, {});
  }
  if (!entries.some((entry) => entry?.id === DEFAULT_DESKTOP_ID)) {
    entries.push({ id: DEFAULT_DESKTOP_ID, name: "Default" });
  }
  const remaining = entries.filter((entry) => entry?.id !== ACC_DESKTOP_ID);
  writeJsonFile(paths.meta, { ...meta, entries: remaining, appliedId });
  try {
    fs.rmSync(paths.profile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (appliedId === DEFAULT_DESKTOP_ID) {
    const settings = readJsonFile(paths.settings);
    writeJsonFile(paths.settings, { ...settings, deploymentMode: "1p" });
  }
  return {
    message: "Removed ACC's Claude Desktop profile.",
    path: paths.meta,
    paths,
  };
}
