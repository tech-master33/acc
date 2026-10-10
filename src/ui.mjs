/**
 * The ACC control panel.
 *
 * Accessibility is a requirement here, not a nicety: the panel is fully
 * keyboard-operable, every control has a real <label>, status changes are
 * announced through `aria-live` regions, and state is never conveyed by colour
 * alone (each status also carries text).
 */

export function panelHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ACC control panel</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #16181d; --muted: #4a4f5a; --line: #c9cdd6;
    --card: #f6f7f9; --accent: #1f4fd8; --accent-fg: #ffffff;
    --ok: #0f6b3d; --warn: #8a5200; --bad: #a01a1a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d; --fg: #f2f4f8; --muted: #b9bfcb; --line: #3a3f4a;
      --card: #1e2128; --accent: #8fb0ff; --accent-fg: #10131a;
      --ok: #7ee2a8; --warn: #ffcc80; --bad: #ff9a9a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.55 system-ui, -apple-system, Segoe UI, sans-serif;
  }
  .wrap { max-width: 62rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
  header.page { border-bottom: 2px solid var(--line); padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; }
  h3 { font-size: 1rem; margin: 0 0 .5rem; }
  p.lede, p.hint { color: var(--muted); margin: .25rem 0 .75rem; }
  .skip { position: absolute; left: -9999px; }
  .skip:focus {
    position: static; display: inline-block; margin-bottom: 1rem;
    background: var(--accent); color: var(--accent-fg); padding: .5rem .75rem;
  }
  section { margin-bottom: 2rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: .5rem; padding: 1rem; margin-bottom: 1rem; }
  .row { display: flex; flex-wrap: wrap; gap: .75rem 1.25rem; align-items: flex-end; }
  label { display: block; font-weight: 600; margin-bottom: .25rem; }
  input[type=text], input[type=password], input[type=search], select {
    font: inherit; padding: .45rem .55rem; min-width: 16rem; max-width: 100%;
    color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: .3rem;
  }
  input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible, a:focus-visible {
    outline: 3px solid var(--accent); outline-offset: 2px;
  }
  button {
    font: inherit; font-weight: 600; padding: .5rem .9rem; border-radius: .3rem;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer;
  }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  button.danger { color: var(--bad); }
  fieldset { border: 1px solid var(--line); border-radius: .5rem; padding: .9rem 1rem 1rem; margin: 0 0 1rem; }
  legend { font-weight: 700; padding: 0 .35rem; }
  .switch { display: flex; align-items: center; gap: .5rem; }
  .switch input { width: 1.15rem; height: 1.15rem; }
  .switch label { margin: 0; }
  .status { font-weight: 700; }
  .status.on { color: var(--ok); }
  .status.off { color: var(--muted); }
  .status.attention { color: var(--warn); }
  .status.error { color: var(--bad); }
  .meta { color: var(--muted); font-size: .95rem; }
  table { border-collapse: collapse; width: 100%; font-size: .95rem; }
  caption { text-align: left; color: var(--muted); padding-bottom: .35rem; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); }
  th { white-space: nowrap; }
  .log { border: 1px solid var(--line); border-radius: .3rem; padding: .6rem .75rem; min-height: 2.5rem; background: var(--bg); }
  .log li { margin: .15rem 0; }
  code, kbd { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .92em; }
  .scroll { max-height: 22rem; overflow: auto; border: 1px solid var(--line); border-radius: .3rem; }
  dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; }
  dl.kv dt { font-weight: 600; }
  dl.kv dd { margin: 0; overflow-wrap: anywhere; }
  details { margin-top: .5rem; }
  summary { cursor: pointer; font-weight: 600; }
</style>
</head>
<body>
<div class="wrap">
  <a class="skip" href="#main">Skip to main content</a>

  <header class="page">
    <h1>ACC control panel</h1>
    <p class="lede">
      One local proxy that speaks Anthropic Messages and fronts the model families you bring.
      Claude Code and Claude Desktop connect to it, so the models offered are only the ones you enable here.
    </p>
    <dl class="kv" id="overview"></dl>
  </header>

  <main id="main">
    <section aria-labelledby="h-providers">
      <h2 id="h-providers">Providers</h2>
      <p class="hint">Disabled providers expose no models. OpenCode Zen is off until you paste a key.</p>
      <div id="providers"></div>
    </section>

    <section aria-labelledby="h-defaults">
      <h2 id="h-defaults">Defaults</h2>
      <div class="card">
        <div class="row">
          <div>
            <label for="default-model">Fallback model</label>
            <select id="default-model" name="defaultModel"></select>
            <p class="meta" id="default-hint">Used when a client asks for a model ACC does not serve.</p>
          </div>
          <div class="switch">
            <input type="checkbox" id="hide-claude" name="hideClaudeModels">
            <label for="hide-claude">Hide Claude's own models from the picker</label>
          </div>
          <button type="button" class="primary" id="save-defaults">Save defaults</button>
        </div>
      </div>
    </section>

    <section aria-labelledby="h-wiring">
      <h2 id="h-wiring">Connect Claude</h2>
      <p class="hint">These write the client configs directly. Nothing is sent anywhere else.</p>
      <div class="card">
        <h3>Claude Code (CLI)</h3>
        <p class="meta">Sets <code>ANTHROPIC_BASE_URL</code>, a token, gateway model discovery and the default model in <code>~/.claude/settings.json</code>.</p>
        <div class="row">
          <button type="button" class="primary" data-connect="claude-code">Connect Claude Code</button>
          <button type="button" data-disconnect="claude-code">Disconnect</button>
        </div>
        <p class="meta" id="claude-code-path"></p>
      </div>
      <div class="card">
        <h3>Claude Desktop</h3>
        <p class="meta">Adds an ACC entry to Desktop's third-party-inference library and switches Desktop into gateway mode.</p>
        <div class="row">
          <button type="button" class="primary" data-connect="claude-desktop">Connect Claude Desktop</button>
          <button type="button" data-disconnect="claude-desktop">Disconnect</button>
        </div>
        <p class="meta" id="claude-desktop-path"></p>
        <p class="meta">Desktop must be restarted after connecting. Keep the FCC entry separate if you still want it.</p>
      </div>
    </section>

    <section aria-labelledby="h-announcements">
      <h2 id="h-announcements">Status</h2>
      <div class="log">
        <ul id="log" role="log" aria-live="polite" aria-relevant="additions"></ul>
      </div>
    </section>

    <section aria-labelledby="h-models">
      <h2 id="h-models">Advertised models</h2>
      <p class="hint">
        <button type="button" id="refresh-models">Refresh catalog</button>
        <span id="model-count" class="meta"></span>
      </p>
      <table>
        <caption>Exactly what <code>GET /v1/models</code> returns</caption>
        <thead>
          <tr><th scope="col">Model</th><th scope="col">Provider</th><th scope="col">Source</th><th scope="col">Context</th></tr>
        </thead>
        <tbody id="model-rows"></tbody>
      </table>
    </section>

    <section aria-labelledby="h-registry">
      <h2 id="h-registry">OpenCode built-in providers</h2>
      <p class="hint">Enable a provider below with your own API key; its models then appear in the list above.</p>
      <div class="card">
        <label for="registry-search">Filter providers</label>
        <input type="search" id="registry-search" name="registryFilter" placeholder="deepseek, groq, openrouter…">
        <p class="meta" id="registry-status">Loading…</p>
        <div class="scroll" tabindex="0" role="region" aria-label="OpenCode providers">
          <table>
            <caption>Providers published by OpenCode's model registry</caption>
            <thead>
              <tr><th scope="col">Provider</th><th scope="col">Models</th><th scope="col">Key</th><th scope="col">Base URL</th><th scope="col">State</th></tr>
            </thead>
            <tbody id="registry-rows"></tbody>
          </table>
        </div>
      </div>
    </section>
  </main>
</div>

<script>
const $ = (id) => document.getElementById(id);
const logList = $("log");

function say(text, kind = "info") {
  const li = document.createElement("li");
  li.textContent = text;
  if (kind === "error") li.setAttribute("role", "alert");
  logList.prepend(li);
  while (logList.children.length > 40) logList.lastElementChild.remove();
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || response.statusText);
  return payload;
}

function statusClass(adapter) {
  if (!adapter.enabled) return "off";
  if (adapter.ready) return "on";
  return "attention";
}

function statusText(adapter) {
  if (!adapter.enabled) return "Disabled";
  return adapter.ready ? "Enabled" : "Enabled, needs setup";
}

function renderOverview(state) {
  const dl = $("overview");
  dl.replaceChildren();
  const rows = [
    ["Gateway URL", "http://" + state.host + ":" + state.port],
    ["Clients", state.views.join(", ")],
    ["Enabled providers", state.adapters.filter((a) => a.enabled).length + " of " + state.adapters.length],
    ["Config file", state.configPath],
  ];
  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }
}

function renderProviders(state) {
  const container = $("providers");
  container.replaceChildren();
  for (const adapter of state.adapters) {
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = adapter.label;
    fieldset.append(legend);

    const status = document.createElement("p");
    const span = document.createElement("span");
    span.className = "status " + statusClass(adapter);
    span.textContent = statusText(adapter);
    status.append(span, document.createTextNode(" — "));
    status.append(document.createTextNode(adapter.detail));
    fieldset.append(status);

    const row = document.createElement("div");
    row.className = "row";

    const switchWrap = document.createElement("div");
    switchWrap.className = "switch";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.id = "enable-" + adapter.id;
    toggle.checked = Boolean(adapter.enabled);
    const toggleLabel = document.createElement("label");
    toggleLabel.setAttribute("for", toggle.id);
    toggleLabel.textContent = "Enabled";
    switchWrap.append(toggle, toggleLabel);

    if (adapter.hasKeyInput) {
      const keyWrap = document.createElement("div");
      const keyLabel = document.createElement("label");
      keyLabel.setAttribute("for", "key-" + adapter.id);
      keyLabel.textContent = adapter.apiKey ? "API key (saved)" : "API key";
      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.id = "key-" + adapter.id;
      keyInput.autocomplete = "off";
      keyInput.placeholder = adapter.apiKey ? "••••••• (leave blank to keep)" : "paste key";
      keyWrap.append(keyLabel, keyInput);
      row.append(keyWrap);
    }

    const baseWrap = document.createElement("div");
    const baseLabel = document.createElement("label");
    baseLabel.setAttribute("for", "base-" + adapter.id);
    baseLabel.textContent = "Base URL";
    const baseInput = document.createElement("input");
    baseInput.type = "text";
    baseInput.id = "base-" + adapter.id;
    baseInput.value = adapter.baseUrl || "";
    baseWrap.append(baseLabel, baseInput);
    row.append(baseWrap);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "Save " + adapter.label;
    save.addEventListener("click", async () => {
      const patch = { enabled: toggle.checked, baseUrl: baseInput.value.trim() };
      const keyField = $("key-" + adapter.id);
      if (keyField && keyField.value.trim()) patch.apiKey = keyField.value.trim();
      try {
        await api("/api/config", {
          method: "POST",
          body: JSON.stringify({ providers: { [adapter.id]: patch } }),
        });
        say(adapter.label + " saved.");
        await refreshAll();
      } catch (error) {
        say("Could not save " + adapter.label + ": " + error.message, "error");
      }
    });
    row.append(save);

    if (adapter.alwaysKeyed) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "danger";
      clear.textContent = "Clear key";
      clear.addEventListener("click", async () => {
        try {
          await api("/api/config", {
            method: "POST",
            body: JSON.stringify({ providers: { [adapter.id]: { apiKey: "" } } }),
          });
          say(adapter.label + " key cleared.");
          await refreshAll();
        } catch (error) {
          say("Could not clear key: " + error.message, "error");
        }
      });
      row.append(clear);
    }

    fieldset.append(row);

    if (adapter.docsUrl || adapter.keyUrl) {
      const links = document.createElement("p");
      links.className = "meta";
      if (adapter.keyUrl) {
        const a = document.createElement("a");
        a.href = adapter.keyUrl;
        a.textContent = "Get a key";
        a.target = "_blank";
        a.rel = "noreferrer";
        links.append(a);
      }
      if (adapter.docsUrl) {
        if (adapter.keyUrl) links.append(document.createTextNode(" · "));
        const b = document.createElement("a");
        b.href = adapter.docsUrl;
        b.textContent = "Documentation";
        b.target = "_blank";
        b.rel = "noreferrer";
        links.append(b);
      }
      fieldset.append(links);
    }

    container.append(fieldset);
  }
}

function renderDefaults(state) {
  const select = $("default-model");
  const current = select.value;
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "(first available model)";
  select.append(none);
  for (const model of state.models) {
    const option = document.createElement("option");
    option.value = model.ref;
    option.textContent = model.ref;
    select.append(option);
  }
  select.value = state.defaultModel && state.models.some((m) => m.ref === state.defaultModel)
    ? state.defaultModel
    : current;
  $("hide-claude").checked = Boolean(state.hideClaudeModels);
}

function renderModels(state) {
  const tbody = $("model-rows");
  tbody.replaceChildren();
  for (const model of state.models) {
    const tr = document.createElement("tr");
    for (const value of [
      model.ref,
      model.displayName || "",
      model.providerId,
      model.source,
      model.contextWindow ? String(model.contextWindow) : "",
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    tbody.append(tr);
  }
  $("model-count").textContent = state.models.length + " model(s)";
  if (state.errors && Object.keys(state.errors).length) {
    for (const [id, message] of Object.entries(state.errors)) {
      say(id + " catalog error: " + message, "error");
    }
  }
}

let registry = [];

function renderRegistry() {
  const filter = $("registry-search").value.trim().toLowerCase();
  const tbody = $("registry-rows");
  tbody.replaceChildren();
  const rows = registry.filter((entry) =>
    !filter || entry.id.toLowerCase().includes(filter) || entry.name.toLowerCase().includes(filter)
  );
  for (const entry of rows.slice(0, 200)) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = entry.name + " (" + entry.id + ")";
    const count = document.createElement("td");
    count.textContent = String(entry.modelCount);
    const key = document.createElement("td");
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.id = "registry-key-" + entry.id;
    keyInput.setAttribute("aria-label", entry.name + " API key");
    keyInput.placeholder = entry.hasKey ? "••••••• (saved)" : "paste key";
    keyInput.autocomplete = "off";
    key.append(keyInput);
    const base = document.createElement("td");
    const baseInput = document.createElement("input");
    baseInput.type = "text";
    baseInput.id = "registry-base-" + entry.id;
    baseInput.setAttribute("aria-label", entry.name + " base URL");
    baseInput.value = entry.baseUrl || "";
    baseInput.placeholder = "https://…/v1";
    base.append(baseInput);
    const state = document.createElement("td");
    const enable = document.createElement("button");
    enable.type = "button";
    enable.textContent = entry.enabled ? "Disable" : "Enable";
    enable.addEventListener("click", async () => {
      try {
        await api("/api/registry", {
          method: "POST",
          body: JSON.stringify({
            providerId: entry.id,
            enabled: !entry.enabled,
            apiKey: keyInput.value.trim(),
            baseUrl: baseInput.value.trim(),
          }),
        });
        say(entry.name + (entry.enabled ? " disabled." : " enabled."));
        await loadRegistry();
        await refreshAll();
      } catch (error) {
        say("Could not update " + entry.name + ": " + error.message, "error");
      }
    });
    state.append(enable);
    tr.append(name, count, key, base, state);
    tbody.append(tr);
  }
  $("registry-status").textContent = rows.length + " of " + registry.length + " provider(s).";
}

async function loadRegistry() {
  const payload = await api("/api/registry");
  registry = payload.providers;
  renderRegistry();
}

async function refreshAll() {
  const state = await api("/api/state");
  renderOverview(state);
  renderProviders(state);
  renderDefaults(state);
  renderModels(state);
  $("claude-code-path").textContent = "Writes: " + state.paths.claudeCode;
  $("claude-desktop-path").textContent = "Writes: " + state.paths.claudeDesktop;
}

$("save-defaults").addEventListener("click", async () => {
  try {
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        defaultModel: $("default-model").value,
        hideClaudeModels: $("hide-claude").checked,
      }),
    });
    say("Defaults saved.");
    await refreshAll();
  } catch (error) {
    say("Could not save defaults: " + error.message, "error");
  }
});

$("refresh-models").addEventListener("click", async () => {
  try {
    const payload = await api("/api/refresh", { method: "POST", body: "{}" });
    say("Catalog refreshed: " + payload.models.length + " model(s).");
    await refreshAll();
  } catch (error) {
    say("Refresh failed: " + error.message, "error");
  }
});

$("registry-search").addEventListener("input", renderRegistry);

for (const button of document.querySelectorAll("[data-connect]")) {
  button.addEventListener("click", async () => {
    try {
      const result = await api("/api/connect", {
        method: "POST",
        body: JSON.stringify({ target: button.dataset.connect, action: "connect" }),
      });
      say(result.message || "Connected.");
      await refreshAll();
    } catch (error) {
      say("Connect failed: " + error.message, "error");
    }
  });
}

for (const button of document.querySelectorAll("[data-disconnect]")) {
  button.addEventListener("click", async () => {
    try {
      const result = await api("/api/connect", {
        method: "POST",
        body: JSON.stringify({ target: button.dataset.disconnect, action: "disconnect" }),
      });
      say(result.message || "Disconnected.");
      await refreshAll();
    } catch (error) {
      say("Disconnect failed: " + error.message, "error");
    }
  });
}

refreshAll().catch((error) => say("Could not load state: " + error.message, "error"));
loadRegistry().catch((error) => say("Could not load the OpenCode registry: " + error.message, "error"));
</script>
</body>
</html>
`;
}
