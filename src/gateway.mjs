/**
 * Connection state for the two Claude surfaces, and "ACC is the only gateway".
 *
 * The panel shows one control per client whose meaning depends on the real
 * state of the config files, so connecting and disconnecting can never both
 * look available. Exclusive mode moves the other third-party Desktop profiles
 * aside (recording them first) so they can be restored exactly.
 */

import fs from "node:fs";
import path from "node:path";

import {
  ACC_DESKTOP_ID,
  DEFAULT_DESKTOP_ID,
  claudeCodeSettingsPath,
  connectClaudeCode,
  connectClaudeDesktop,
  desktopPaths,
  disconnectClaudeCode,
  disconnectClaudeDesktop,
  gatewayUrl,
  readJsonFile,
  writeJsonFile,
} from "./connect.mjs";

const DISABLED_SUFFIX = ".acc-disabled";

/** Compare two gateway URLs, treating localhost and 127.0.0.1 as the same. */
export function sameGatewayUrl(left, right) {
  const normalize = (value) => {
    try {
      const url = new URL(String(value));
      const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      return `${url.protocol}//${host}:${port}`;
    } catch {
      return null;
    }
  };
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

export function claudeCodeStatus(config) {
  const file = claudeCodeSettingsPath();
  const target = gatewayUrl(config);
  let settings;
  try {
    settings = readJsonFile(file);
  } catch (error) {
    return { connected: false, path: file, baseUrl: null, detail: error.message };
  }
  const baseUrl = settings?.env?.ANTHROPIC_BASE_URL ?? null;
  const token = settings?.env?.ANTHROPIC_AUTH_TOKEN ?? null;
  const pointsHere = Boolean(baseUrl && sameGatewayUrl(baseUrl, target));
  const connected = pointsHere && token === config.authToken;
  return {
    connected,
    path: file,
    baseUrl,
    detail: connected
      ? `Connected to ${target}.`
      : baseUrl
        ? `Currently points at ${baseUrl}${pointsHere ? " with a different token" : ""}.`
        : "Not configured yet.",
  };
}

export function desktopStatus() {
  const paths = desktopPaths();
  let meta;
  let mode;
  try {
    meta = readJsonFile(paths.meta);
    mode = readJsonFile(paths.settings);
  } catch (error) {
    return { connected: false, path: paths.profile, appliedId: null, detail: error.message };
  }
  const appliedId = typeof meta?.appliedId === "string" ? meta.appliedId : null;
  const connected =
    appliedId === ACC_DESKTOP_ID &&
    mode?.deploymentMode === "3p" &&
    fs.existsSync(paths.profile);
  return {
    connected,
    path: paths.profile,
    appliedId,
    detail: connected
      ? "Desktop is using the ACC profile."
      : appliedId
        ? "Desktop is using a different profile (for example Free Claude Code's)."
        : "Desktop has no third-party profile selected.",
  };
}

export function clientStatuses(config) {
  return { claudeCode: claudeCodeStatus(config), claudeDesktop: desktopStatus() };
}

/**
 * One control per client: connect when disconnected, disconnect when connected.
 */
export function toggleClient(config, target) {
  if (target === "claude-code") {
    const status = claudeCodeStatus(config);
    if (status.connected) {
      const result = disconnectClaudeCode();
      return { target, connected: false, message: result.message, path: result.path };
    }
    const result = connectClaudeCode(config);
    return { target, connected: true, message: result.message, path: result.path };
  }
  if (target === "claude-desktop") {
    const status = desktopStatus();
    if (status.connected) {
      const result = disconnectClaudeDesktop();
      return { target, connected: false, message: result.message, path: result.path };
    }
    const result = connectClaudeDesktop(config);
    return { target, connected: true, message: result.message, path: result.path };
  }
  throw Object.assign(new Error(`Unknown target: ${target}`), { status: 400 });
}

export function gatewayStatus(config) {
  return {
    exclusive: Boolean(config.exclusiveGateway?.active),
    movedProfiles: config.exclusiveGateway?.movedProfiles ?? [],
    library: desktopPaths().library,
  };
}

/**
 * Move every other third-party Desktop profile aside and point both clients at
 * ACC. Reversible through `restoreGateways`.
 */
export function makeOnlyGateway(config) {
  const paths = desktopPaths();
  // ACC has to be the applied profile before anything else is moved aside.
  connectClaudeDesktop(config);

  const meta = readJsonFile(paths.meta);
  const entries = Array.isArray(meta?.entries) ? [...meta.entries] : [];
  const kept = entries.filter(
    (entry) => entry?.id === ACC_DESKTOP_ID || entry?.id === DEFAULT_DESKTOP_ID
  );

  const movedProfiles = [];
  for (const entry of entries) {
    if (!entry?.id || entry.id === ACC_DESKTOP_ID || entry.id === DEFAULT_DESKTOP_ID) continue;
    const file = path.join(paths.library, `${entry.id}.json`);
    const disabled = `${file}${DISABLED_SUFFIX}`;
    if (fs.existsSync(file)) fs.renameSync(file, disabled);
    if (fs.existsSync(disabled)) {
      movedProfiles.push({
        id: entry.id,
        name: entry.name ?? entry.id,
        file,
        disabled,
      });
    }
  }

  if (!kept.some((entry) => entry?.id === DEFAULT_DESKTOP_ID)) {
    writeJsonFile(paths.defaultProfile, {});
    kept.push({ id: DEFAULT_DESKTOP_ID, name: "Default" });
  }
  const mode = readJsonFile(paths.settings);
  delete mode.hybridPointer;
  writeJsonFile(paths.meta, { ...meta, entries: kept, appliedId: ACC_DESKTOP_ID });
  writeJsonFile(paths.settings, { ...mode, deploymentMode: "3p" });

  config.exclusiveGateway = { active: true, movedProfiles };
  const claudeCode = connectClaudeCode(config);

  return {
    active: true,
    movedProfiles,
    claudeCode: claudeCode.path,
    message: movedProfiles.length
      ? `ACC is now the only gateway. Set aside: ${movedProfiles.map((item) => item.name).join(", ")}.`
      : "ACC is now the only gateway. Nothing else was installed to set aside.",
  };
}

/** Put back every profile that `makeOnlyGateway` moved aside. */
export function restoreGateways(config) {
  const paths = desktopPaths();
  const moved = config.exclusiveGateway?.movedProfiles ?? [];
  const meta = readJsonFile(paths.meta);
  const entries = Array.isArray(meta?.entries) ? [...meta.entries] : [];
  const restored = [];

  for (const record of moved) {
    if (fs.existsSync(record.disabled)) {
      fs.renameSync(record.disabled, record.file);
      restored.push(record.name);
    }
    if (!entries.some((entry) => entry?.id === record.id)) {
      entries.push({ id: record.id, name: record.name });
    }
  }
  writeJsonFile(paths.meta, { ...meta, entries });
  config.exclusiveGateway = { active: false, movedProfiles: [] };

  return {
    active: false,
    restored,
    message: restored.length
      ? `Restored: ${restored.join(", ")}. They are selectable in Claude Desktop again; ACC stays the applied profile until you disconnect it.`
      : "Nothing needed restoring. ACC stays the applied Desktop profile until you disconnect it.",
  };
}
