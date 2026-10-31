import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { evaluateOverlayCondition, parseOverlayCondition } from './graph-overlay-condition.js';
import type { GraphParseIssue } from './graph-yaml.js';

/** L1 profile: a deterministic state bundle and references to already-declared overlays. */
export interface GraphProfileSpec {
  readonly profileId: string;
  readonly appliesWhen: string;
  readonly state: Readonly<Record<string, string | number | boolean>>;
  readonly overlays: readonly string[];
}

export interface GraphProfileParseResult {
  readonly profile?: GraphProfileSpec;
  readonly errors: readonly GraphParseIssue[];
}

export function parseGraphProfileYaml(source: string, label = '<inline>'): GraphProfileParseResult {
  let raw: unknown;
  try { raw = parseYaml(source); }
  catch (error) {
    return { errors: [{ path: label, message: `YAML 파싱 실패: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { errors: [{ path: label, message: 'YAML 최상위가 맵이 아니다' }] };
  const doc = raw as Record<string, unknown>;
  const errors: GraphParseIssue[] = [];
  const profileId = typeof doc.profile_id === 'string' && /^[a-z][a-z0-9-]*$/.test(doc.profile_id) ? doc.profile_id : undefined;
  if (!profileId) errors.push({ path: `${label}/profile_id`, message: 'profile_id는 소문자·숫자·하이픈 식별자여야 한다' });
  const appliesWhen = typeof doc.applies_when === 'string' ? doc.applies_when : undefined;
  if (!appliesWhen || !parseOverlayCondition(appliesWhen).ok)
    errors.push({ path: `${label}/applies_when`, message: 'applies_when은 오버레이 조건 한 개(key op literal)여야 한다' });
  const stateRaw = doc.state;
  const state: Record<string, string | number | boolean> = {};
  if (!stateRaw || typeof stateRaw !== 'object' || Array.isArray(stateRaw)) {
    errors.push({ path: `${label}/state`, message: 'state는 스칼라 값만 담는 맵이어야 한다' });
  } else {
    for (const [key, value] of Object.entries(stateRaw as Record<string, unknown>)) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(key) || !['string', 'number', 'boolean'].includes(typeof value)
        || (typeof value === 'number' && !Number.isFinite(value))) {
        errors.push({ path: `${label}/state/${key}`, message: 'state 키와 값은 조건 파서가 다루는 키·문자열·유한수·불리언이어야 한다' });
      } else state[key] = value as string | number | boolean;
    }
  }
  const overlaysRaw = doc.overlays;
  const overlays = Array.isArray(overlaysRaw) ? overlaysRaw.filter((value): value is string => typeof value === 'string') : undefined;
  if (!Array.isArray(overlaysRaw) || !overlays || overlays.length !== overlaysRaw.length || new Set(overlays).size !== overlays.length)
    errors.push({ path: `${label}/overlays`, message: 'overlays는 중복 없는 문자열 목록이어야 한다' });
  if (errors.length > 0) return { errors };
  return { profile: { profileId: profileId!, appliesWhen: appliesWhen!, state, overlays: overlays! }, errors };
}

export interface GraphProfileLoadResult {
  readonly profiles: readonly GraphProfileSpec[];
  readonly errors: readonly GraphParseIssue[];
  readonly scannedFiles: number;
}

export function loadGraphProfiles(dir: string): GraphProfileLoadResult {
  let files: string[];
  try { files = readdirSync(dir).filter((file) => file.endsWith('.yaml') || file.endsWith('.yml')).sort(); }
  catch (error) { return { profiles: [], errors: [{ path: dir, message: `프로필 디렉토리를 못 읽었다: ${error instanceof Error ? error.message : String(error)}` }], scannedFiles: 0 }; }
  const errors: GraphParseIssue[] = [];
  const profiles: GraphProfileSpec[] = [];
  for (const file of files) {
    try {
      const parsed = parseGraphProfileYaml(readFileSync(join(dir, file), 'utf8'), file);
      errors.push(...parsed.errors);
      if (parsed.profile) profiles.push(parsed.profile);
    } catch (error) { errors.push({ path: file, message: `읽기 실패: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (seen.has(profile.profileId)) errors.push({ path: `${dir}/${profile.profileId}`, message: `profile_id '${profile.profileId}'가 중복이다` });
    seen.add(profile.profileId);
  }
  return errors.length ? { profiles: [], errors, scannedFiles: files.length } : { profiles, errors, scannedFiles: files.length };
}

export function defaultProfilesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'graphs', 'profiles');
}

export interface GraphProfileSelection {
  readonly applied: readonly GraphProfileSpec[];
  readonly errors: readonly string[];
  readonly state: Readonly<Record<string, unknown>>;
}

/** Match all profiles deterministically; conflicting owned state rejects the whole profile set. */
export function selectGraphProfiles(
  profiles: readonly GraphProfileSpec[],
  state: Readonly<Record<string, unknown>>,
): GraphProfileSelection {
  const applied = profiles.filter((profile) => evaluateOverlayCondition(profile.appliesWhen, state).kind === 'applies');
  const owned = new Map<string, string | number | boolean>();
  const errors: string[] = [];
  for (const profile of applied) for (const [key, value] of Object.entries(profile.state)) {
    if (owned.has(key) && owned.get(key) !== value) errors.push(`profile state conflict: ${key} (${String(owned.get(key))} vs ${String(value)})`);
    else owned.set(key, value);
  }
  if (errors.length) return { applied: [], errors, state };
  return { applied, errors, state: { ...state, ...Object.fromEntries(owned) } };
}
