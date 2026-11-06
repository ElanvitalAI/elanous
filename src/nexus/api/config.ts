// NEXUS · /v1/config/* routes (Phase N-3 PR μ)

import { jsonResponse } from './json-response.js';
import {
  listSwitches,
  getSwitch,
} from '../config/switch-registry.js';
import { readUserConfig } from '../config/user-config.js';
import {
  readSecrets,
  setSecret as setSecretValue,
  deleteSecret,
  listSecretIds,
} from '../config/secrets.js';
import { applySwitchChange } from '../config/apply.js';
import { readSwitchValue } from '../config/user-config.js';
import {
  isSecretRef,
  type SwitchSpec,
  type UserConfig,
} from '../config/types.js';
import type { NexusState } from '../state/state.js';
import type { TabRegistry } from '../state/tab-registry.js';
import type { Supervisor } from '../supervisor/index.js';

export interface ConfigCtx {
  state: NexusState;
  registry: TabRegistry;
  supervisor?: Supervisor;
  hotApplyHandler?: (switchId: string, value: unknown) => void;
}

// ---------------------------------------------------------------------------
// GET /v1/config — full UserConfig with secret-ref values redacted
// ---------------------------------------------------------------------------

export function handleConfigGet(): Response {
  const cfg = readUserConfig();
  return jsonResponse({ config: redactConfig(cfg) }, 200);
}

function redactConfig(cfg: UserConfig): UserConfig {
  return {
    version: cfg.version,
    global: cfg.global,
    tabs: Object.fromEntries(
      Object.entries(cfg.tabs).map(([id, tabCfg]) => {
        const out: Record<string, unknown> = { ...tabCfg };
        for (const [k, v] of Object.entries(out)) {
          if (isSecretRef(v)) out[k] = '[redacted]';
        }
        return [id, out as UserConfig['tabs'][string]];
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// GET /v1/config/switches — full SwitchRegistry + current values
// ---------------------------------------------------------------------------

export function handleSwitchesList(registry: TabRegistry): Response {
  const cfg = readUserConfig();
  const out = listSwitches().map((sw) => switchToWire(sw, cfg, registry));
  return jsonResponse({ switches: out }, 200);
}

export function handleSwitchGet(switchId: string, registry: TabRegistry): Response {
  const cfg = readUserConfig();
  const sw = lookupSwitchSchema(switchId);
  if (!sw) return jsonResponse({ error: 'switch-not-found', id: switchId }, 404);
  const wire = switchToWire(sw, cfg, registry, switchId);
  return jsonResponse({ switch: wire }, 200);
}

interface SwitchWire {
  id: string;
  scope: SwitchSpec['scope'];
  kind: SwitchSpec['kind'];
  label: string;
  description: string;
  default: unknown;
  enumValues?: SwitchSpec['enumValues'];
  hotApplicable: boolean;
  pwaPreferred?: boolean;
  redactInLogs?: boolean;
  envName?: string;
  legacyEnvName?: string;
  /** Resolved tab-id list (registry-expanded for tab-scope switches). */
  appliesToTabIds?: string[];
  /** Currently stored value · redacted for secret-ref. */
  value?: unknown;
}

function switchToWire(sw: SwitchSpec, cfg: UserConfig, registry: TabRegistry, literalId?: string): SwitchWire | SwitchWire[] {
  const out: Omit<SwitchWire, 'value' | 'appliesToTabIds'> = {
    id: literalId ?? sw.id,
    scope: sw.scope,
    kind: sw.kind,
    label: sw.label,
    description: sw.description,
    default: sw.default,
    ...(sw.enumValues ? { enumValues: sw.enumValues } : {}),
    hotApplicable: sw.hotApplicable,
    ...(sw.pwaPreferred ? { pwaPreferred: true } : {}),
    ...(sw.redactInLogs || sw.kind === 'secret-ref' ? { redactInLogs: true } : {}),
    ...(sw.envName ? { envName: sw.envName } : {}),
    ...(sw.legacyEnvName ? { legacyEnvName: sw.legacyEnvName } : {}),
  };
  if (sw.scope === 'global') {
    const v = readSwitchValue(cfg, sw.id);
    return { ...out, value: redactValue(sw, v) };
  }
  // tab scope — expand to literal ids per matching tab
  const matchingTabs = registry.list().filter((t) =>
    !sw.appliesTo || sw.appliesTo.includes(t.spec.kind),
  );
  if (literalId) {
    const v = readSwitchValue(cfg, literalId);
    return { ...out, id: literalId, value: redactValue(sw, v), appliesToTabIds: matchingTabs.map((t) => t.spec.id) };
  }
  return {
    ...out,
    appliesToTabIds: matchingTabs.map((t) => t.spec.id),
  };
}

function redactValue(sw: SwitchSpec, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (sw.redactInLogs || sw.kind === 'secret-ref') {
    if (isSecretRef(value)) return '[redacted-secret-ref]';
    if (value === '') return '';
    return '[redacted]';
  }
  return value;
}

function lookupSwitchSchema(literalId: string): SwitchSpec | undefined {
  const direct = getSwitch(literalId);
  if (direct) return direct;
  const parts = literalId.split('.');
  if (parts[0] === 'tabs' && parts.length >= 3) {
    return getSwitch(['tabs', '<id>', ...parts.slice(2)].join('.'));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PUT /v1/config/switches/:id — apply change
// ---------------------------------------------------------------------------

interface SwitchPutBody {
  value?: unknown;
}

export async function handleSwitchPut(req: Request, ctx: ConfigCtx, switchId: string): Promise<Response> {
  let body: SwitchPutBody;
  try {
    body = (await req.json()) as SwitchPutBody;
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  if (!('value' in body)) return jsonResponse({ error: 'value-required' }, 400);

  const result = await applySwitchChange({
    state: ctx.state,
    registry: ctx.registry,
    ...(ctx.supervisor ? { supervisor: ctx.supervisor } : {}),
    ...(ctx.hotApplyHandler ? { hotApplyHandler: ctx.hotApplyHandler } : {}),
    switchId,
    value: body.value,
  });

  if (result.outcome === 'unknown-switch') return jsonResponse({ error: 'switch-not-found', id: switchId }, 404);
  if (result.outcome === 'invalid') return jsonResponse({ error: 'invalid-value', message: result.validationError }, 400);

  return jsonResponse({
    outcome: result.outcome,
    switchId,
    ...(result.restartedTabs ? { restartedTabs: result.restartedTabs } : {}),
  }, 200);
}

// ---------------------------------------------------------------------------
// POST /v1/config/secrets — store secret (write-only · returns ref)
// DELETE /v1/config/secrets/:id — remove
// ---------------------------------------------------------------------------

interface SecretPostBody {
  id?: string;
  value?: string;
}

const SAFE_SECRET_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;

export async function handleSecretPost(req: Request): Promise<Response> {
  let body: SecretPostBody;
  try {
    body = (await req.json()) as SecretPostBody;
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  if (!body.id || !SAFE_SECRET_ID_RE.test(body.id)) {
    return jsonResponse({ error: 'invalid-secret-id', hint: 'matches [A-Za-z0-9_:.-]{1,128}' }, 400);
  }
  if (typeof body.value !== 'string' || body.value.length === 0) {
    return jsonResponse({ error: 'value-required' }, 400);
  }
  setSecretValue(body.id, body.value);
  return jsonResponse({ stored: true, id: body.id, ref: `ref:secret:${body.id}` }, 201);
}

export function handleSecretDelete(id: string): Response {
  const removed = deleteSecret(id);
  if (!removed) return jsonResponse({ error: 'secret-not-found', id }, 404);
  return jsonResponse({ deleted: true, id }, 200);
}

export function handleSecretsList(): Response {
  // Return only ids (no values · no refs needed for listing).
  return jsonResponse({ secrets: listSecretIds().map((id) => ({ id })) }, 200);
}

// re-export for tests that want to assert raw secrets store contents
export { readSecrets };
