/**
 * ACC configuration.
 *
 * Everything lives in one JSON file (default `~/.acc/config.json`) so the
 * control panel and the CLI agree on a single source of truth. Secrets are
 * whatever the user pastes into the panel; the file is written 0600.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_VERSION = 1;
export const DEFAULT_PORT = 8788;

/** Providers ACC knows about. Everything except a chosen default is off. */
export const PROVIDER_DEFAULTS = {
  "opencode-zen": {
    label: "OpenCode Zen",
    // Deliberately disabled: the user turns this on from the control panel.
    enabled: false,
    apiKey: "",
    baseUrl: "https://opencode.ai/zen/v1",
    transport: "anthropic",
    models: [],
    modelsFetchedAt: null,
  },
  "opencode-builtin": {
    label: "OpenCode built-in models (free)",
    // The free OpenCode-hosted models. Needs an OpenCode account credential,
    // not a third-party provider key; ACC finds that credential on its own.
    enabled: false,
    apiKey: "",
    baseUrl: "https://opencode.ai/zen/v1",
    transport: "anthropic",
    useAccountCredential: true,
    models: [],
    modelsFetchedAt: null,
  },
  ollama: {
    label: "Ollama (local)",
    enabled: false,
    apiKey: "",
    baseUrl: "http://localhost:11434",
    transport: "openai-chat",
    models: [],
    modelsFetchedAt: null,
  },
  codebuff: {
    label: "Codebuff / Freebuff models",
    enabled: false,
    apiKey: "",
    baseUrl: "https://www.codebuff.com",
    transport: "openai-chat",
    models: [],
    modelsFetchedAt: null,
  },
  "opencode-registry": {
    // Distinct from "OpenCode built-in models (free)" above, which is the
    // zero-priced hosted set rather than this third-party provider directory.
    label: "OpenCode provider registry",
    enabled: false,
    baseUrl: "https://models.opencode.ai/api.json",
    transport: "openai-chat",
    catalogFetchedAt: null,
    // provider-id -> { enabled, apiKey, baseUrl }
    accounts: {},
  },
};

export function configPath() {
  return process.env.ACC_CONFIG_PATH || path.join(os.homedir(), ".acc", "config.json");
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    /** Token Claude clients send; ACC rejects /v1 requests without it. */
    authToken: "acc",
    /**
     * Claude's own models are hidden while ACC is the only source of models.
     * Flipping this off re-adds the Anthropic ids to the advertised catalog.
     */
    hideClaudeModels: true,
    /** Model used when a client asks for a model ACC does not serve. */
    defaultModel: "",
    /** Start ACC automatically when the user signs in. */
    runAtBoot: false,
    /**
     * Set when the user makes ACC the only gateway: the other Claude Desktop
     * third-party profiles are moved aside so their records can be restored.
     */
    exclusiveGateway: { active: false, movedProfiles: [] },
    providers: structuredClone(PROVIDER_DEFAULTS),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/** Merge a stored config over the defaults so new keys appear automatically. */
export function normalizeConfig(stored) {
  const merged = deepMerge(defaultConfig(), stored);
  merged.version = CONFIG_VERSION;
  if (!Array.isArray(merged.exclusiveGateway?.movedProfiles)) {
    merged.exclusiveGateway = { active: false, movedProfiles: [] };
  }
  merged.runAtBoot = Boolean(merged.runAtBoot);
  merged.providers = {};
  for (const [id, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    merged.providers[id] = deepMerge(structuredClone(defaults), (stored?.providers ?? {})[id]);
  }
  for (const [id, extra] of Object.entries(stored?.providers ?? {})) {
    if (!(id in merged.providers)) merged.providers[id] = extra;
  }
  return merged;
}

export function loadConfig() {
  const file = configPath();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read ${file}: ${error.message}`);
    }
  }
  return normalizeConfig(stored);
}

export function saveConfig(config) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** Shallow provider patch, used by the control panel. */
export function updateProvider(config, providerId, patch) {
  const current = config.providers[providerId];
  if (!current) throw new Error(`Unknown provider: ${providerId}`);
  config.providers[providerId] = { ...current, ...patch };
  return config;
}
