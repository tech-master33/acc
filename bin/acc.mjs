#!/usr/bin/env node
/**
 * ACC command line.
 *
 *   acc serve                 start the proxy + control panel
 *   acc models [--view …]     print the catalog the clients would see
 *   acc connect <target>      wire Claude Code or Claude Desktop
 *   acc disconnect <target>   undo that wiring
 *   acc status                show what is enabled right now
 */

import fs from "node:fs";

import { applyBoot, bootStatus } from "../src/boot.mjs";
import { collectModels, encodeCatalog } from "../src/catalog.mjs";
import { configPath, loadConfig, saveConfig } from "../src/config.mjs";
import { claudeCodeSettingsPath, desktopPaths, gatewayUrl } from "../src/connect.mjs";
import {
  clientStatuses,
  gatewayStatus,
  makeOnlyGateway,
  restoreGateways,
  toggleClient,
} from "../src/gateway.mjs";
import { ADAPTERS } from "../src/providers.mjs";
import { createServer } from "../src/server.mjs";

const HELP = `ACC — one local Anthropic-compatible proxy for the models you bring.

Usage:
  acc serve [--port <n>] [--host <addr>]   Start the proxy and the control panel.
  acc models [--view claude|claude-desktop]
                                           Print the model catalog for a view.
  acc connect <claude-code|claude-desktop> Toggle a Claude client: connects when
                                           disconnected, disconnects when connected.
                                           Add --on or --off to force one direction.
  acc boot <on|off|status>                 Start ACC automatically at sign-in.
  acc gateway <only|restore|status>        Make ACC the only gateway, or undo it.
  acc status                               Show providers, clients, models and paths.
  acc --help

Configuration lives in ${configPath()} and is edited most easily in the control
panel, which is served at ${gatewayUrl(loadConfig())} while \`acc serve\` runs.`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      if (inline !== undefined) flags[key] = inline;
      else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags[key] = argv[++index];
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function serve(flags) {
  // Materialize the defaults on first run so there is a file to inspect and a
  // stable token for the clients to be pointed at.
  if (!fs.existsSync(configPath())) saveConfig(loadConfig());

  const { server, getConfig } = createServer({
    onConfigChange: (config) =>
      process.stdout.write(`ACC: configuration saved for port ${config.port}.\n`),
  });
  const config = getConfig();
  const port = flags.port ? Number(flags.port) : config.port;
  const host = flags.host ? String(flags.host) : config.host;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(
        `${host}:${port} is already in use, so ACC is probably already running.\n` +
          "Open the panel, or start a second copy with: acc serve --port <other>\n"
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const address = server.address();
  process.stdout.write(
    [
      `ACC is listening on http://${host}:${address.port}`,
      `Anthropic endpoint: http://${host}:${address.port}/v1/messages`,
      `Control panel:      http://${host}:${address.port}/`,
      `Config file:        ${configPath()}`,
      "",
      "Point a client at it with:  acc connect claude-code",
      "",
    ].join("\n")
  );

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function models(flags) {
  const config = loadConfig();
  const { models: list, errors } = await collectModels(config, { refresh: true });
  const view = flags.view === "claude-desktop" ? "claude-desktop" : "claude";
  const encoded = encodeCatalog(
    { models: list, hideClaudeModels: config.hideClaudeModels, defaultModelRef: config.defaultModel },
    view
  );
  process.stdout.write(`View: ${view} (${encoded.data.length} ids)\n`);
  for (const model of encoded.data) process.stdout.write(`  ${model.id}\n`);
  for (const [id, message] of Object.entries(errors)) {
    process.stdout.write(`  ! ${id}: ${message}\n`);
  }
  if (!list.length) {
    process.stdout.write(
      "\nNo provider is enabled. Run `acc serve`, open the control panel, and enable one.\n"
    );
  }
}

async function status() {
  const config = loadConfig();
  const clients = clientStatuses(config);
  const gateway = gatewayStatus(config);
  process.stdout.write(`Gateway:  ${gatewayUrl(config)}\n`);
  process.stdout.write(`Config:   ${configPath()}\n`);
  process.stdout.write(`Claude Code settings:   ${claudeCodeSettingsPath()}\n`);
  process.stdout.write(`Claude Desktop profile: ${desktopPaths().profile}\n`);
  process.stdout.write(
    `Hide Claude models: ${config.hideClaudeModels ? "yes" : "no"}\n`
  );
  process.stdout.write(`Fallback model: ${config.defaultModel || "(first available)"}\n`);
  process.stdout.write(
    `Start at sign-in: ${bootStatus().enabled ? "on" : "off"} (${bootStatus().entry})\n`
  );
  process.stdout.write(
    `Exclusive gateway: ${gateway.exclusive ? `on (set aside: ${gateway.movedProfiles.map((p) => p.name).join(", ") || "nothing"})` : "off"}\n`
  );
  process.stdout.write(`\nClients:\n`);
  process.stdout.write(
    `  Claude Code:    ${clients.claudeCode.connected ? "connected" : "not connected"} — ${clients.claudeCode.detail}\n`
  );
  process.stdout.write(
    `  Claude Desktop: ${clients.claudeDesktop.connected ? "connected" : "not connected"} — ${clients.claudeDesktop.detail}\n\n`
  );
  const { models: list, errors } = await collectModels(config, { refresh: true });
  for (const adapter of Object.values(ADAPTERS)) {
    const providerConfig = config.providers?.[adapter.id] ?? {};
    const described = adapter.describe(providerConfig);
    const count = list.filter((model) => model.providerId === adapter.id).length;
    process.stdout.write(
      `${adapter.label}: ${described.enabled ? (described.ready ? "enabled" : "enabled, needs setup") : "disabled"} — ${count} model(s)\n`
    );
    if (errors[adapter.id]) process.stdout.write(`  ! ${errors[adapter.id]}\n`);
  }
  process.stdout.write(`\nAdvertised models:\n`);
  for (const model of list) process.stdout.write(`  ${model.ref}\n`);
}

/**
 * `--on`/`--off` force a direction; with neither, the client is toggled, so
 * the command can never ask to connect something already connected.
 */
async function connect(target, flags = {}) {
  const config = loadConfig();
  if (!["claude-code", "claude-desktop"].includes(target)) {
    process.stderr.write(`Unknown target "${target}". Use claude-code or claude-desktop.\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const clients = clientStatuses(config);
    const connected =
      target === "claude-code" ? clients.claudeCode.connected : clients.claudeDesktop.connected;
    const forced = flags.on ? true : flags.off ? false : null;
    if (forced !== null && forced === connected) {
      process.stdout.write(`Already ${connected ? "connected" : "disconnected"}. Nothing to do.\n`);
      return;
    }
    const result = toggleClient(config, target);
    process.stdout.write(`${result.message}\n`);
    if (result.path) process.stdout.write(`Wrote: ${result.path}\n`);
  } catch (error) {
    process.stderr.write(`Failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

async function boot(action) {
  const config = loadConfig();
  try {
    if (action === "status" || action === undefined) {
      const status = bootStatus();
      process.stdout.write(
        `Start ACC at sign-in: ${status.enabled ? "on" : "off"}\nEntry: ${status.entry}\n`
      );
      return;
    }
    if (!["on", "off"].includes(action)) {
      process.stderr.write("Use: acc boot on|off|status\n");
      process.exitCode = 1;
      return;
    }
    const status = applyBoot(action === "on");
    saveConfig({ ...config, runAtBoot: status.enabled });
    process.stdout.write(
      status.enabled
        ? `ACC will start when you sign in.\nEntry: ${status.entry}\n`
        : `ACC will no longer start automatically.\n`
    );
  } catch (error) {
    process.stderr.write(`Failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

async function gateway(action) {
  const config = loadConfig();
  try {
    if (action === undefined || action === "status") {
      const status = gatewayStatus(config);
      process.stdout.write(
        `Exclusive gateway: ${status.exclusive ? "on" : "off"}\n` +
          `Set aside: ${status.movedProfiles.map((item) => item.name).join(", ") || "nothing"}\n` +
          `Library: ${status.library}\n`
      );
      return;
    }
    if (action === "only") {
      const result = makeOnlyGateway(config);
      saveConfig(config);
      process.stdout.write(`${result.message}\n`);
      return;
    }
    if (action === "restore") {
      const result = restoreGateways(config);
      saveConfig(config);
      process.stdout.write(`${result.message}\n`);
      return;
    }
    process.stderr.write("Use: acc gateway only|restore|status\n");
    process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const { flags, positional } = parseArgs(process.argv.slice(2));
// `--help` is parsed as a flag, not a positional, so it has to be picked up here.
const command = flags.help || flags.h ? "help" : (positional[0] ?? "serve");

switch (command) {
  case "serve":
    await serve(flags);
    break;
  case "models":
    await models(flags);
    break;
  case "status":
    await status();
    break;
  case "connect":
    await connect(positional[1], { on: flags.on === true, off: flags.off === true });
    break;
  case "disconnect":
    await connect(positional[1], { off: true });
    break;
  case "boot":
    await boot(positional[1]);
    break;
  case "gateway":
    await gateway(positional[1]);
    break;
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(`${HELP}\n`);
    break;
  default:
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}\n`);
    process.exitCode = 1;
}
