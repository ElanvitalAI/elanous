// Persona yaml loader — pure parse + validate.
//
// PLAN: 내부 문서 `PLAN-discord-rich-light-persona-2026-05-01` §3.2 (M2.1)
//
// Reads a single yaml file (or yaml string) and returns either a
// PersonaProfile or a structured PersonaLoadError. Pure function —
// no fs / chokidar / registry concerns (those live in registry.ts).

import { parse as parseYaml } from 'yaml';
import type {
  PersonaBrand, PersonaCapabilities, PersonaCapabilityEvidence, PersonaLoadError,
  PersonaModels, PersonaProfile, PersonaResidence,
} from './types.js';

const VALID_BRANDS: ReadonlySet<PersonaBrand> = new Set([
  'claude', 'codex', 'gemini', 'elanous-as-child', 'local-llm', 'auto',
]);

/** 🏠 거처 — RFC §25e. ⛔ 「어느 화면(browserPort)」과 «다른 축»이다. */
const VALID_RESIDENCES: ReadonlySet<PersonaResidence> = new Set(['vm', 'local']);

/** ⛔ 「돌려 봤다」를 기본으로 두지 않는다 — 기본은 늘 «덜 아는» 쪽이다. */
const VALID_EVIDENCE: ReadonlySet<PersonaCapabilityEvidence> = new Set(['declared', 'measured']);

/** Parse + validate a yaml string for a single persona file.
 *  `path` is included in any returned error for diagnostics. */
export function parsePersonaYaml(
  yamlText: string,
  path: string,
): { ok: true; profile: PersonaProfile } | { ok: false; error: PersonaLoadError } {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err: unknown) {
    return { ok: false, error: {
      code: 'parse', path,
      message: `yaml parse failed: ${err instanceof Error ? err.message : String(err)}`,
    } };
  }
  return validatePersonaShape(parsed, path);
}

/** Validate the parsed object matches PersonaProfile. Returns either
 *  a frozen profile or a structured error. */
export function validatePersonaShape(
  raw: unknown,
  path: string,
): { ok: true; profile: PersonaProfile } | { ok: false; error: PersonaLoadError } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err(path, 'top level must be a yaml mapping');
  }
  const obj = raw as Record<string, unknown>;

  // Required: personaId, displayName.
  const personaId = obj['personaId'];
  if (typeof personaId !== 'string' || !personaId.trim()) {
    return err(path, 'personaId must be a non-empty string');
  }
  if (!/^[a-z0-9_][a-z0-9_-]*$/i.test(personaId)) {
    return err(path, `personaId '${personaId}' must match /^[a-z0-9_][a-z0-9_-]*$/i`);
  }
  const displayName = obj['displayName'];
  if (typeof displayName !== 'string' || !displayName.trim()) {
    return err(path, 'displayName must be a non-empty string');
  }

  // Optional fields with type-guards.
  const description = optString(obj, 'description', path);
  if (description.kind === 'err') return { ok: false, error: description.err };

  const systemPrompt = optString(obj, 'systemPrompt', path);
  if (systemPrompt.kind === 'err') return { ok: false, error: systemPrompt.err };

  const avatarUrl = optString(obj, 'avatarUrl', path);
  if (avatarUrl.kind === 'err') return { ok: false, error: avatarUrl.err };

  const brandColor = optString(obj, 'brandColor', path);
  if (brandColor.kind === 'err') return { ok: false, error: brandColor.err };

  const browserPort = optPort(obj, 'browserPort', path);
  if (browserPort.kind === 'err') return { ok: false, error: browserPort.err };

  // 🚧⭐ 행동 경계. ⛔⛔ ***이 로더는 키를 «하나씩 명시로» 옮긴다*** —
  //    타입에 필드를 더하는 것만으로는 ***YAML 의 그 줄이 영영 안 읽힌다.***
  //    📏 2026-08-28 실물: 그래서 경계를 선언했는데 조작이 «그대로 통과»했다(막힌 줄 알았다).
  //    ⇒ 📌 「타입에 있다」와 「파서가 읽는다」는 다른 값이다.
  let actionHosts: readonly string[] | undefined;
  if (obj['actionHosts'] !== undefined) {
    const raw = obj['actionHosts'];
    if (!Array.isArray(raw) || raw.some((h) => typeof h !== 'string')) {
      return err(path, 'actionHosts must be a list of host strings');
    }
    // ⛔ 빈 항목을 조용히 담지 않는다 — 「선언했는데 아무것도 안 무는」 경계가 된다.
    const cleaned = (raw as string[]).map((h) => h.trim()).filter((h) => h !== '');
    if (cleaned.length === 0) return err(path, 'actionHosts was declared but empty — 선언했으면 «무엇»인지 적어라');
    actionHosts = Object.freeze(cleaned);
  }

  // 🆕 목적지를 미리 못 적는 봇의 칸. ⛔ 위 주석의 그 이유로 ***여기에도 명시로 옮긴다***.
  let offsiteNavigation: 'blocked' | 'allowed' | undefined;
  if (obj['offsiteNavigation'] !== undefined) {
    const raw = obj['offsiteNavigation'];
    if (raw !== 'blocked' && raw !== 'allowed') {
      return err(path, "offsiteNavigation must be 'blocked' or 'allowed'");
    }
    offsiteNavigation = raw;
  }

  // 🏠 거처 ⊕ 능력 두 층. ⛔ 위 `actionHosts` 주석이 못 박은 그 이유로 ***여기에 명시로 옮긴다*** —
  //    타입에만 더하면 YAML 의 그 줄은 영영 안 읽힌다.
  let residence: PersonaResidence | undefined;
  if (obj['residence'] !== undefined) {
    if (typeof obj['residence'] !== 'string' || !VALID_RESIDENCES.has(obj['residence'] as PersonaResidence)) {
      return err(path, `residence must be one of ${[...VALID_RESIDENCES].join('|')}`);
    }
    residence = obj['residence'] as PersonaResidence;
  }

  let capabilities: PersonaCapabilities | undefined;
  if (obj['capabilities'] !== undefined) {
    const cr = validateCapabilities(obj['capabilities'], path);
    if ('err' in cr) return { ok: false, error: cr.err };
    capabilities = cr.capabilities;
  }

  let brand: PersonaBrand | undefined;
  if (obj['brand'] !== undefined) {
    if (typeof obj['brand'] !== 'string' || !VALID_BRANDS.has(obj['brand'] as PersonaBrand)) {
      return err(path, `brand must be one of ${[...VALID_BRANDS].join('|')}`);
    }
    brand = obj['brand'] as PersonaBrand;
  }

  let models: PersonaModels | undefined;
  if (obj['models'] !== undefined) {
    const mr = validateModels(obj['models'], path);
    if ('err' in mr) return { ok: false, error: mr.err };
    models = mr.models;
  }

  let seat: string | undefined;
  if (Object.hasOwn(obj, 'seat')) {
    if (typeof obj['seat'] !== 'string' || !obj['seat'].trim()) {
      return err(path, 'seat must be a non-empty string');
    }
    seat = obj['seat'];
  }

  let todo: string | undefined;
  if (Object.hasOwn(obj, 'todo')) {
    if (typeof obj['todo'] !== 'string' || !/^[a-z0-9_][a-z0-9_-]*\.todo\.jsonl$/i.test(obj['todo'])) {
      return err(path, 'todo must be a per-persona .todo.jsonl filename');
    }
    todo = obj['todo'];
  }

  let mentionPatterns: readonly string[] | undefined;
  if (obj['mentionPatterns'] !== undefined) {
    if (!Array.isArray(obj['mentionPatterns'])
        || !obj['mentionPatterns'].every((s) => typeof s === 'string' && s.length > 0)) {
      return err(path, 'mentionPatterns must be an array of non-empty strings');
    }
    mentionPatterns = obj['mentionPatterns'] as string[];
  }

  const profile: PersonaProfile = {
    personaId, displayName,
    ...(seat !== undefined ? { seat } : {}),
    ...(todo !== undefined ? { todo } : {}),
    ...(description.value !== undefined ? { description: description.value } : {}),
    ...(systemPrompt.value !== undefined ? { systemPrompt: systemPrompt.value } : {}),
    ...(brand !== undefined ? { brand } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(mentionPatterns !== undefined ? { mentionPatterns } : {}),
    ...(avatarUrl.value !== undefined ? { avatarUrl: avatarUrl.value } : {}),
    ...(brandColor.value !== undefined ? { brandColor: brandColor.value } : {}),
    ...(browserPort.value !== undefined ? { browserPort: browserPort.value } : {}),
    ...(actionHosts !== undefined ? { actionHosts } : {}),
    ...(offsiteNavigation !== undefined ? { offsiteNavigation } : {}),
    ...(residence !== undefined ? { residence } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
  return { ok: true, profile: Object.freeze(profile) };
}

function optString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): { kind: 'ok'; value: string | undefined } | { kind: 'err'; err: PersonaLoadError } {
  const v = obj[key];
  if (v === undefined || v === null) return { kind: 'ok', value: undefined };
  if (typeof v === 'string') return { kind: 'ok', value: v };
  return { kind: 'err', err: { code: 'invalid-shape', path, message: `${key} must be a string if present` } };
}

function optPort(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): { kind: 'ok'; value: number | undefined } | { kind: 'err'; err: PersonaLoadError } {
  const value = obj[key];
  if (value === undefined || value === null) return { kind: 'ok', value: undefined };
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535) {
    return { kind: 'ok', value };
  }
  return { kind: 'err', err: { code: 'invalid-shape', path, message: `${key} must be an integer from 1 to 65535 if present` } };
}

/**
 * 능력 두 층을 검증한다.
 *
 * ⛔⭐ 여기서 «거절»하는 것 넷이 이 함수의 값이다:
 *   ⓐ `core` 를 안 적었다        — 선언했으면 「혼자 되는 것」이 무엇인지 말해야 한다
 *   ⓑ `core` 가 비었다            — 「없다」와 「안 적었다」를 같은 값으로 만들지 않는다
 *   ⓒ 같은 능력이 «양쪽»에 있다   — 그러면 「맥이 죽으면 되나」에 답이 «둘»이 된다
 *   ⓓ `evidence` 가 모르는 값     — 「무엇으로 알았나」를 짐작으로 채우지 않는다
 */
function validateCapabilities(
  raw: unknown,
  path: string,
): { capabilities: PersonaCapabilities } | { err: PersonaLoadError } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { err: errObj(path, 'capabilities must be a mapping with core/extended') };
  }
  const obj = raw as Record<string, unknown>;
  const list = (key: string): string[] | null => {
    const v = obj[key];
    if (v === undefined) return null;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null;
    return (v as string[]).map((x) => x.trim()).filter((x) => x !== '');
  };
  if (obj['core'] === undefined) {
    return { err: errObj(path, 'capabilities.core is required — 선언했으면 «혼자 되는 것»을 적어라') };
  }
  const core = list('core');
  if (core === null) return { err: errObj(path, 'capabilities.core must be a list of strings') };
  let extended: string[] | undefined;
  if (obj['extended'] !== undefined) {
    const ext = list('extended');
    if (ext === null) return { err: errObj(path, 'capabilities.extended must be a list of strings') };
    extended = ext;
  }
  // ⛔⭐ `core: []` 를 «허용한다» — 실물에 그런 봇이 있다:
  //    📏 RFC §25c — `assistant` 는 VM 에 `gws` 가 «없어서» 그 거처 단독으로 ***아무것도 못 한다***.
  //    그것은 결손이 아니라 ***사실***이고, 표현할 수 없으면 그 봇은 영영 선언되지 못한다.
  //    ⇒ 대신 ***둘 다 비는 것***만 거부한다 — 그것은 「없다」가 아니라 「안 적었다」이다.
  if (core.length === 0 && (extended === undefined || extended.length === 0)) {
    return { err: errObj(path,
      'capabilities: core 와 extended 가 «둘 다» 비었다 — 「능력이 없다」가 아니라 「안 적었다」로 읽힌다. '
      + '그 거처에서 혼자 되는 것이 정말 하나도 없으면 core: [] 를 두고 extended 를 적어라') };
  }
  // ⛔ 겹치면 「맥이 죽어도 되나」에 답이 둘이 된다 — 이름을 대고 거절한다.
  const overlap = (extended ?? []).filter((x) => core.includes(x));
  if (overlap.length > 0) {
    return { err: errObj(path, `capabilities: core 와 extended 에 «같은» 능력이 있다 — ${overlap.join(', ')}`) };
  }
  let evidence: PersonaCapabilityEvidence | undefined;
  if (obj['evidence'] !== undefined) {
    if (typeof obj['evidence'] !== 'string' || !VALID_EVIDENCE.has(obj['evidence'] as PersonaCapabilityEvidence)) {
      return { err: errObj(path, `capabilities.evidence must be one of ${[...VALID_EVIDENCE].join('|')}`) };
    }
    evidence = obj['evidence'] as PersonaCapabilityEvidence;
  }
  return { capabilities: Object.freeze({
    core: Object.freeze(core),
    ...(extended !== undefined ? { extended: Object.freeze(extended) } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  }) };
}

function errObj(path: string, message: string): PersonaLoadError {
  return { code: 'invalid-shape', path, message };
}

function validateModels(raw: unknown, path: string): { models: PersonaModels } | { err: PersonaLoadError } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { err: { code: 'invalid-shape', path, message: 'models must be a mapping' } };
  }
  const m = raw as Record<string, unknown>;
  if (typeof m['primary'] !== 'string' || !m['primary']) {
    return { err: { code: 'invalid-shape', path, message: 'models.primary must be a non-empty string' } };
  }
  let fallback: readonly string[] | undefined;
  if (m['fallback'] !== undefined) {
    if (!Array.isArray(m['fallback']) || !m['fallback'].every((s) => typeof s === 'string')) {
      return { err: { code: 'invalid-shape', path, message: 'models.fallback must be an array of strings' } };
    }
    fallback = m['fallback'] as string[];
  }
  let providers: PersonaModels['providers'];
  if (m['providers'] !== undefined) {
    if (m['providers'] === null || typeof m['providers'] !== 'object' || Array.isArray(m['providers'])) {
      return { err: { code: 'invalid-shape', path, message: 'models.providers must be a mapping' } };
    }
    const p = m['providers'] as Record<string, unknown>;
    providers = {};
    if (p['ollama'] !== undefined) {
      const o = p['ollama'] as Record<string, unknown>;
      if (o === null || typeof o !== 'object' || typeof o['model'] !== 'string') {
        return { err: { code: 'invalid-shape', path, message: 'models.providers.ollama.model must be a string' } };
      }
      (providers as { ollama?: { model: string } }).ollama = { model: o['model'] };
    }
    if (p['openai'] !== undefined) {
      const o = p['openai'] as Record<string, unknown>;
      if (o === null || typeof o !== 'object' || typeof o['model'] !== 'string') {
        return { err: { code: 'invalid-shape', path, message: 'models.providers.openai.model must be a string' } };
      }
      (providers as { openai?: { model: string } }).openai = { model: o['model'] };
    }
  }
  const models: PersonaModels = {
    primary: m['primary'] as string,
    ...(fallback !== undefined ? { fallback } : {}),
    ...(providers !== undefined ? { providers } : {}),
  };
  return { models };
}

function err(path: string, message: string): { ok: false; error: PersonaLoadError } {
  return { ok: false, error: { code: 'invalid-shape', path, message } };
}
