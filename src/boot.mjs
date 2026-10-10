/**
 * Start-on-login ("run at boot") management.
 *
 * Each platform gets its native mechanism rather than an inventive one:
 *
 *   Windows — a launcher in the user's Startup folder, run through a hidden
 *             VBScript wrapper so no console window appears at sign-in.
 *   macOS   — a LaunchAgent with `RunAtLoad`.
 *   Linux   — an XDG autostart .desktop entry.
 *
 * Everything is user-scoped: no elevation, and disabling removes exactly the
 * file that was created.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_NAME = "ACC";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function appRoot() {
  return APP_ROOT;
}

/** The node binary and entry point to relaunch, quoted for a shell. */
function command() {
  return { node: process.execPath, script: path.join(APP_ROOT, "bin", "acc.mjs") };
}

function configDir() {
  return path.join(os.homedir(), ".acc");
}

/** Path of the long-lived launcher, independent of the install location. */
export function startScriptPath() {
  return process.platform === "win32"
    ? path.join(configDir(), "start.cmd")
    : path.join(configDir(), "start.sh");
}

function bootEntryPath() {
  if (process.env.ACC_BOOT_ENTRY) return process.env.ACC_BOOT_ENTRY;
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${ENTRY_NAME}.vbs`);
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "LaunchAgents", "dev.acc.gateway.plist");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart", "acc.desktop");
}

function writeFile(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, mode ? { mode } : undefined);
  return file;
}

/**
 * Regenerate the platform launcher plus the boot entry.
 * Returns `{ enabled: true, entry, launcher }`.
 */
export function enableBoot() {
  const { node, script } = command();
  const entry = bootEntryPath();

  if (process.platform === "win32") {
    const launcher = startScriptPath();
    writeFile(launcher, `@echo off\r\n"${node}" "${script}" serve\r\n`, 0o600);
    // A VBScript in Startup runs without opening a console window.
    writeFile(
      entry,
      [
        "' Created by ACC. Removing this file turns start-on-login off.",
        'Set shell = CreateObject("WScript.Shell")',
        `shell.Run """${node}"" ""${script}"" serve", 0, False`,
        "",
      ].join("\r\n")
    );
    return { enabled: true, entry, launcher };
  }

  if (process.platform === "darwin") {
    const launcher = startScriptPath();
    writeFile(launcher, `#!/bin/sh\nexec "${node}" "${script}" serve\n`, 0o700);
    writeFile(
      entry,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.acc.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
`
    );
    return { enabled: true, entry, launcher };
  }

  const launcher = startScriptPath();
  writeFile(launcher, `#!/bin/sh\nexec "${node}" "${script}" serve\n`, 0o700);
  writeFile(
    entry,
    `[Desktop Entry]
Type=Application
Name=ACC gateway
Comment=Local Anthropic-compatible model gateway
Exec="${launcher}"
Terminal=false
X-GNOME-Autostart-enabled=true
`
  );
  return { enabled: true, entry, launcher };
}

/** Remove the boot entry (and the launcher). Safe to call when absent. */
export function disableBoot() {
  const entry = bootEntryPath();
  let removed = false;
  try {
    fs.rmSync(entry);
    removed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    fs.rmSync(startScriptPath());
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { enabled: false, entry, removed };
}

export function bootStatus() {
  const entry = bootEntryPath();
  return {
    enabled: fs.existsSync(entry),
    entry,
    launcher: startScriptPath(),
    supported: true,
  };
}

/** Apply the desired state; returns the resulting status. */
export function applyBoot(enabled) {
  if (enabled) enableBoot();
  else disableBoot();
  return bootStatus();
}
