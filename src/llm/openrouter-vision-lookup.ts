// ── VISION-CATALOG-BUILTIN · OpenRouter 모델 메타데이터 조회(비전 사실) ──
//
// 대표 2026-11-25 «이미지는 모든 공급자에서 된다». 종전 OpenRouter 비전 판정은 발견 스냅숏
// (`discovery-snapshot.json`)만 봤다 — 스냅숏이 없는 시험 우주에선 opus-5.5 도 text-only 로 읽혀
// 이미지가 `[image: … (model not vision-capable)]` 자리표시로 바뀌었다(실측 smoke 11-25).
//
// 이 파일 = «모르는» 모델만 공급자 메타데이터(`GET /api/v1/models` 의 `architecture.input_modalities`)로
// 한 번 묻고, 답을 `<config-dir>/openrouter-vision-cache.json` 에 적어 다음 프로세스도 쓰게 한다.
// - 판정 순서(llm-vision-capability.ts): 카탈로그 사실 → 내장 표 → 이 캐시 → 모른다(false).
// - 핫패스(`cachedOpenRouterVision`)는 동기 · 할당 최소. 네트워크는 `lookupOpenRouterVision` 만.
// - 실패는 조용히 «모른다»(undefined) — 10분 동안 다시 묻지 않는다(매 턴 4초 지연 방지).
// ⛔ 키를 싣지 않는다 — 이 목록은 공개 API 다(인증 없음).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_VISION_CACHE_FILE = 'openrouter-vision-cache.json';
/** 캐시 신선도 — 이보다 오래되면 «모르는» 모델을 만났을 때 다시 묻는다(아는 값은 계속 쓴다). */
export const OPENROUTER_VISION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 4_000;

interface VisionCacheFile { version: 1; fetchedAt: string; vision: Record<string, boolean> }

let memory: Map<string, boolean> | null = null;
let memoryFetchedAt = 0;
let memoryPath: string | null = null;
let lastFailureAt = 0;
let inflight: Promise<void> | null = null;

/** `openrouter/anthropic/claude-sonnet-5:batch` → `anthropic/claude-sonnet-5`. */
export function normalizeOpenRouterUpstreamId(model: string): string {
  return model.trim().toLowerCase().replace(/^openrouter\//, '').replace(/:[a-z0-9_-]+$/, '');
}

/** 캐시 파일 경로. 시험 런타임(NODE_ENV=test)은 «명시» 경로만 쓴다 — 기계마다 다른 운영 캐시를 읽지 않는다. */
export function openRouterVisionCachePath(): string | null {
  const explicit = process.env.ELANOUS_OPENROUTER_VISION_CACHE?.trim();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === 'test') return null;
  return join(getElanousConfigDir(), OPENROUTER_VISION_CACHE_FILE);
}

/** `/api/v1/models` 본문 → id → 이미지 입력 가능 여부. 모양이 틀리면 빈 맵. */
export function parseOpenRouterModelsVision(body: unknown): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    const id = (item as { id?: unknown })?.id;
    const mods = (item as { architecture?: { input_modalities?: unknown } })?.architecture?.input_modalities;
    if (typeof id !== 'string' || !Array.isArray(mods)) continue;
    const key = normalizeOpenRouterUpstreamId(id);
    if (out.has(key)) continue;
    out.set(key, mods.includes('image'));
  }
  return out;
}

function loadFromDisk(path: string): void {
  memoryPath = path;
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as VisionCacheFile;
    if (!raw || typeof raw.vision !== 'object' || raw.vision === null) return;
    memory = new Map(Object.entries(raw.vision).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'));
    const at = Date.parse(raw.fetchedAt);
    memoryFetchedAt = Number.isFinite(at) ? at : 0;
  } catch { /* 깨진 캐시 = 빈 캐시 */ }
}

function ensureLoaded(): void {
  const path = openRouterVisionCachePath();
  if (path === null || path === memoryPath) return;
  loadFromDisk(path);
}

/** 동기 조회 — 조회해 둔 사실이 있으면 true/false, 없으면 undefined(모른다). */
export function cachedOpenRouterVision(model: string): boolean | undefined {
  ensureLoaded();
  return memory?.get(normalizeOpenRouterUpstreamId(model));
}

export interface OpenRouterVisionLookupDeps {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/**
 * 모르는 모델이면 OpenRouter 공개 목록을 한 번 받아 캐시를 채우고 답한다. 동시 호출은 한 요청을 나눠 쓴다.
 * 반환 = true/false(사실) 또는 undefined(목록에 없음·조회 실패).
 */
export async function lookupOpenRouterVision(model: string, deps: OpenRouterVisionLookupDeps = {}): Promise<boolean | undefined> {
  const now = deps.now ?? Date.now;
  const known = cachedOpenRouterVision(model);
  const fresh = memory !== null && now() - memoryFetchedAt < OPENROUTER_VISION_CACHE_TTL_MS;
  if (known !== undefined || fresh) return known;
  // 유닛 시험 런타임은 주입한 fetch 가 없으면 네트워크로 나가지 않는다(전역 fetch 가짜의 호출 수를 흔들지 않는다).
  if (!deps.fetch && process.env.NODE_ENV === 'test' && !process.env.ELANOUS_OPENROUTER_VISION_CACHE) return undefined;
  if (lastFailureAt && now() - lastFailureAt < FAILURE_BACKOFF_MS) return undefined;
  if (!inflight) {
    inflight = (async () => {
      const doFetch = deps.fetch ?? globalThis.fetch;
      const started = now();
      try {
        const res = await doFetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseOpenRouterModelsVision(await res.json());
        if (parsed.size === 0) throw new Error('empty model list');
        memory = parsed;
        memoryFetchedAt = now();
        lastFailureAt = 0;
        const path = openRouterVisionCachePath();
        if (path) {
          try {
            mkdirSync(dirname(path), { recursive: true });
            const tmp = `${path}.tmp-${process.pid}`;
            const file: VisionCacheFile = { version: 1, fetchedAt: new Date(memoryFetchedAt).toISOString(), vision: Object.fromEntries(parsed) };
            writeFileSync(tmp, JSON.stringify(file));
            renameSync(tmp, path);
            memoryPath = path;
          } catch (error) {
            debug.log('llm.vision', 'openrouter-vision-cache-write-failed', { error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
          }
        }
        debug.log('llm.vision', 'openrouter-vision-lookup', { models: parsed.size, ms: now() - started });
      } catch (error) {
        lastFailureAt = now();
        debug.log('llm.vision', 'openrouter-vision-lookup-failed', { error: error instanceof Error ? error.message : String(error), ms: now() - started }, { level: 'warn' });
      }
    })().finally(() => { inflight = null; });
  }
  await inflight;
  return cachedOpenRouterVision(model);
}

/** Test-only: 모듈 상태를 비운다. */
export function __resetOpenRouterVisionLookupForTests(): void {
  memory = null;
  memoryFetchedAt = 0;
  memoryPath = null;
  lastFailureAt = 0;
  inflight = null;
}
