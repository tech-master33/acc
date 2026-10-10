# ACC

**ACC is one local proxy that speaks the Anthropic Messages API and fronts the model families you bring.** Claude Code and Claude Desktop point at it, so the only models in their pickers are the ones you turn on. Everything else — including Claude's own models — stays hidden until you say otherwise.

It is a small, dependency-free Node service with a built-in control panel. It is deliberately **not** a fork of, or a dependency on, Free Claude Code: same idea, separate code, so the two can run side by side.

```
Claude Desktop ─┐
                ├─► http://127.0.0.1:8788 ─┬─► OpenCode Zen        (your key)
Claude Code ────┘   /v1/messages          ├─► OpenCode registry   (your keys, per provider)
                    /v1/models            └─► Codebuff/Freebuff   (your Codebuff API key)
                        ▲
                        └── control panel at /
```

## Why a proxy at all

Claude Code can be aimed at another model source with `ANTHROPIC_BASE_URL`, but that only works if the far end speaks Anthropic Messages. Claude Desktop does not even read that variable — it has its own third-party-inference setting. Almost every free or cheap model source speaks OpenAI Chat Completions instead.

ACC is the translation and routing layer in the middle, so both clients work unchanged.

## Quick start

```bash
cd acc
npm start            # or: node bin/acc.mjs serve
```

Then open <http://127.0.0.1:8788/> and use the control panel. Nothing is enabled out of the box — no provider is switched on until you add a key and tick **Enabled**.

Wire up the clients either from the panel buttons or the CLI:

```bash
node bin/acc.mjs connect claude-code      # writes ~/.claude/settings.json
node bin/acc.mjs connect claude-desktop   # writes Claude Desktop's 3p profile
node bin/acc.mjs status                   # what's on, what's advertised
node bin/acc.mjs models                   # exactly what /v1/models returns
```

## Providers

| Provider | Transport | Credential | Default |
|---|---|---|---|
| **OpenCode Zen** | native Anthropic `/v1/messages` | `OPENCODE_API_KEY` | **off** |
| **OpenCode built-in providers** | OpenAI `chat/completions` per provider | one key per provider you enable | **off** |
| **Codebuff / Freebuff models** | OpenAI `chat/completions` | your own [Codebuff API key](https://www.codebuff.com/api-keys) | **off** |

OpenCode Zen is a pass-through: Zen already serves an Anthropic Messages endpoint, so ACC forwards the request untouched. That is the highest-fidelity path and the one to prefer for Claude Code. The other two are translated request-by-request, including streaming, tool calls and image blocks.

### A note about Freebuff's free tier

The Freebuff desktop agent's included free models run on Codebuff's own gateway, metered in "freebucks", and are authenticated with the desktop client's device key and signed headers. **That access cannot legitimately be proxied.** Freebuff's Terms of Service forbid calling those endpoints directly and forbid relaying or wrapping the free access through another client, and there is no supported cross-client credential for it.

So ACC does the honest version instead: it lists the same model ids the agent routes to, and reaches them through **your own Codebuff API key** — the documented, supported path (`@codebuff/sdk`, `Authorization: Bearer <key>`). If you want the free tier, use Freebuff itself.

## How the clients are wired

**Claude Code** — ACC merges an `env` block into `~/.claude/settings.json`, touching only the keys it owns:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8788",
    "ANTHROPIC_AUTH_TOKEN": "…",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_MODEL": "opencode-zen/big-pickle"
  },
  "model": "opencode-zen/big-pickle"
}
```

`disconnect claude-code` removes exactly those keys and leaves the rest of the file alone. A one-time `.acc-backup` copy is kept.

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

It lives at `%LOCALAPPDATA%\Claude-3p\configLibrary\<uuid>.json` on Windows, `~/Library/Application Support/Claude-3p/…` on macOS, and `~/.config/Claude-3p/…` on Linux, and `claude_desktop_config.json` is switched to `"deploymentMode": "3p"`. **Quit and reopen Desktop afterwards.** Other vendors' entries in the library are left untouched, so Free Claude Code's profile keeps working and you can switch between them in Desktop.

## Model ids

Both clients discover models from `GET /v1/models` and then send the id back, so ACC encodes each `provider/model` reference per client:

| View | Id shape | Example |
|---|---|---|
| Claude Code | `anthropic/<provider>/<model>` | `anthropic/opencode-zen/big-pickle` |
| Claude Code, no thinking | `claude-3-acc-no-thinking/<provider>/<model>` | |
| Claude Desktop | `claude-acc/<hex of provider/model>` | `claude-acc/6f70656e636f64652d7a656e2f6269672d7069636b6c65` |

`claude-3-` in the no-thinking id is not decoration: Claude Code's own capability heuristic keys off that substring. Desktop gets hex-encoded ids because it rewrites the string before sending it back.

A request for something ACC does not serve — including a plain `claude-sonnet-4-…` — is routed to the **fallback model** you pick in the panel, so a client that has not refreshed its model list still works. Set no fallback and ACC answers with a 400 explaining what to do.

## Hiding Claude's models

`hideClaudeModels` is **on** by default, which means the pickers show only the models you supplied. Turn it off in the panel and ACC re-advertises Anthropic's standard ids. Note that ACC has no Anthropic upstream of its own: if a Claude id is advertised but no provider serves it, requests for it land on the fallback model.

## Security

- Binds to loopback. Desktop only accepts a loopback HTTP/HTTPS gateway, so that is also the only thing that works.
- Every `/v1/*` request must carry the token, as `x-api-key` or `Authorization: Bearer`. The same token is what gets written into the client configs.
- The config, including keys, lives in `~/.acc/config.json` with mode `0600`; keys are never echoed back to the panel — it only learns whether one is set.
- Nothing is sent anywhere except the upstreams you enable.

## Commands

```
acc serve [--port <n>] [--host <addr>]
acc models [--view claude|claude-desktop]
acc connect <claude-code|claude-desktop>
acc disconnect <claude-code|claude-desktop>
acc status
```

Environment overrides, useful for testing: `ACC_CONFIG_PATH`, `CLAUDE_CONFIG_DIR`, `ACC_CLAUDE_DESKTOP_ROOT`.

## Tests

```bash
npm test
```

The suite needs no network and no API keys: a stub upstream stands in for both upstream shapes, and the client-wiring tests write into temporary directories.

## License

MIT
