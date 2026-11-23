// FU.A1 (2026-05-09 night) — Multi-host LLM resolver.
// FU.A2 (2026-05-09 night) — Anthropic kind (`x-api-key` + version
// header · key from JSON config or ANTHROPIC_API_KEY env fallback).
// FU.A3 (2026-05-09 night) — In-memory override store + GET/PUT/
// DELETE `/v1/llm/hosts` endpoint so the host config can be reloaded
// without restarting the daemon (PWA settings UI · curl · etc).
//
// Phase 1+2+3 of the §4.2 follow-up from the R6 FU micro-cascade
// closure (내부 문서).
// The daemon now enumerates models from multiple LLM backends in
// parallel — LM Studio (default), vLLM (OpenAI-compat), Ollama,
// Anthropic — and the host config can be hot-swapped at runtime.
//
// Configure via `ELANOUS_LLM_HOSTS` (JSON array). Backward-compat: when
// unset, fall back to a single `lm-studio` host using the legacy
// `ELANOUS_LLM_MODELS_ENDPOINT` (or `http://localhost:1234/v1`).
//
//   ELANOUS_LLM_HOSTS='[
//     {"name":"local","kind":"lm-studio","endpoint":"http://localhost:1234"},
//     {"name":"macmini","kind":"lm-studio","endpoint":"http://100.109.189.62:1234"},
//     {"name":"ollama","kind":"ollama","endpoint":"http://localhost:11434"},
//     {"name":"anthropic","kind":"anthropic-openai-wrap","endpoint":"https://api.anthropic.com"}
//   ]'
//
// Anthropic auth: per-host `apiKey` field in the JSON above, or the
// standard `ANTHROPIC_API_KEY` env (preferred — keys never live in
// shell history). Hosts of kind `anthropic-openai-wrap` without a
// resolved key surface as a per-host `error: 'missing-api-key'` in the
// response so the dropdown can show "key not configured" without
// blocking other hosts.

// RFC #2161 Phase 4 (2026-05-11) — disambiguation rename. The host
// `kind` describes how the daemon talks to a *self-hosted/remote LLM
// endpoint*, which is a different concept from the canonical 'anthropic'
// *provider* in the registry catalog (registry/types.ts). The legacy
// 'anthropic' kind name caused subtle bugs where users typed
// `provider: anthropic` expecting the catalog provider but the LLM host
// dispatcher kicked in instead. The new id 'anthropic-openai-wrap'
// names what the dispatcher actually does (wraps Anthropic's HTTP API
// behind an OpenAI-compat surface). Legacy 'anthropic' is accepted for
// 1 release with a deprecation warning so dogfood configs migrate
// gracefully.
export type LlmHostKind = 'lm-studio' | 'vllm' | 'ollama' | 'anthropic-openai-wrap';

/** Legacy kinds the parser still accepts (with a deprecation warning).
 *  Normalised to a canonical `LlmHostKind` before storage. */
type LlmHostKindLegacy = LlmHostKind | 'anthropic';

const ANTHROPIC_KIND_DEPRECATION =
  "kind:'anthropic' is deprecated · rename to 'anthropic-openai-wrap' "
  + '(RFC #2161 Phase 4) · accepted for 1 release';

function normaliseKind(kind: LlmHostKindLegacy): LlmHostKind {
  return kind === 'anthropic' ? 'anthropic-openai-wrap' : kind;
}

export interface LlmHostConfig {
  /** Human-readable label surfaced in the PWA dropdown grouping. */
  name: string;
  kind: LlmHostKind;
  /** Base URL, no trailing `/v1`. Per-kind dispatcher appends the
   *  right path (`/v1/models` for lm-studio/vllm/anthropic,
   *  `/api/tags` for ollama). Trailing slashes are stripped. */
  endpoint: string;
  /** Per-host API key (anthropic only · optional). When absent for an
   *  anthropic host, the dispatcher falls back to the standard
   *  `ANTHROPIC_API_KEY` env. Never logged or echoed. */
  apiKey?: string;
}

export interface LlmHostModel {
  id: string;
  ownedBy?: string;
  /** host.name — for dropdown grouping. */
  host: string;
  /** host.kind — informs the caller about the wire format. */
  hostKind: LlmHostKind;
}

export interface LlmHostFetchResult {
  host: string;
  kind: LlmHostKind;
  endpoint: string;
  count: number;
  error?: string;
  models: LlmHostModel[];
}

const DEFAULT_LM_STUDIO_BASE = 'http://localhost:1234';
const DEFAULT_TIMEOUT_MS = 1500;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Resolve the legacy single-host endpoint (back-compat for the
 *  pre-multi-host wire). Used only when `ELANOUS_LLM_HOSTS` is absent. */
export function resolveLegacyEndpoint(): string {
  const env = process.env.ELANOUS_LLM_MODELS_ENDPOINT;
  if (env && env.length > 0) return stripTrailingSlash(env);
  return `${DEFAULT_LM_STUDIO_BASE}/v1`;
}

/** Strip a trailing `/v1` so per-kind dispatchers can append their
 *  own path. The legacy single-host env included `/v1` while
 *  multi-host configs use the bare base URL. */
function normaliseBaseUrl(url: string): string {
  const stripped = stripTrailingSlash(url);
  return stripped.endsWith('/v1') ? stripped.slice(0, -3) : stripped;
}

/** Parse the JSON array from `ELANOUS_LLM_HOSTS`. Bad input falls back
 *  to the legacy single-host config so existing dogfood envs keep
 *  working — but the parse error is surfaced via the return shape so
 *  the caller (and tests) can detect malformed input.
 *
 *  RFC #2161 Phase 4 — accepts the legacy `'anthropic'` kind for one
 *  release; the host is normalised to `'anthropic-openai-wrap'` and a
 *  per-host deprecation entry surfaces via `deprecations` so the PWA
 *  banner + daemon log can guide users to migrate. */
export function parseLlmHostsEnv(raw: string | undefined): {
  hosts: LlmHostConfig[];
  parseError?: string;
  /** Per-host deprecation messages (legacy alias usage etc.). Empty /
   *  undefined when nothing to flag. */
  deprecations?: string[];
} {
  if (!raw || raw.trim().length === 0) {
    return { hosts: defaultHosts() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      hosts: defaultHosts(),
      parseError: `ELANOUS_LLM_HOSTS JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      hosts: defaultHosts(),
      parseError: 'ELANOUS_LLM_HOSTS must be a JSON array',
    };
  }
  const hosts: LlmHostConfig[] = [];
  const errors: string[] = [];
  const deprecations: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') {
      errors.push(`#${i}: not an object`);
      continue;
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const rawKind = entry.kind as LlmHostKindLegacy;
    const endpoint = typeof entry.endpoint === 'string' ? entry.endpoint.trim() : '';
    const apiKey = typeof entry.apiKey === 'string' && entry.apiKey.length > 0
      ? entry.apiKey
      : undefined;
    if (!name) { errors.push(`#${i}: missing name`); continue; }
    if (
      rawKind !== 'lm-studio'
      && rawKind !== 'vllm'
      && rawKind !== 'ollama'
      && rawKind !== 'anthropic-openai-wrap'
      && rawKind !== 'anthropic'
    ) {
      errors.push(`#${i} (${name}): unknown kind ${JSON.stringify(entry.kind)}`);
      continue;
    }
    if (!endpoint) { errors.push(`#${i} (${name}): missing endpoint`); continue; }
    if (rawKind === 'anthropic') {
      deprecations.push(`#${i} (${name}): ${ANTHROPIC_KIND_DEPRECATION}`);
    }
    const cfg: LlmHostConfig = {
      name,
      kind: normaliseKind(rawKind),
      endpoint: normaliseBaseUrl(endpoint),
    };
    if (apiKey) cfg.apiKey = apiKey;
    hosts.push(cfg);
  }
  if (hosts.length === 0) {
    return {
      hosts: defaultHosts(),
      parseError: errors.length > 0
        ? `ELANOUS_LLM_HOSTS has no valid hosts: ${errors.join('; ')}`
        : 'ELANOUS_LLM_HOSTS is empty',
    };
  }
  const out: {
    hosts: LlmHostConfig[];
    parseError?: string;
    deprecations?: string[];
  } = { hosts };
  if (errors.length > 0) out.parseError = `partial: ${errors.join('; ')}`;
  if (deprecations.length > 0) out.deprecations = deprecations;
  return out;
}

/** Single LM Studio host using the legacy env (or hard-coded default). */
export function defaultHosts(): LlmHostConfig[] {
  return [{
    name: 'local',
    kind: 'lm-studio',
    endpoint: normaliseBaseUrl(resolveLegacyEndpoint()),
  }];
}

// FU.A3 — In-memory override store. When set, takes priority over
// `ELANOUS_LLM_HOSTS` env + legacy single-host. Cleared on
// `setHostsOverride(null)` so callers can revert without a restart.
let hostsOverride: LlmHostConfig[] | null = null;

/** Set the in-memory host override. Pass `null` to clear (revert
 *  to env / legacy). Returns the count of hosts in effect after
 *  the mutation so callers can audit-log. */
export function setHostsOverride(hosts: LlmHostConfig[] | null): number {
  hostsOverride = hosts;
  return hosts?.length ?? 0;
}

/** Read the current override (null when no override is active). The
 *  array is a snapshot — mutating it does NOT mutate the store. */
export function getHostsOverride(): LlmHostConfig[] | null {
  return hostsOverride === null ? null : [...hostsOverride];
}

export type LlmHostsSource = 'override' | 'env' | 'legacy';

/** Resolve the effective host config + which source it came from.
 *  Priority: override > env > legacy single-host fallback. The
 *  source label flows back to the caller so the GET endpoint can
 *  surface "where did this come from" without exposing internals. */
export function getEffectiveHosts(): {
  hosts: LlmHostConfig[];
  source: LlmHostsSource;
  parseError?: string;
  deprecations?: string[];
} {
  if (hostsOverride !== null) {
    return { hosts: [...hostsOverride], source: 'override' };
  }
  const envRaw = process.env.ELANOUS_LLM_HOSTS;
  if (envRaw && envRaw.trim().length > 0) {
    const out = parseLlmHostsEnv(envRaw);
    const result: {
      hosts: LlmHostConfig[];
      source: LlmHostsSource;
      parseError?: string;
      deprecations?: string[];
    } = { hosts: out.hosts, source: 'env' };
    if (out.parseError !== undefined) result.parseError = out.parseError;
    if (out.deprecations !== undefined && out.deprecations.length > 0) {
      result.deprecations = out.deprecations;
    }
    return result;
  }
  return { hosts: defaultHosts(), source: 'legacy' };
}

interface OpenAiCompatModel { id: string; object?: string; owned_by?: string }
interface OllamaTagsModel { name?: string; model?: string }
interface AnthropicModel { id?: string; type?: string; display_name?: string; created_at?: string }

/** Required header version for the Anthropic `/v1/models` endpoint.
 *  See https://docs.anthropic.com/en/api/versioning — the platform
 *  has been stable on `2023-06-01` since launch. */
const ANTHROPIC_API_VERSION = '2023-06-01';

/** Resolve the Anthropic API key: per-host config wins over the
 *  standard `ANTHROPIC_API_KEY` env. Returns null when neither is
 *  set so the dispatcher can return a `missing-api-key` error
 *  without making an unauthorised request. */
function resolveAnthropicKey(host: LlmHostConfig): string | null {
  if (host.apiKey && host.apiKey.length > 0) return host.apiKey;
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.length > 0) return env;
  return null;
}

/** OpenAI-compat dispatcher (LM Studio + vLLM). */
async function fetchOpenAiCompat(
  host: LlmHostConfig,
  signal: AbortSignal,
): Promise<LlmHostFetchResult> {
  const url = `${host.endpoint}/v1/models`;
  try {
    // llm-ledger-exempt: model-listing
    const res = await fetch(url, { signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        host: host.name, kind: host.kind, endpoint: host.endpoint,
        count: 0, models: [],
        error: `upstream-http-${res.status}: ${detail.slice(0, 120)}`,
      };
    }
    const json = (await res.json().catch(() => null)) as
      | { data?: OpenAiCompatModel[] } | null;
    const data = Array.isArray(json?.data) ? json!.data! : [];
    const models = data
      .map((m): LlmHostModel | null => {
        if (typeof m?.id !== 'string' || m.id.length === 0) return null;
        return {
          id: m.id,
          ownedBy: m.owned_by,
          host: host.name,
          hostKind: host.kind,
        };
      })
      .filter((m): m is LlmHostModel => m !== null);
    return {
      host: host.name, kind: host.kind, endpoint: host.endpoint,
      count: models.length, models,
    };
  } catch (e) {
    const aborted = (e as { name?: string } | null)?.name === 'AbortError';
    return {
      host: host.name, kind: host.kind, endpoint: host.endpoint,
      count: 0, models: [],
      error: aborted
        ? 'upstream-timeout'
        : `upstream-network: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Ollama dispatcher — `/api/tags` returns `{ models: [{ name, ... }] }`.
 *  Normalised to the same `{ id, host, hostKind }` shape. */
async function fetchOllamaTags(
  host: LlmHostConfig,
  signal: AbortSignal,
): Promise<LlmHostFetchResult> {
  const url = `${host.endpoint}/api/tags`;
  try {
    // llm-ledger-exempt: model-listing
    const res = await fetch(url, { signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        host: host.name, kind: host.kind, endpoint: host.endpoint,
        count: 0, models: [],
        error: `upstream-http-${res.status}: ${detail.slice(0, 120)}`,
      };
    }
    const json = (await res.json().catch(() => null)) as
      | { models?: OllamaTagsModel[] } | null;
    const data = Array.isArray(json?.models) ? json!.models! : [];
    const models = data
      .map((m): LlmHostModel | null => {
        const id = typeof m?.name === 'string' && m.name.length > 0
          ? m.name
          : typeof m?.model === 'string' && m.model.length > 0
            ? m.model
            : null;
        if (!id) return null;
        return { id, host: host.name, hostKind: host.kind };
      })
      .filter((m): m is LlmHostModel => m !== null);
    return {
      host: host.name, kind: host.kind, endpoint: host.endpoint,
      count: models.length, models,
    };
  } catch (e) {
    const aborted = (e as { name?: string } | null)?.name === 'AbortError';
    return {
      host: host.name, kind: host.kind, endpoint: host.endpoint,
      count: 0, models: [],
      error: aborted
        ? 'upstream-timeout'
        : `upstream-network: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Anthropic dispatcher — `/v1/models` returns
 *  `{ data: [{ id, type, display_name, created_at }] }`. Auth via
 *  `x-api-key` (per-host config or `ANTHROPIC_API_KEY` env) plus the
 *  required `anthropic-version` header. The key is never echoed in
 *  the response: missing key surfaces as `missing-api-key` and
 *  upstream auth failures (401/403) return a generic
 *  `upstream-auth-NNN` so the dropdown can flag the host without
 *  leaking why. */
async function fetchAnthropicModels(
  host: LlmHostConfig,
  signal: AbortSignal,
): Promise<LlmHostFetchResult> {
  const key = resolveAnthropicKey(host);
  if (!key) {
    return {
      host: host.name, kind: host.kind, endpoint: host.endpoint,
      count: 0, models: [],
      error: 'missing-api-key: set host.apiKey or ANTHROPIC_API_KEY env',
    };
  }
  const url = `${host.endpoint}/v1/models`;
  try {
    // llm-ledger-exempt: model-listing
    const res = await fetch(url, {
      signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
    });
    if (!res.ok) {
      // 401 / 403 / 429 — common Anthropic auth + rate-limit codes.
      // Don't include upstream body (may echo the masked key prefix
      // in some error formats). Generic code only.
      if (res.status === 401 || res.status === 403) {
        return {
          host: host.name, kind: host.kind, endpoint: host.endpoint,
          count: 0, models: [],
          error: `upstream-auth-${res.status}`,
        };
      }
      const detail = await res.text().catch(() => '');
      return {
        host: host.name, kind: host.kind, endpoint: host.endpoint,
        count: 0, models: [],
        error: `upstream-http-${res.status}: ${detail.slice(0, 120)}`,
      };
    }
    const json = (await res.json().catch(() => null)) as
      | { data?: AnthropicModel[] } | null;
    const data = Array.isArray(json?.data) ? json!.data! : [];
    const models = data
      .map((m): LlmHostModel | null => {
        if (typeof m?.id !== 'string' || m.id.length === 0) return null;
        return {
          id: m.id,
          // Anthropic returns no `owned_by` field; surface display_name
          // instead so the dropdown can show a friendly label when the
          // PWA is updated to render it.
          ...(m.display_name ? { ownedBy: m.display_name } : {}),
          host: host.name,
          hostKind: host.kind,
        };
      })
      .filter((m): m is LlmHostModel => m !== null);
    return {
      host: host.name, kind: host.kind, endpoint: host.endpoint,
      count: models.length, models,
    };
  } catch (e) {
    const aborted = (e as { name?: string } | null)?.name === 'AbortError';
    return {
      host: host.name, kind: host.kind, endpoint: host.endpoint,
      count: 0, models: [],
      error: aborted
        ? 'upstream-timeout'
        : `upstream-network: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Dispatch a single host to the right per-kind fetcher. */
export async function fetchHostModels(
  host: LlmHostConfig,
  opts: { timeoutMs?: number } = {},
): Promise<LlmHostFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    if (host.kind === 'lm-studio' || host.kind === 'vllm') {
      return await fetchOpenAiCompat(host, ac.signal);
    }
    if (host.kind === 'anthropic-openai-wrap') {
      return await fetchAnthropicModels(host, ac.signal);
    }
    return await fetchOllamaTags(host, ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch all hosts in parallel. Each host failure is surfaced
 *  per-host (not aggregate) so the dropdown can still show OK hosts
 *  even when one is unreachable. */
export async function fetchAllHosts(
  hosts: LlmHostConfig[],
  opts: { timeoutMs?: number } = {},
): Promise<LlmHostFetchResult[]> {
  return Promise.all(hosts.map((h) => fetchHostModels(h, opts)));
}
