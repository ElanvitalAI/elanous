// NEXUS · GET /v1/design-check and POST /v1/design-direction
//
// `elanous repo design-check` already answers "which craft rulebooks does this
// repository's DESIGN.md declare, and which of them cannot be found?" — but
// only into a terminal. This route carries the SAME verdict (resolved by
// `resolveDesignCheck`, not re-derived here) to the PWA, so the browser panel
// and the CLI can never drift apart.
//
// DESIGN.md comes from the configured harness.defaultRepo when present (no
// fallback if it is invalid), otherwise the daemon's checkout. The craft and
// bundled system directories always come from the elanous installation.
// A blocked verdict is still a GET result, not an HTTP error. POST writes are
// authenticated at http-server's /v1 owner-auth gate before this handler runs.

import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { debug } from '../../debug/log.js';
import { applyDesignDirection, type ApplyDesignDirectionResult } from '../../design/apply-direction.js';
import { designCheckExitCode, resolveDesignCheck, type DesignCheckDeps } from '../../design/design-check.js';
import { directionFromDesignMd, listAllDesignDirections, parseDeclaredDirection } from '../../design/design-directions.js';
import { defaultDesignSystemsDir, listDesignSystems } from '../../design/design-systems.js';
import { getUserConfig } from '../../user-config.js';
import { jsonResponse } from './json-response.js';
import { detectRepoRoot } from './worktrees.js';

export interface DesignCheckRouteDeps extends DesignCheckDeps {
  /** Detect a checkout from the configured path, or from the daemon cwd. */
  repoRoot: (cwd?: string) => string | null;
  defaultRepo?: () => string | undefined;
  /** Absolute path of elanous's vendored craft rulebook directory. */
  craftDirectory: () => string;
}

/** Craft rulebooks ship with elanous. Resolved from THIS file's location so a
 *  daemon serving a project outside the elanous tree still finds them —
 *  `src/nexus/api/` → repo root → `docs/design/craft`. */
function installedCraftDirectory(): string {
  return resolve(import.meta.dir, '..', '..', '..', 'docs', 'design', 'craft');
}

export const designCheckLiveDeps: DesignCheckRouteDeps = {
  readFile: (path, encoding) => readFileSync(path, encoding),
  readdir: (path) => readdirSync(path),
  repoRoot: (cwd) => detectRepoRoot(cwd === undefined ? {} : { cwd }),
  defaultRepo: () => getUserConfig().harness?.defaultRepo,
  craftDirectory: installedCraftDirectory,
};

const liveDeps: DesignCheckRouteDeps = designCheckLiveDeps;

export interface DesignDirectionRouteDeps extends DesignCheckRouteDeps {
  applyDirection: typeof applyDesignDirection;
  logSelection: (repoRoot: string, direction: string) => void;
}

const directionDeps: Pick<DesignDirectionRouteDeps, 'applyDirection' | 'logSelection'> = {
  applyDirection: applyDesignDirection,
  logSelection: (repoRoot, direction) => debug.log('nexus.design-direction', 'selected', { repoRoot, direction }),
};

export type DesignRepository = { repoRoot: string | null; repoSource: 'config' | 'cwd' | null };

/** Same repository the design-check verdict reads: harness.defaultRepo, else daemon cwd. */
export function resolveDesignRepository(deps: DesignCheckRouteDeps): DesignRepository {
  const configured = (deps.defaultRepo ?? (() => getUserConfig().harness?.defaultRepo))();
  if (configured !== undefined) {
    return { repoRoot: isAbsolute(configured) ? deps.repoRoot(configured) : null, repoSource: 'config' };
  }
  const repoRoot = deps.repoRoot();
  return { repoRoot, repoSource: repoRoot ? 'cwd' : null };
}

/** Builds the wire body from injected reads. Exported for tests without booting HTTP. */
export function buildDesignCheckView(overrides: Partial<DesignCheckRouteDeps> = {}): Record<string, unknown> {
  const deps = { ...liveDeps, ...overrides };
  const { repoRoot, repoSource } = resolveDesignRepository(deps);
  if (!repoRoot) {
    return { repoRoot: null, repoSource, ok: false, blockedOn: 'no-repository', path: null, exitCode: 1 };
  }
  const outcome = resolveDesignCheck(
    join(repoRoot, 'DESIGN.md'),
    deps.craftDirectory(),
    { readFile: deps.readFile, readdir: deps.readdir },
  );
  const exitCode = designCheckExitCode(outcome);
  if (!outcome.ok) {
    return { repoRoot, repoSource, ok: false, blockedOn: outcome.blockedOn, path: outcome.path, exitCode };
  }
  // B5 — 방향은 «같은 문서»에서 나온다. 두 번째 라우트를 만들면 두 번째
  // 「어느 저장소의 DESIGN.md 인가」 답이 생긴다. 여기서 같이 실어 보낸다.
  //
  // ⛔ 방향을 못 읽는 것은 «전체를 실패로 만들지 않는다» — 규칙집 판정은
  //    독립적으로 유효하고, 방향은 선택이다. 그래서 exitCode 에 안 섞는다.
  let document = '';
  try {
    document = deps.readFile(outcome.documentPath, 'utf8');
  } catch { /* 방금 읽힌 문서다. 사라졌으면 「선언 없음」과 같은 화면이 맞다. */ }
  // Bundled terminal themes and web systems are selectable; a document-defined
  // direction is added only when its declared ID is not already bundled and
  // its palette supplies a usable swatch (never turn a typo into a direction).
  const bundledDirections = listAllDesignDirections();
  const declaredAmongBundled = parseDeclaredDirection(document, bundledDirections);
  const documentDirection = declaredAmongBundled.unavailable === null
    ? null
    : directionFromDesignMd(document, declaredAmongBundled.unavailable);
  const availableDirections = documentDirection === null
    ? bundledDirections
    : [...bundledDirections, documentDirection];
  const systemCategories = new Map(listDesignSystems(defaultDesignSystemsDir()).map((system) => [system.id, system.category]));
  const direction = parseDeclaredDirection(document, availableDirections);

  return {
    repoRoot,
    repoSource,
    ok: true,
    documentPath: outcome.documentPath,
    craftDirectory: outcome.craftDirectory,
    availableRulebooks: outcome.availableRulebooks,
    declaredRulebooks: outcome.declaredRulebooks,
    unavailableRulebooks: outcome.unavailableRulebooks,
    exitCode,
    directions: {
      declared: direction.declared,
      unavailable: direction.unavailable,
      available: availableDirections.map((d) => ({
        id: d.id, label: d.label, mood: d.mood, isDark: d.isDark, isPastel: d.isPastel, swatch: d.swatch,
        source: d.source ?? 'theme', typography: d.typography ?? null,
        category: systemCategories.get(d.id) ?? null,
      })),
    },
  };
}

/** GET /v1/design-check — see top-of-file wire shape. Always 200: a blocked
 *  verdict is a RESULT the panel renders, not a transport failure. Sending
 *  4xx/5xx here would make "your DESIGN.md lists a missing rulebook" look
 *  like the daemon is broken. */
export function handleDesignCheck(): Response {
  return jsonResponse(buildDesignCheckView(), 200);
}

/** The HTTP dispatcher must run owner checkAuth before invoking this write handler. */
export async function handleDesignDirectionPost(
  req: Request,
  overrides: Partial<DesignDirectionRouteDeps> = {},
): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ ok: false, reason: 'invalid-json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof (body as { id?: unknown }).id !== 'string'
    || !(body as { id: string }).id.trim()) {
    return jsonResponse({ ok: false, reason: 'id-required' }, 400);
  }
  const id = (body as { id: string }).id;
  const deps = { ...liveDeps, ...directionDeps, ...overrides };
  const { repoRoot, repoSource } = resolveDesignRepository(deps);
  if (!repoRoot) return jsonResponse({ ok: false, reason: 'no-repository', repoRoot, repoSource }, 409);
  let result: ApplyDesignDirectionResult;
  try { result = deps.applyDirection(join(repoRoot, 'DESIGN.md'), id); }
  catch (error) {
    debug.log('nexus.design-direction', 'failed', { repoRoot, direction: id, error: String(error) }, { level: 'error' });
    return jsonResponse({ ok: false, reason: 'cannot-write' }, 500);
  }
  if (!result.ok) {
    return jsonResponse(result, result.reason === 'unknown-direction' ? 400 : result.reason === 'conflicting-system-file' ? 409 : 500);
  }
  deps.logSelection(repoRoot, id);
  return jsonResponse({ ...result, repoRoot, repoSource }, 200);
}
