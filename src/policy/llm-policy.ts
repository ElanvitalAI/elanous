import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isScalar, parseDocument } from 'yaml';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { DEFAULT_FALLBACK_CHAIN, isFallbackStep, type FallbackStep } from '../oauth/fallback-chain.js';
import { isCodexQuotaPolicy } from '../oauth/codex-quota-policy.js';
import { DEFAULT_BUDGET_GATE_MAX_USED_PERCENT, MODEL_ROLES, RUNTIME_LLM_PROVIDER_NAMES, parseRoleLlmEntry, type RoleLlmConfig } from '../user-config.js';

export interface LlmPolicy {
  version: 1;
  default: { provider: string; model?: string };
  roles: RoleLlmConfig;
  fallback: FallbackStep[];
  accounts: { codex: {
    order: string[];
    rotateAtPercent: number;
    perAccount: Record<string, { rotateAtPercent: number; until?: string; why?: string }>;
    rotationEnabled: boolean;
  } };
  credits: {
    codex: 'use' | 'fallback' | 'never';
    grants: Array<{ account: string; amount: number; expires: string; source: string }>;
    pace?: { targetPerDay: number; until: string; why?: string };
  };
  caps: { codex: { harness: number; pod: number; tox: number; intake: number; headroom: number }; grok: { weekly: number; tox: number; intake: number } };
  resetCredits: { redeem: 'human' };
  alerts: { lowRemainingPercent: number; resetCreditExpiryDays: number; creditsStep: number };
}

export type LlmPolicySource = 'default' | 'legacy-config' | 'file';
export interface LlmPolicyValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
export interface LoadedLlmPolicy extends LlmPolicyValidation {
  policy: LlmPolicy;
  sources: Record<string, LlmPolicySource>;
  path: string;
  filePresent: boolean;
}
export interface LoadLlmPolicyOptions {
  /** All file IO remains scoped to this directory; tests can pass a temporary directory. */
  configDir?: string;
  path?: string;
  /** An already-read legacy config; when omitted the sibling config.json is read directly. */
  legacyConfig?: unknown;
  now?: Date;
}

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const percent = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function setOwn(target: Obj, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
}

/** Today's code defaults, not a snapshot of one machine's user config. */
export function defaultLlmPolicy(): LlmPolicy {
  return {
    version: 1,
    default: { provider: 'auto' },
    roles: {},
    fallback: [...DEFAULT_FALLBACK_CHAIN],
    accounts: { codex: { order: [], rotateAtPercent: 95, perAccount: { default: { rotateAtPercent: 60 } }, rotationEnabled: true } },
    credits: { codex: 'fallback', grants: [] },
    caps: {
      codex: { harness: DEFAULT_BUDGET_GATE_MAX_USED_PERCENT['openai-codex']!, pod: 95, tox: 60, intake: 80, headroom: 15 },
      grok: { weekly: DEFAULT_BUDGET_GATE_MAX_USED_PERCENT.grok!, tox: 50, intake: 48 },
    },
    resetCredits: { redeem: 'human' },
    alerts: { lowRemainingPercent: 10, resetCreditExpiryDays: 7, creditsStep: 5000 },
  };
}

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!object(value) || Object.keys(value).length === 0) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, item]) => leafPaths(item, prefix ? `${prefix}.${key}` : key));
}

/** Validate the partial policy document. Unknown fields and invalid values are errors, not silent overrides. */
export function validateLlmPolicy(input: unknown): LlmPolicyValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!object(input)) return { valid: false, errors: ['policy must be a mapping'], warnings };
  const check = (node: unknown, path: string, schema: Obj): void => {
    if (!object(node)) { errors.push(`${path} must be a mapping`); return; }
    for (const [key, value] of Object.entries(node)) {
      if (!Object.hasOwn(schema, key)) { errors.push(`unknown field ${path}.${key}`); continue; }
      const rule = schema[key];
      if (object(rule)) check(value, `${path}.${key}`, rule);
      else if (typeof rule === 'function' && !(rule as (v: unknown) => boolean)(value)) errors.push(`${path}.${key} is invalid`);
    }
  };
  const dateField = (v: unknown) => date(v);
  const perAccount = (v: unknown) => object(v) && Object.entries(v).every(([key, row]) => nonempty(key) && object(row)
    && Object.keys(row).every(k => ['rotateAtPercent', 'until', 'why'].includes(k))
    && percent(row.rotateAtPercent) && (row.until === undefined || date(row.until)) && (row.why === undefined || nonempty(row.why)));
  const grants = (v: unknown) => Array.isArray(v) && v.every(g => object(g)
    && Object.keys(g).every(k => ['account', 'amount', 'expires', 'source'].includes(k))
    && nonempty(g.account) && positive(g.amount) && date(g.expires) && nonempty(g.source));
  const roles = (v: unknown) => object(v) && Object.entries(v).every(([role, spec]) => MODEL_ROLES.some(r => r === role)
    && object(spec) && Object.keys(spec).every(k => ['provider', 'tier', 'model'].includes(k)) && parseRoleLlmEntry(spec).ok);
  check(input, 'policy', {
    version: (v: unknown) => v === 1,
    default: { provider: (v: unknown) => nonempty(v) && RUNTIME_LLM_PROVIDER_NAMES.some(p => p === v), model: nonempty },
    roles,
    fallback: (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(isFallbackStep) && new Set(v).size === v.length,
    accounts: { codex: {
      order: (v: unknown) => Array.isArray(v) && v.every(nonempty) && new Set(v).size === v.length,
      rotateAtPercent: percent, perAccount, rotationEnabled: (v: unknown) => typeof v === 'boolean',
    } },
    credits: {
      codex: (v: unknown) => v === 'use' || v === 'fallback' || v === 'never',
      grants,
      pace: (v: unknown) => object(v) && positive(v.targetPerDay) && dateField(v.until)
        && (v.why === undefined || nonempty(v.why))
        && Object.keys(v).every(k => ['targetPerDay', 'until', 'why'].includes(k)),
    },
    caps: { codex: { harness: percent, pod: percent, tox: percent, intake: percent, headroom: percent },
      grok: { weekly: percent, tox: percent, intake: percent } },
    resetCredits: { redeem: (v: unknown) => v === 'human' },
    alerts: { lowRemainingPercent: percent, resetCreditExpiryDays: positive, creditsStep: positive },
  });
  if (input.version !== undefined && input.version !== 1) warnings.push('unsupported policy version');
  return { valid: errors.length === 0, errors, warnings };
}

function merge(base: Obj, overlay: Obj, sources: Record<string, LlmPolicySource>, source: LlmPolicySource, prefix = ''): void {
  for (const [key, value] of Object.entries(overlay)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (object(value) && Object.hasOwn(base, key) && object(base[key])) merge(base[key] as Obj, value, sources, source, path);
    else {
      setOwn(base, key, value !== null && typeof value === 'object' ? structuredClone(value) : value);
      for (const leaf of leafPaths(value, path)) setOwn(sources, leaf, source);
    }
  }
}

/** The date is inclusive: a rule with until=2026-10-29 remains active through that UTC day. */
function removeExpired(input: Obj, now: Date, warnings: string[], prefix = ''): void {
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path === 'credits.grants' && Array.isArray(value)) {
      input[key] = value.filter(grant => {
        if ((grant as { expires: string }).expires >= now.toISOString().slice(0, 10)) return true;
        warnings.push(`${path} ${String((grant as { account: string }).account)} expired on ${String((grant as { expires: string }).expires)}; ignored`);
        return false;
      });
      continue;
    }
    if (!object(value)) continue;
    if (typeof value.until === 'string' && date(value.until) && value.until < now.toISOString().slice(0, 10)) {
      delete input[key];
      warnings.push(`${path} expired on ${value.until}; ignored`);
    } else removeExpired(value, now, warnings, path);
  }
}

export function loadLlmPolicy(opts: LoadLlmPolicyOptions = {}): LoadedLlmPolicy {
  const configDir = opts.configDir ?? getElanousConfigDir();
  const path = opts.path ?? join(configDir, 'policy', 'llm.yaml');
  const policy = defaultLlmPolicy();
  const sources: Record<string, LlmPolicySource> = Object.fromEntries(leafPaths(policy).map(p => [p, 'default']));
  const warnings: string[] = [];
  const errors: string[] = [];
  let legacy: unknown = opts.legacyConfig;
  if (legacy === undefined) {
    const legacyPath = join(configDir, 'config.json');
    try { legacy = JSON.parse(readFileSync(legacyPath, 'utf8')); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        warnings.push(`legacy config ${legacyPath} could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
      legacy = {};
    }
  }
  if (object(legacy)) {
    const llm = object(legacy.llm) ? legacy.llm : {};
    const overlay: Obj = {};
    const add = (key: string, value: unknown, target: Obj, targetKey: string, valid: (v: unknown) => boolean): void => {
      if (value === undefined) return;
      if (valid(value)) { setOwn(target, targetKey, value); warnings.push(`legacy config ${key} applies; migrate to policy/llm.yaml`); }
      else warnings.push(`legacy config ${key} is invalid; ignored`);
    };
    const base: Obj = {};
    add('llm.provider', llm.provider, base, 'provider', v => nonempty(v) && RUNTIME_LLM_PROVIDER_NAMES.some(p => p === v));
    add('llm.model', llm.model, base, 'model', nonempty);
    if (Object.keys(base).length) overlay.default = base;
    add('roleLlm', legacy.roleLlm, overlay, 'roles', v => object(v) && Object.entries(v).every(([r, spec]) => MODEL_ROLES.some(k => k === r) && parseRoleLlmEntry(spec).ok));
    add('llm.fallbackChain', llm.fallbackChain, overlay, 'fallback', v => Array.isArray(v) && v.length > 0 && v.every(isFallbackStep) && new Set(v).size === v.length);
    const codex: Obj = {};
    add('llm.codexAccountOrder', llm.codexAccountOrder, codex, 'order', v => Array.isArray(v) && v.every(nonempty));
    add('llm.codexAccountRotation', llm.codexAccountRotation, codex, 'rotationEnabled', v => typeof v === 'boolean');
    add('llm.codexAccountRotationThresholdPercent', llm.codexAccountRotationThresholdPercent, codex, 'rotateAtPercent', percent);
    if (object(llm.codexAccountRotationThresholdPercentByAccount)) {
      const rows: Obj = {};
      for (const [account, value] of Object.entries(llm.codexAccountRotationThresholdPercentByAccount)) {
        add(`llm.codexAccountRotationThresholdPercentByAccount.${account}`, value, rows, account, percent);
        if (Object.hasOwn(rows, account)) setOwn(rows, account, { rotateAtPercent: rows[account] });
      }
      if (Object.keys(rows).length) codex.perAccount = rows;
    }
    if (Object.keys(codex).length) overlay.accounts = { codex };
    const credits: Obj = {};
    if (llm.codexQuotaPolicy !== undefined) {
      if (isCodexQuotaPolicy(llm.codexQuotaPolicy)) {
        credits.codex = { credits: 'use', fallback: 'fallback', 'within-quota': 'never' }[llm.codexQuotaPolicy];
        warnings.push('legacy config llm.codexQuotaPolicy applies; migrate to policy/llm.yaml');
      } else warnings.push('legacy config llm.codexQuotaPolicy is invalid; ignored');
    }
    if (credits.codex === undefined && llm.codexCreditsAllowed === true) {
      credits.codex = 'use';
      warnings.push('legacy config llm.codexCreditsAllowed applies; migrate to policy/llm.yaml');
    }
    if (Object.keys(credits).length) overlay.credits = credits;
    const gate = object(legacy.harness) && object(legacy.harness.budgetGate) ? legacy.harness.budgetGate : {};
    const caps: Obj = {};
    const harness: Obj = {};
    add('harness.budgetGate.minHeadroomPercent', gate.minHeadroomPercent, harness, 'headroom', percent);
    if (object(gate.maxUsedPercent)) {
      add('harness.budgetGate.maxUsedPercent.openai-codex', gate.maxUsedPercent['openai-codex'], harness, 'harness', percent);
      const grok: Obj = {};
      add('harness.budgetGate.maxUsedPercent.grok', gate.maxUsedPercent.grok, grok, 'weekly', percent);
      if (Object.keys(grok).length) caps.grok = grok;
    }
    if (Object.keys(harness).length) caps.codex = harness;
    if (Object.keys(caps).length) overlay.caps = caps;
    merge(policy as unknown as Obj, overlay, sources, 'legacy-config');
  }
  // Read directly: `existsSync` is also false when the folder cannot be searched (EACCES), which would
  // report an unreadable policy as «no file · valid». Only ENOENT/ENOTDIR mean the file is absent.
  let raw: string | undefined;
  let filePresent = false;
  try {
    raw = readFileSync(path, 'utf8');
    filePresent = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      filePresent = true;
      errors.push(`cannot read policy file ${path}: ${code ?? (error instanceof Error ? error.message : String(error))}`);
    }
  }
  if (raw !== undefined) {
    try {
      const doc = parseDocument(raw, { uniqueKeys: true });
      if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join('; '));
      const emptyDocument = doc.contents === null || (isScalar(doc.contents) && doc.contents.type === 'PLAIN' && doc.contents.source === '');
      const parsed: unknown = emptyDocument ? {} : doc.toJS();
      const validation = validateLlmPolicy(parsed);
      errors.push(...validation.errors);
      warnings.push(...validation.warnings);
      if (validation.valid && object(parsed)) {
        const filtered = structuredClone(parsed);
        removeExpired(filtered, opts.now ?? new Date(), warnings);
        merge(policy as unknown as Obj, filtered, sources, 'file');
      }
    } catch (error) {
      errors.push(`invalid policy file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { policy, sources, path, filePresent, valid: errors.length === 0, errors, warnings };
}
