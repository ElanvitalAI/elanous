import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildInstalledPackQueryTool, dispatchInstalledPackQuery } from './installed-pack-query.js';

// 출처: #37807 remote registry-import acceptance budget; child must stop before the 30s outer test deadline.
const PACK_SURFACE_CHILD_TIMEOUT_MS = 25_000;

test('pack surface validates its actual dispatcher boundary before invoking legacy vault-capable code', async () => {
  let calls = 0;
  let packOnly = false;
  const execute: NonNullable<Parameters<typeof dispatchInstalledPackQuery>[1]> = async (_input, options) => {
    calls++; packOnly = options?.trustedPackOnly === true; throw new Error('synthetic-private-detail');
  };
  for (const args of [{}, { question: '' }, { question: 'design', fulltext: 'synthetic' },
    { question: 'design', tags: [] }, { question: 'design', kind: 'note' }, { question: 'design', include_body: true }]) {
    expect((await dispatchInstalledPackQuery(args, execute)).reason).toBe('invalid-pack-query');
  }
  expect(calls).toBe(0);
  const failed = await dispatchInstalledPackQuery({ question: 'design' }, execute);
  expect(failed.reason).toBe('pack-search-failed');
  expect(packOnly).toBe(true);
  expect(failed.output).not.toContain('synthetic-private-detail');
  expect(buildInstalledPackQueryTool().parameters).toMatchObject({
    required: ['question'], additionalProperties: false,
    properties: { question: { type: 'string' }, pack_id: { type: 'string' } },
  });
});

test('actual Next and daemon catalogs hydrate and consume cited packs without reading or creating a vault', () => {
  const taskRoot = mkdtempSync(join(tmpdir(), 'pack-surface-'));
  const repoRoot = resolve(import.meta.dir, '../..');
  const existingVault = join(taskRoot, 'synthetic-vault');
  const missingVault = join(taskRoot, 'absent-vault');
  mkdirSync(existingVault);
  writeFileSync(join(existingVault, 'marker.md'), '---\nkind: note\n---\nSYNTHETIC-VAULT-MARKER');
  const script = [
    'import { buildReplTools } from ' + JSON.stringify(join(repoRoot, 'src/repl/index.ts')) + ';',
    'import { toolSurface } from ' + JSON.stringify(join(repoRoot, 'src/boot/daemon-tools/index.ts')) + ';',
    'import { takeHydratedTools } from ' + JSON.stringify(join(repoRoot, 'src/skills/tools/tool-search-spec.ts')) + ';',
    'import { existsSync } from "node:fs";',
    'const existing = ' + JSON.stringify(existingVault) + ';',
    'const missing = ' + JSON.stringify(missingVault) + ';',
    'const records = [];',
    'for (const kind of ["next", "chat", "webterm"]) {',
    '  process.env.ELANOUS_OBSIDIAN_VAULT = existing;',
    '  const surface = kind === "next" ? buildReplTools() : toolSurface(kind);',
    '  const ctx = { cwd: process.cwd(), signal: new AbortController().signal };',
    '  const selected = await surface.dispatch("ToolSearch", { query: "select:KnowledgeQuery" }, ctx);',
    '  const design = await surface.dispatch("KnowledgeQuery", { question: "Design frontend backend database architecture for a concert ticketing application" }, ctx);',
    '  const unrelated = await surface.dispatch("KnowledgeQuery", { question: "unrelated weather alert, no architecture design requested" }, ctx);',
    '  const forbidden = await surface.dispatch("KnowledgeQuery", { question: "design", fulltext: "SYNTHETIC-VAULT-MARKER" }, ctx);',
    '  process.env.ELANOUS_OBSIDIAN_VAULT = missing;',
    '  const noPack = await surface.dispatch("KnowledgeQuery", { question: "weather alert only" }, ctx);',
    '  records.push({ kind, count: surface.specs.filter(tool => tool.name === "KnowledgeQuery").length,',
    '    hydrated: takeHydratedTools(selected).map(tool => tool.name),',
    '    citations: design.pack_hits?.length ?? 0, consumed: design.output.includes("["),',
    '    unrelated: unrelated.total, forbidden: forbidden.reason, noPack: noPack.total, reason: noPack.reason,',
    '    markerRead: JSON.stringify([unrelated, forbidden, noPack]).includes("SYNTHETIC-VAULT-MARKER"),',
    '    vaultCreated: existsSync(missing) });',
    '}',
    'console.log("PACK_SURFACE_RESULT=" + JSON.stringify(records));',
  ].join('\n');
  try {
    const result = spawnSync(process.execPath, ['--eval', script], {
      cwd: taskRoot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: taskRoot,
        CODEX_HOME: join(taskRoot, 'codex'), ELANOUS_STATE_DIR: join(taskRoot, 'state'),
        TMPDIR: taskRoot, TERM: 'dumb',
      },
      // Actual child imports the production registry on shared remote gate pods.
      timeout: PACK_SURFACE_CHILD_TIMEOUT_MS, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const line = result.stdout.split('\n').find(value => value.startsWith('PACK_SURFACE_RESULT='));
    expect(line).toBeDefined();
    const records = JSON.parse(line!.slice('PACK_SURFACE_RESULT='.length));
    expect(records.map((record: { kind: string }) => record.kind)).toEqual(['next', 'chat', 'webterm']);
    for (const record of records) {
      expect(record.count).toBe(1);
      expect(record.hydrated).toEqual(['KnowledgeQuery']);
      expect(record.citations).not.toBe(0);
      expect(record.consumed).toBe(true);
      expect(record.unrelated).toBe(0);
      expect(record.forbidden).toBe('invalid-pack-query');
      expect(record.noPack).toBe(0);
      expect(record.reason).toBeTruthy();
      expect(record.markerRead).toBe(false);
      expect(record.vaultCreated).toBe(false);
    }
  } finally { rmSync(taskRoot, { recursive: true, force: true }); }
}, 30_000);
