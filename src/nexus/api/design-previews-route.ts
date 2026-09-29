// NEXUS · GET /v1/design-previews and GET /v1/design-previews/<system>
//
// RFC design loop §A2 — HTML previews written under
// `<repo>/design/previews/<system>.html`. The repository is the same one
// `GET /v1/design-check` reads (`resolveDesignRepository`). Preview HTML is
// untrusted agent output: this route only returns the file bytes. The PWA
// paints them in a sandboxed iframe with no scripts and no same-origin.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { debug } from '../../debug/log.js';
import {
  designCheckLiveDeps,
  resolveDesignRepository,
} from './design-check.js';
import { jsonResponse } from './json-response.js';
import { DESIGN_PREVIEW_PATH_PREFIX, DESIGN_PREVIEWS_PATH } from './rest-route-paths.js';

/** `<system>.html` — system id is the stem of this pattern. */
export const PREVIEW_FILE_RE = /^[a-z0-9][a-z0-9-]*\.html$/;
export const PREVIEW_SYSTEM_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 512 KiB. Larger documents are refused rather than streamed into the PWA. */
export const PREVIEW_MAX_BYTES = 512 * 1024;

export interface DesignPreviewEntry {
  system: string;
  bytes: number;
  modifiedAt: string;
}

export interface DesignPreviewsRouteDeps {
  resolveRepository: () => { repoRoot: string | null; repoSource: 'config' | 'cwd' | null };
  readdir: (path: string) => string[];
  stat: (path: string) => { size: number; mtimeMs: number };
  readFile: (path: string) => string;
  realpath: (path: string) => string;
}

const liveDeps: DesignPreviewsRouteDeps = {
  resolveRepository: () => resolveDesignRepository(designCheckLiveDeps),
  readdir: (path) => readdirSync(path),
  stat: (path) => {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  },
  readFile: (path) => readFileSync(path, 'utf8'),
  realpath: (path) => realpathSync(path),
};

function previewsDir(repoRoot: string): string {
  return join(repoRoot, 'design', 'previews');
}

function isInsidePreviews(previewsRoot: string, candidate: string): boolean {
  const root = previewsRoot.endsWith(sep) ? previewsRoot : previewsRoot + sep;
  return candidate === previewsRoot || candidate.startsWith(root);
}

export function listDesignPreviews(
  overrides: Partial<DesignPreviewsRouteDeps> = {},
): { repoRoot: string | null; repoSource: 'config' | 'cwd' | null; previews: DesignPreviewEntry[] } {
  const deps = { ...liveDeps, ...overrides };
  const { repoRoot, repoSource } = deps.resolveRepository();
  if (!repoRoot) {
    debug.log('design.previews', 'listed', { repoRoot, reason: 'no-repository' });
    return { repoRoot, repoSource, previews: [] };
  }
  const dir = previewsDir(repoRoot);
  let names: string[];
  try {
    names = deps.readdir(dir);
  } catch {
    debug.log('design.previews', 'listed', { repoRoot, reason: 'no-directory' });
    return { repoRoot, repoSource, previews: [] };
  }
  // The list must not reveal what serving refuses: a link that escapes
  // design/previews/ would otherwise leak its target's size and time here.
  let rootReal: string | null = null;
  try { rootReal = resolve(deps.realpath(dir)); } catch { rootReal = null; }
  const previews: DesignPreviewEntry[] = [];
  for (const name of names) {
    if (!PREVIEW_FILE_RE.test(name)) continue;
    const file = join(dir, name);
    let fileReal: string;
    try { fileReal = resolve(deps.realpath(file)); }
    catch { continue; }
    if (!rootReal || !isInsidePreviews(rootReal, fileReal)) continue;
    let st: { size: number; mtimeMs: number };
    try { st = deps.stat(fileReal); }
    catch { continue; }
    previews.push({
      system: name.slice(0, -'.html'.length),
      bytes: st.size,
      modifiedAt: new Date(st.mtimeMs).toISOString(),
    });
  }
  previews.sort((a, b) => a.system.localeCompare(b.system));
  debug.log('design.previews', 'listed', { repoRoot });
  return { repoRoot, repoSource, previews };
}

export type ServePreviewResult =
  | { status: 200; body: { system: string; html: string } }
  | { status: 400 | 404 | 413; body: { error: string; reason: string } };

export function serveDesignPreview(
  system: string,
  overrides: Partial<DesignPreviewsRouteDeps> = {},
): ServePreviewResult {
  const deps = { ...liveDeps, ...overrides };
  const { repoRoot } = deps.resolveRepository();
  if (!PREVIEW_SYSTEM_RE.test(system) || system.includes('..') || system.includes('/') || system.includes('\\')) {
    debug.log('design.previews', 'refused', { repoRoot, system, reason: 'bad-name' });
    return { status: 400, body: { error: 'bad-name', reason: 'bad-name' } };
  }
  if (!repoRoot) {
    debug.log('design.previews', 'refused', { repoRoot, system, reason: 'no-repository' });
    return { status: 404, body: { error: 'not-found', reason: 'no-repository' } };
  }
  const dir = previewsDir(repoRoot);
  let rootReal: string;
  try { rootReal = deps.realpath(dir); }
  catch {
    debug.log('design.previews', 'refused', { repoRoot, system, reason: 'not-found' });
    return { status: 404, body: { error: 'not-found', reason: 'not-found' } };
  }
  const file = join(dir, `${system}.html`);
  let fileReal: string;
  try { fileReal = deps.realpath(file); }
  catch {
    debug.log('design.previews', 'refused', { repoRoot, system, reason: 'not-found' });
    return { status: 404, body: { error: 'not-found', reason: 'not-found' } };
  }
  if (!isInsidePreviews(resolve(rootReal), resolve(fileReal))) {
    debug.log('design.previews', 'refused', { repoRoot, system, reason: 'escape' });
    return { status: 404, body: { error: 'not-found', reason: 'escape' } };
  }
  let st: { size: number; mtimeMs: number };
  try { st = deps.stat(fileReal); }
  catch {
    debug.log('design.previews', 'refused', { repoRoot, system, reason: 'not-found' });
    return { status: 404, body: { error: 'not-found', reason: 'not-found' } };
  }
  if (st.size > PREVIEW_MAX_BYTES) {
    debug.log('design.previews', 'refused', { repoRoot, system, reason: 'too-large' });
    return { status: 413, body: { error: 'too-large', reason: 'too-large' } };
  }
  let html: string;
  try { html = deps.readFile(fileReal); }
  catch {
    debug.log('design.previews', 'refused', { repoRoot, system, reason: 'not-found' });
    return { status: 404, body: { error: 'not-found', reason: 'not-found' } };
  }
  debug.log('design.previews', 'served', { repoRoot, system });
  return { status: 200, body: { system, html } };
}

function systemFromPath(pathname: string): string | null {
  if (pathname === DESIGN_PREVIEWS_PATH) return null;
  if (!pathname.startsWith(DESIGN_PREVIEW_PATH_PREFIX)) return null;
  const raw = pathname.slice(DESIGN_PREVIEW_PATH_PREFIX.length);
  if (!raw || raw.includes('/')) return '';
  try { return decodeURIComponent(raw); }
  catch { return raw; }
}

/** GET dispatcher. Auth is the shared `/v1` owner gate in http-server. */
export function handleDesignPreviews(pathname: string, overrides: Partial<DesignPreviewsRouteDeps> = {}): Response {
  if (pathname === DESIGN_PREVIEWS_PATH) {
    return jsonResponse(listDesignPreviews(overrides), 200);
  }
  const system = systemFromPath(pathname);
  if (system === null || system === '') {
    const { repoRoot } = (overrides.resolveRepository ?? liveDeps.resolveRepository)();
    debug.log('design.previews', 'refused', { repoRoot, reason: 'bad-name' });
    return jsonResponse({ error: 'bad-name', reason: 'bad-name' }, 400);
  }
  const result = serveDesignPreview(system, overrides);
  return jsonResponse(result.body, result.status);
}
