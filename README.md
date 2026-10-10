# ACC

**ACC is one local proxy that speaks the Anthropic Messages API and fronts the model families you bring.** Claude Code and Claude Desktop point at it, so the only models in their pickers are the ones you turn on. Everything else — including Claude's own models — stays hidden until you say otherwise.

It is a small, dependency-free Node service with a built-in, screen-reader-friendly control panel. It is deliberately **not** a fork of, or a dependency on, Free Claude Code: same idea, separate code, so the two can run side by side.

```
Claude Desktop ─┐
                ├─► http://127.0.0.1:8788 ─┬─► OpenCode Zen              (your Zen key)
Claude Code ────┘   /v1/messages          ├─► OpenCode built-in (free)  (your OpenCode sign-in)
                    /v1/models            ├─► Ollama                    (local, no key)
                        ▲                 ├─► OpenCode provider registry (your keys)
                        │                 └─► Codebuff / Freebuff       (your Codebuff key)
                        └── control panel at /
```

## Install

### Windows — `acc-setup.exe`

Download **`acc-setup.exe`** from the [latest release](https://github.com/tech-master33/acc/releases/latest) and run it. It is a single self-contained installer with the application bundled inside, so it needs no network access.

```
acc-setup.exe                 install using the bundled payload
acc-setup.exe --boot          also start ACC when you sign in
acc-setup.exe --start         also start ACC now and open the control panel
acc-setup.exe --from-github   download the newest release instead
acc-setup.exe --version 0.2.0 install a specific release
acc-setup.exe --dir <path>    install somewhere other than %LOCALAPPDATA%\ACC
acc-setup.exe --no-path       don't put the `acc` command on your PATH
acc-setup.exe --uninstall     remove ACC (settings in %USERPROFILE%\.acc are kept)
```

ACC needs **Node.js 20 or newer** ([nodejs.org](https://nodejs.org/)); the installer checks for it and stops with a clear message if it is missing. Your settings live in `%USERPROFILE%\.acc`, outside the install directory, so upgrading never touches them.

Building the installer from source needs the .NET SDK:

```bash
node scripts/build-release.mjs      # dist/acc-setup.exe, dist/acc.zip, dist/acc.tar.gz
```

### macOS and Linux — `install.sh`

```bash
curl -fsSL https://github.com/tech-master33/acc/releases/latest/download/install.sh | sh
# or: sh install.sh --version 0.2.0 --boot
```

### Run from a checkout

```bash
npm start            # or: node bin/acc.mjs serve
```

Either way, open <http://127.0.0.1:8788/> and use the control panel. Nothing is enabled out of the box — no provider is switched on until you add a key and tick **Enabled**.

## Providers

| Provider | Transport | Credential | Default |
|---|---|---|---|
| **OpenCode Zen** | native Anthropic `/v1/messages` | `OPENCODE_API_KEY` | **off** |
| **OpenCode built-in models** | native Anthropic `/v1/messages` | your OpenCode sign-in (no third-party key) | **off** |
| **Ollama** | OpenAI `chat/completions` | none — it is local | **off** |
| **OpenCode provider registry** | OpenAI `chat/completions` per provider | one key per provider you enable | **off** |
| **Codebuff / Freebuff models** | OpenAI `chat/completions` | your own [Codebuff API key](https://www.codebuff.com/api-keys) | **off** |

Both OpenCode providers are pass-throughs: Zen already serves an Anthropic Messages endpoint, so requests are forwarded untouched and there is no translation to get wrong. Ollama, the registry and Codebuff are translated request-by-request, including streaming, tool calls and image blocks.

**OpenCode's built-in models need no provider.** OpenCode hosts a set of free models itself, so you never have to connect a third-party provider to use them. They are authenticated with your OpenCode account, and ACC finds that credential for you, in this order:

1. the API key you paste in the panel, if you paste one
2. `OPENCODE_API_KEY` in the environment
3. the file written by `opencode auth login`:
   - Windows `%USERPROFILE%\.local\share\opencode\auth.json`
   - macOS/Linux `~/.local/share/opencode/auth.json`
   - plus `~/.config/opencode/auth.json` and `%APPDATA%\opencode\auth.json`

So `opencode auth login` once, tick **Enabled** on *OpenCode built-in models*, and the free models appear in Claude. The panel tells you which credential it found.

**Ollama** defaults to `http://localhost:11434` and lists whatever you have pulled by reading `/api/tags`, so model ids keep their tags (`llama3.2:3b`). If the server is not running, ACC says so instead of hanging.

### A note about Freebuff's free tier

The Freebuff desktop agent's included free models run on Codebuff's own gateway, metered in "freebucks", and are authenticated with the desktop client's device key and signed headers. **That access cannot legitimately be proxied.** Freebuff's Terms of Service forbid calling those endpoints directly and forbid relaying or wrapping the free access through another client, and there is no supported cross-client credential for it.

So ACC does the honest version instead: it lists the same model ids the agent routes to, and reaches them through **your own Codebuff API key** — the documented, supported path (`@codebuff/sdk`, `Authorization: Bearer <key>`). If you want the free tier, use Freebuff itself.

## Connecting Claude

Each client gets **one** control that reflects the real state of its config file: it connects when you are disconnected and disconnects when you are connected, so the two actions are never both on offer. The CLI behaves the same way.

**Claude Code** — ACC merges an `env` block into `~/.claude/settings.json`, touching only the keys it owns:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8788",
    "ANTHROPIC_AUTH_TOKEN": "…",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_MODEL": "opencode-builtin/big-pickle"
  },
  "model": "opencode-builtin/big-pickle"
}
```

Disconnecting removes exactly those keys and leaves the rest of the file alone. A one-time `.acc-backup` copy is kept.

**Claude Desktop** — Desktop ignores environment variables for routing, so ACC writes the same kind of entry the app's own *Configure Third-Party Inference* screen produces:

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:8788",
  "inferenceCredentialKind": "static",
  "inferenceGatewayApiKey": "…",
  "inferenceGatewayAuthScheme": "bearer",
  "modelDiscoveryEnabled": true,
  "inferenceCustomHeaders": { "X-ACC-Model-View": "claude-desktop" }
}
```

It lives at `%LOCALAPPDATA%\Claude-3p\configLibrary\<uuid>.json` on Windows, `~/Library/Application Support/Claude-3p/…` on macOS and `~/.config/Claude-3p/…` on Linux, and `claude_desktop_config.json` is switched to `"deploymentMode": "3p"`. **Quit and reopen Desktop afterwards.** Other vendors' entries in that library are left untouched, so Free Claude Code's profile keeps working.

## ACC as the only gateway

The panel has a **Make ACC the only gateway** button (also `acc gateway only`). It sets ACC as the applied Desktop profile and moves every other third-party profile aside by renaming it to `<id>.json.acc-disabled`. Nothing is deleted, the moved files are recorded in ACC's config, and the button becomes **Restore other gateways** (`acc gateway restore`) to put them back and re-list them in Desktop.

It also points Claude Code at ACC, so both clients then use exactly the models you enabled.

## Start at sign-in

Tick **Start ACC at sign-in** in the panel, or run `acc boot on`. Each platform gets its native mechanism:

| Platform | What ACC writes |
|---|---|
| Windows | a hidden-run launcher in the Startup folder (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ACC.vbs`) |
| macOS | `~/Library/LaunchAgents/dev.acc.gateway.plist` with `RunAtLoad` |
| Linux | `~/.config/autostart/acc.desktop` |

`acc boot off` removes exactly the file it created. Nothing needs administrator rights.

## Model ids

Both clients discover models from `GET /v1/models` and then send the id back, so ACC encodes each `provider/model` reference per client:

| View | Id shape | Example |
|---|---|---|
| Claude Code | `anthropic/<provider>/<model>` | `anthropic/ollama/llama3.2:3b` |
| Claude Code, no thinking | `claude-3-acc-no-thinking/<provider>/<model>` | |
| Claude Desktop | `claude-acc/<hex of provider/model>` | `claude-acc/6f6c6c616d612f6c6c616d61332e323a3362` |

`claude-3-` in the no-thinking id is not decoration: Claude Code's own capability heuristic keys off that substring. Desktop gets hex-encoded ids because it rewrites the string before sending it back.

A request for something ACC does not serve — including a plain `claude-sonnet-4-…` — is routed to the **fallback model** you pick in the panel, so a client that has not refreshed its model list still works. Set no fallback and ACC answers with a 400 that says what to do.

## Hiding Claude's models

`hideClaudeModels` is **on** by default, which means the pickers show only the models you supplied. Turn it off and ACC re-advertises Anthropic's standard ids. Note that ACC has no Anthropic upstream of its own: if a Claude id is advertised but no provider serves it, requests for it land on the fallback model. If every provider is off, ACC advertises the Anthropic ids anyway rather than handing a client an empty picker.

## Security

- Binds to loopback. Desktop only accepts a loopback HTTP/HTTPS gateway, so that is also the only thing that works.
- Every `/v1/*` request must carry the token, as `x-api-key` or `Authorization: Bearer`. The same token is what gets written into the client configs.
- The config, including keys, lives in `~/.acc/config.json` with mode `0600`; keys are never echoed back to the panel — it only learns whether one is set.
- Nothing is sent anywhere except the upstreams you enable, and no telemetry exists.

## Commands

```
acc serve [--port <n>] [--host <addr>]     Start the proxy and the control panel.
acc models [--view claude|claude-desktop]  Print the catalog a client would see.
acc connect <claude-code|claude-desktop>   Toggle. --on / --off force a direction.
acc boot <on|off|status>                   Start automatically at sign-in.
acc gateway <only|restore|status>          Make ACC the only gateway, or undo it.
acc status                                 Providers, clients, models and paths.
```

Environment overrides, useful for testing: `ACC_CONFIG_PATH`, `CLAUDE_CONFIG_DIR`, `ACC_CLAUDE_DESKTOP_ROOT`, `ACC_BOOT_ENTRY`, `ACC_OPENCODE_AUTH`.

## Tests

```bash
npm test
```

34 tests, no network and no API keys required: a stub upstream stands in for both upstream shapes, and the client-wiring, startup and gateway tests write into temporary directories only.

## License

MIT
