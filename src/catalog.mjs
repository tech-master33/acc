/**
 * The model inventory ACC advertises to Claude clients.
 *
 * Claude Code and Claude Desktop both read `GET /v1/models`, but they expect
 * different id shapes (see `ids.mjs`). One aggregation is cached briefly and
 * re-encoded per view, so the panel, the CLI and both clients always agree.
 */

import { claudeModelId, desktopModelId, modelRef } from "./ids.mjs";
import { ADAPTERS } from "./providers.mjs";

const CACHE_TTL_MS = 30_000;
const DISCOVERED_CREATED_AT = "1970-01-01T00:00:00Z";

/** Anthropic ids ACC re-advertises when `hideClaudeModels` is off. */
export const ANTHROPIC_MODELS = [
  { id: "claude-fable-5", displayName: "Claude Fable 5" },
  { id: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
  { id: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
  { id: "claude-haiku-4-20250514", displayName: "Claude Haiku 4" },
  { id: "claude-3-5-sonnet-20241022", displayName: "Claude 3.5 Sonnet" },
  { id: "claude-3-5-haiku-20241022", displayName: "Claude 3.5 Haiku" },
];

let cache = { key: null, at: 0, value: null };

export function invalidateCatalog() {
  cache = { key: null, at: 0, value: null };
}

function providerCacheKey(config) {
  // Only settings that change the model list take part in the key.
  return JSON.stringify(
    Object.entries(config.providers ?? {}).map(([id, value]) => [
      id,
      Boolean(value?.enabled),
      value?.baseUrl ?? null,
      Boolean(value?.apiKey),
      Object.entries(value?.accounts ?? {})
        .filter(([, account]) => account?.enabled)
        .map(([accountId, account]) => [accountId, account?.baseUrl ?? null, Boolean(account?.apiKey)]),
    ])
  );
}

/**
 * Aggregate every enabled provider's models.
 * Returns `{ models, errors }`, where `errors` maps provider id to a message.
 */
export async function collectModels(config, { refresh = false, fetchImpl, now = Date.now() } = {}) {
  const key = providerCacheKey(config);
  if (!refresh && cache.key === key && now - cache.at < CACHE_TTL_MS && cache.value) {
    return cache.value;
  }

  const models = [];
  const errors = {};
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    const providerConfig = config.providers?.[id];
    if (!providerConfig?.enabled) continue;
    try {
      const result = await adapter.listModels(providerConfig, { fetchImpl });
      for (const model of result.models ?? []) {
        models.push({
          ...model,
          providerId: id,
          ref: modelRef(id, model.id),
          source: result.source ?? "builtin",
        });
      }
    } catch (error) {
      errors[id] = error.message;
    }
  }

  models.sort((a, b) => a.ref.localeCompare(b.ref));
  cache = { key, at: now, value: { models, errors } };
  return cache.value;
}

function entry({ id, displayName, model, ref }) {
  return {
    object: "model",
    id,
    created: 0,
    owned_by: "acc",
    created_at: DISCOVERED_CREATED_AT,
    display_name: displayName,
    type: "model",
    provider_model_ref: ref,
    supports_reasoning: model?.supportsReasoning ?? null,
    context_window: model?.contextWindow ?? null,
    maxCompletionTokens: model?.maxOutput ?? null,
  };
}

/**
 * Encode the inventory for one client view.
 *
 * `hideClaudeModels` keeps Anthropic's own ids out of the picker so the only
 * models offered are the ones the user supplied (the default for ACC).
 */
export function encodeCatalog({ models, hideClaudeModels = true, defaultModelRef = null }, view = "claude") {
  const data = [];

  // With nothing of our own to offer, an empty picker is worse than showing
  // Anthropic's ids: there is no "our models instead" left to prefer.
  const showAnthropic = !hideClaudeModels || models.length === 0;
  if (showAnthropic) {
    for (const model of ANTHROPIC_MODELS) {
      data.push({
        object: "model",
        id: model.id,
        created: 0,
        owned_by: "anthropic",
        created_at: DISCOVERED_CREATED_AT,
        display_name: model.displayName,
        type: "model",
      });
    }
  }

  for (const model of models) {
    const noThinking = model.supportsReasoning === false;
    const id = view === "claude-desktop" ? desktopModelId(model.ref) : claudeModelId(model.ref);
    data.push(
      entry({
        id,
        displayName: model.displayName ?? model.ref,
        model,
        ref: model.ref,
      })
    );
    const variantRef = `${model.ref} (no thinking)`;
    data.push(
      entry({
        id:
          view === "claude-desktop"
            ? desktopModelId(model.ref, { noThinking: true })
            : claudeModelId(model.ref, { noThinking: true }),
        displayName: noThinking ? model.displayName ?? model.ref : variantRef,
        model,
        ref: model.ref,
      })
    );
  }

  let defaultModelId = null;
  // `||`, not `??`: an unset fallback is stored as an empty string.
  const ref = defaultModelRef || models[0]?.ref || null;
  if (ref) {
    defaultModelId =
      view === "claude-desktop" ? desktopModelId(ref) : claudeModelId(ref);
  }

  return {
    object: "list",
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data[data.length - 1]?.id ?? null,
    default_model_id: defaultModelId,
  };
}
