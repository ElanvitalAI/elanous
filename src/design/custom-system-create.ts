// CLI 와 POST /v1/design-system 이 같이 부르는 한 곳.
// 추출·승격·저장은 기존 모듈을 부르기만 한다. 못 읽은 토큰 값은 지어내지 않는다.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { elanousStateRoot } from '../autopilot/state-paths.js';
import { libraryDir, reservedDesignIds, saveCustomSystem } from './design-library.js';
import { defaultDesignSystemsDir } from './design-systems.js';
import {
  promoteExtractToSystem,
  promotePaletteToSystem,
  type ExtractTokensJson,
  type PromotedSystem,
} from './system-from-extract.js';
import type { ExtractDesignOptions, ExtractDesignResult } from '../webclone/extract-design-run.js';

const ID_PATTERN = /^[a-z0-9-]+$/;
const UNREAD_MARK = '원본에서 못 읽었다';

export interface CustomSystemToken {
  readonly token: string;
  readonly value: string;
  readonly from: string;
}

export interface CustomSystemCreated {
  readonly ok: true;
  readonly id: string;
  readonly dir: string;
  readonly tokens: readonly CustomSystemToken[];
  readonly unread: number;
  readonly warnings: readonly string[];
  readonly extractDir?: string;
  readonly system: PromotedSystem;
}

export interface CustomSystemRefused {
  readonly ok: false;
  readonly reason: 'bad-url' | 'bad-id' | 'id-taken' | 'extract-failed' | 'no-colors';
  readonly detail?: string;
}

export type CustomSystemCreateResult = CustomSystemCreated | CustomSystemRefused;

export interface CreateCustomSystemFromUrlInput {
  readonly url: string;
  readonly id?: string;
  readonly name?: string;
  readonly base?: string;
  readonly out?: string;
}

export interface CreateCustomSystemFromPaletteInput {
  readonly colors: readonly string[];
  readonly id: string;
  readonly name?: string;
  readonly base?: string;
}

export interface CustomSystemCreateDeps {
  readonly libraryDirectory?: () => string;
  readonly systemsDirectory?: () => string;
  readonly extractRoot?: () => string;
  readonly readFile?: (path: string, encoding: 'utf8') => string;
  readonly runExtractDesign?: (options: ExtractDesignOptions) => Promise<ExtractDesignResult>;
  readonly promoteExtract?: typeof promoteExtractToSystem;
  readonly promotePalette?: typeof promotePaletteToSystem;
  readonly save?: typeof saveCustomSystem;
  readonly reservedIds?: (systemsDir: string) => ReadonlySet<string>;
  readonly takenIds?: (libraryDir: string) => ReadonlySet<string>;
}

export function hostSlugFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.replace(/^www\./i, '').split('.')[0] ?? '';
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || null;
}

export function unreadTokenCount(tokensCss: string): number {
  return tokensCss.split('\n').filter((line) => line.includes(UNREAD_MARK)).length;
}

function defaultTakenIds(dir: string): ReadonlySet<string> {
  if (!existsSync(dir)) return new Set();
  try {
    return new Set(
      readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

function allocateId(
  requested: string | undefined,
  fallback: string | null,
  taken: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): { id: string } | CustomSystemRefused {
  const raw = requested?.trim() || fallback || '';
  if (!raw || !ID_PATTERN.test(raw)) return { ok: false, reason: 'bad-id', detail: raw || undefined };
  if (requested?.trim()) {
    if (taken.has(raw) || reserved.has(raw)) return { ok: false, reason: 'id-taken', detail: raw };
    return { id: raw };
  }
  if (!taken.has(raw) && !reserved.has(raw)) return { id: raw };
  for (let n = 2; n < 10_000; n += 1) {
    const next = `${raw}-${n}`;
    if (!taken.has(next) && !reserved.has(next)) return { id: next };
  }
  return { ok: false, reason: 'id-taken', detail: raw };
}

function created(system: PromotedSystem, dir: string, extractDir?: string): CustomSystemCreated {
  return {
    ok: true,
    id: system.manifest.id,
    dir,
    tokens: system.provenance.map((row) => ({ token: row.token, value: row.value, from: row.from })),
    unread: unreadTokenCount(system.tokensCss),
    warnings: system.warnings,
    ...(extractDir === undefined ? {} : { extractDir }),
    system,
  };
}

function refusalFromSave(error: unknown, id: string): CustomSystemRefused {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes('겹친다') || detail.includes('id 거부') || detail.includes('EEXIST')) {
    return { ok: false, reason: 'id-taken', detail: id };
  }
  return { ok: false, reason: 'extract-failed', detail };
}

export async function createCustomSystemFromUrl(
  input: CreateCustomSystemFromUrlInput,
  deps: CustomSystemCreateDeps = {},
): Promise<CustomSystemCreateResult> {
  const url = input.url.trim();
  const slug = hostSlugFromUrl(url);
  if (!slug) return { ok: false, reason: 'bad-url', detail: url || undefined };

  const systemsDir = (deps.systemsDirectory ?? defaultDesignSystemsDir)();
  const library = (deps.libraryDirectory ?? libraryDir)();
  const reserved = (deps.reservedIds ?? reservedDesignIds)(systemsDir);
  const taken = (deps.takenIds ?? defaultTakenIds)(library);
  const allocated = allocateId(input.id, slug, taken, reserved);
  if ('ok' in allocated) return allocated;

  const outRoot = input.out ?? (deps.extractRoot ?? (() => join(elanousStateRoot(), 'design', 'extracts')))();
  const extract = deps.runExtractDesign ?? (await import('../webclone/extract-design-run.js')).runExtractDesign;
  let extracted: ExtractDesignResult;
  try {
    extracted = await extract({ url, outRoot, withAssets: false });
  } catch (error) {
    return { ok: false, reason: 'extract-failed', detail: error instanceof Error ? error.message : String(error) };
  }

  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  let tokens: ExtractTokensJson;
  try {
    tokens = JSON.parse(readFile(join(extracted.outDir, 'tokens.json'), 'utf8')) as ExtractTokensJson;
  } catch (error) {
    return { ok: false, reason: 'extract-failed', detail: error instanceof Error ? error.message : String(error) };
  }

  const promote = deps.promoteExtract ?? promoteExtractToSystem;
  const name = input.name?.trim() || allocated.id;
  let system: PromotedSystem;
  try {
    system = promote(tokens, {
      id: allocated.id,
      name,
      sourceUrl: url,
      base: input.base,
      systemsDir,
    });
  } catch (error) {
    return { ok: false, reason: 'extract-failed', detail: error instanceof Error ? error.message : String(error) };
  }

  try {
    const saved = (deps.save ?? saveCustomSystem)(library, system, { systemsDir });
    return created(system, saved.dir, extracted.outDir);
  } catch (error) {
    return refusalFromSave(error, allocated.id);
  }
}

export async function createCustomSystemFromPalette(
  input: CreateCustomSystemFromPaletteInput,
  deps: CustomSystemCreateDeps = {},
): Promise<CustomSystemCreateResult> {
  const colors = input.colors.map((color) => color.trim()).filter(Boolean);
  if (colors.length === 0) return { ok: false, reason: 'no-colors' };

  const systemsDir = (deps.systemsDirectory ?? defaultDesignSystemsDir)();
  const library = (deps.libraryDirectory ?? libraryDir)();
  const reserved = (deps.reservedIds ?? reservedDesignIds)(systemsDir);
  const taken = (deps.takenIds ?? defaultTakenIds)(library);
  const allocated = allocateId(input.id, null, taken, reserved);
  if ('ok' in allocated) return allocated;

  const promote = deps.promotePalette ?? promotePaletteToSystem;
  const name = input.name?.trim() || allocated.id;
  let system: PromotedSystem;
  try {
    system = promote(colors, { id: allocated.id, name, base: input.base, systemsDir });
  } catch (error) {
    return { ok: false, reason: 'no-colors', detail: error instanceof Error ? error.message : String(error) };
  }
  if (system.provenance.length === 0) return { ok: false, reason: 'no-colors' };

  try {
    const saved = (deps.save ?? saveCustomSystem)(library, system, { systemsDir });
    return created(system, saved.dir);
  } catch (error) {
    return refusalFromSave(error, allocated.id);
  }
}
