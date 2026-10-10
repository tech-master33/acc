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

import { collectModels, encodeCatalog } from "../src/catalog.mjs";
import { configPath, loadConfig, saveConfig } from "../src/config.mjs";
import {
  claudeCodeSettingsPath,
  connectClaudeCode,
  connectClaudeDesktop,
  desktopPaths,
  disconnectClaudeCode,
  disconnectClaudeDesktop,
  gatewayUrl,
} from "../src/connect.mjs";
import { ADAPTERS } from "../src/providers.mjs";
import { createServer } from "../src/server.mjs";

const HELP = `ACC — one local Anthropic-compatible proxy for the models you bring.

Usage:
  acc serve [--port <n>] [--host <addr>]   Start the proxy and the control panel.
  acc models [--view claude|claude-desktop]
                                           Print the model catalog for a view.
  acc connect <claude-code|claude-desktop> Wire a Claude client to this proxy.
  acc disconnect <target>                  Undo that wiring.
  acc status                               Show providers, models and config paths.
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

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

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
  process.stdout.write(`Gateway:  ${gatewayUrl(config)}\n`);
  process.stdout.write(`Config:   ${configPath()}\n`);
  process.stdout.write(`Claude Code settings:   ${claudeCodeSettingsPath()}\n`);
  process.stdout.write(`Claude Desktop profile: ${desktopPaths().profile}\n`);
  process.stdout.write(
    `Hide Claude models: ${config.hideClaudeModels ? "yes" : "no"}\n`
  );
  process.stdout.write(`Fallback model: ${config.defaultModel || "(first available)"}\n\n`);
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

async function connect(target, action) {
  const config = loadConfig();
  const run = {
    "claude-code": action === "disconnect" ? disconnectClaudeCode : () => connectClaudeCode(config),
    "claude-desktop":
      action === "disconnect" ? () => disconnectClaudeDesktop() : () => connectClaudeDesktop(config),
  }[target];
  if (!run) {
    process.stderr.write(`Unknown target "${target}". Use claude-code or claude-desktop.\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = run();
    process.stdout.write(`${result.message}\n`);
    if (result.path) process.stdout.write(`Wrote: ${result.path}\n`);
  } catch (error) {
    process.stderr.write(`Failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const command = positional[0] ?? "serve";

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
    await connect(positional[1], "connect");
    break;
  case "disconnect":
    await connect(positional[1], "disconnect");
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
