#!/usr/bin/env bun
/**
 * Vendor OpenDesign's style design systems into `docs/design/systems/<id>/` (byte-for-byte).
 *
 *   bun scripts/design/vendor-open-design-systems.ts [--source ~/source/ref/open-design] [--check]
 *
 * Takes only style families (by manifest `category`) and never brand-named systems — a customer
 * project must not be dressed in another company's brand (RFC-design-selection-loop §A1).
 * Copies DESIGN.md · tokens.css · manifest.json per system, plus OpenDesign's LICENSE, and writes
 * SOURCE.json (source commit, date, list). Systems no longer selected are removed.
 * `--check` writes nothing and exits 1 when the vendored copy differs from the source.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Style families only — brand/industry categories (AI & LLM, Fintech & Crypto, Automotive …) stay out. */
export const STYLE_CATEGORIES: ReadonlySet<string> = new Set([
  'Modern & Minimal',
  'Bold & Expressive',
  'Morphism & Effects',
  'Layout & Structure',
  'Retro & Nostalgic',
  'Creative & Artistic',
  'Professional & Corporate',
  'Starter',
]);

/** Named after a company's own design language even inside a style category. */
export const DENIED_IDS: ReadonlySet<string> = new Set(['ant', 'material', 'lingo', 'levels']);

export const VENDORED_FILES = ['DESIGN.md', 'tokens.css', 'manifest.json'] as const;

export interface SystemManifest { id: string; name: string; category: string }

export function selectStyleSystems(manifests: readonly SystemManifest[]): SystemManifest[] {
  return manifests
    .filter((m) => STYLE_CATEGORIES.has(m.category) && !DENIED_IDS.has(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readManifests(systemsDir: string): SystemManifest[] {
  const out: SystemManifest[] = [];
  for (const id of readdirSync(systemsDir)) {
    const path = join(systemsDir, id, 'manifest.json');
    if (!existsSync(path)) continue;
    const m = JSON.parse(readFileSync(path, 'utf8')) as Partial<SystemManifest>;
    if (m.id && m.name && m.category && VENDORED_FILES.every((f) => existsSync(join(systemsDir, id, f)))) {
      out.push({ id: m.id, name: m.name, category: m.category });
    }
  }
  return out;
}

function main(): number {
  const argv = process.argv.slice(2);
  const sourceArg = argv.includes('--source') ? argv[argv.indexOf('--source') + 1] : undefined;
  const source = resolve(sourceArg ?? join(homedir(), 'source/ref/open-design'));
  const check = argv.includes('--check');
  const systemsDir = join(source, 'design-systems');
  if (!existsSync(systemsDir)) { console.error(`no design-systems/ under ${source}`); return 2; }
  const commit = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const selected = selectStyleSystems(readManifests(systemsDir));
  const out = resolve('docs/design/systems');

  const drift: string[] = [];
  for (const s of selected) {
    for (const f of VENDORED_FILES) {
      const from = join(systemsDir, s.id, f);
      const to = join(out, s.id, f);
      const same = existsSync(to) && readFileSync(to).equals(readFileSync(from));
      if (!same) drift.push(`${s.id}/${f}`);
      if (!check && !same) { mkdirSync(join(out, s.id), { recursive: true }); cpSync(from, to); }
    }
  }
  const keep = new Set(selected.map((s) => s.id));
  const stale = existsSync(out) ? readdirSync(out).filter((d) => existsSync(join(out, d, 'manifest.json')) && !keep.has(d)) : [];
  drift.push(...stale.map((d) => `${d}/ (no longer selected)`));

  if (check) {
    console.log(drift.length === 0 ? `ok · ${selected.length} systems match ${commit.slice(0, 10)}` : `drift ${drift.length}:\n  ${drift.join('\n  ')}`);
    return drift.length === 0 ? 0 : 1;
  }
  for (const d of stale) rmSync(join(out, d), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(source, 'LICENSE'), join(out, 'LICENSE'));
  writeFileSync(join(out, 'SOURCE.json'), `${JSON.stringify({
    repo: 'https://github.com/nexu-io/open-design',
    commit,
    syncedAt: new Date().toISOString().slice(0, 10),
    license: 'Apache-2.0',
    selection: { categories: [...STYLE_CATEGORIES], deniedIds: [...DENIED_IDS], files: VENDORED_FILES },
    systems: selected,
  }, null, 2)}\n`);
  console.log(`vendored ${selected.length} systems from ${commit.slice(0, 10)} · changed files ${drift.length} · removed ${stale.length}`);
  return 0;
}

if (import.meta.main) process.exit(main());
