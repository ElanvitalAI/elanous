// OP-CURRENT-VERSION-AWARE (0.3.35 P0, owner TC-H-CC-2) — the dashboard's version pointer must follow the
// *current* release. After a publish, package.json still names the previous release (0.3.34-dev.0 while 0.3.35
// is open), so the operating dashboard and the retro kept measuring the published release instead of the current
// one. The resolver decides: ① a PLAN front-matter `status: current` ② the newest release_schedules row newer
// than releasedVersion() ③ the stripped package version (no regression). A published result carries «⚠ 발행
// 완료 판» so OP sees the stale-plan alarm instead of quietly measuring a shipped release.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { compareVersions, resolveCurrentVersion } from './current-version.js';
import { buildDashboard, retroDashboardLines, versionProbe, writeSnapshot, type ProbeContext } from './operating-dashboard.js';
import { formatSeatRetroPrompt } from '../seat/seat-retro.js';

const NOW = new Date('2026-11-24T10:08:00.000Z');
const probeCtx = (over: Partial<ProbeContext> = {}): Omit<ProbeContext, 'metrics'> => ({
  now: NOW, version: '0.3.35', hqRoot: '/nonexistent-hq',
  run: async () => { throw new Error('no run'); },
  eln: async () => { throw new Error('no eln'); },
  ...over,
});

function writePlan(plansDir: string, version: string, status: string, theme: string, roster: number): void {
  writeFileSync(join(plansDir, `PLAN-${version}.md`), [
    '---', 'audience: internal', 'layer: L1.5-plan', `version: ${version}`, `status: ${status}`, '---',
    `# PLAN-${version} — ${theme}`, '', `## 로스터 (${roster} 칸 · release checklist ${version} 와 자동 대조)`, '- CELL-A(OWNER·🟡)', '',
  ].join('\n'));
}

function writeLedger(root: string, published: ReadonlyArray<{ version: string; publishedAt: string }>, schedules: ReadonlyArray<{ version: string; cutAt: string; publishAt: string | null }>): void {
  mkdirSync(join(root, 'release'), { recursive: true });
  for (const { version, publishedAt } of published) {
    mkdirSync(join(root, 'release', version), { recursive: true });
    writeFileSync(join(root, 'release', version, 'release.json'), `${JSON.stringify({ version, publishedAt })}\n`);
  }
  const db = new Database(join(root, 'release', 'features.sqlite'), { create: true, strict: true });
  try {
    db.exec('CREATE TABLE release_schedules (version TEXT PRIMARY KEY, cut_at TEXT NOT NULL, land_by TEXT, freeze_from TEXT, freeze_until TEXT, publish_at TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)');
    for (const row of schedules)
      db.query('INSERT INTO release_schedules (version, cut_at, land_by, freeze_from, freeze_until, publish_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.version, row.cutAt, null, null, null, row.publishAt, '2026-11-24T08:00:00.000Z', 'OP');
  } finally { db.close(); }
}

describe('OP-CURRENT-VERSION-AWARE current-version resolver', () => {
  test('① a PLAN front-matter status: current wins over plans, schedules and the package version', () => {
    const hq = mkdtempSync(join(tmpdir(), 'opcv-')); const ledger = mkdtempSync(join(tmpdir(), 'opcv-ledger-'));
    try {
      const plansDir = join(hq, 'seat-state', 'OP', 'plans'); mkdirSync(plansDir, { recursive: true });
      writePlan(plansDir, '0.3.35', 'shipped', '가볍고 믿을 수 있는 자율 운영', 66);
      writePlan(plansDir, '0.3.36', 'current', '자율 운영 자가 진단', 12);
      writeLedger(ledger, [{ version: '0.3.35', publishedAt: '2026-11-24T09:00:00.000Z' }], [
        { version: '0.3.35', cutAt: '2026-11-24T08:30:00.000Z', publishAt: '2026-11-25T09:00:00.000Z' },
        { version: '0.3.36', cutAt: '2026-11-24T08:30:00.000Z', publishAt: '2026-11-25T09:00:00.000Z' },
        { version: '0.3.37', cutAt: '2026-11-26T08:30:00.000Z', publishAt: null },
      ]);
      const r = resolveCurrentVersion({ hqRoot: hq, ledgerRoot: ledger, packageVersion: '0.3.35-dev.0' });
      expect(r.version).toBe('0.3.36');
      expect(r.source).toBe('plan');
      expect(r.theme).toBe('자율 운영 자가 진단');
      expect(r.rosterCount).toBe(12);
      expect(r.published).toBe(false);
      expect(r.schedule).toEqual({ cutAt: '2026-11-24T08:30:00.000Z', landBy: null, publishAt: '2026-11-25T09:00:00.000Z' });
    } finally { rmSync(hq, { recursive: true, force: true }); rmSync(ledger, { recursive: true, force: true }); }
  });

  test('② without a current plan, the newest schedule row newer than the published release wins', () => {
    const hq = mkdtempSync(join(tmpdir(), 'opcv-')); const ledger = mkdtempSync(join(tmpdir(), 'opcv-ledger-'));
    try {
      const plansDir = join(hq, 'seat-state', 'OP', 'plans'); mkdirSync(plansDir, { recursive: true });
      writePlan(plansDir, '0.3.34', 'shipped', '계약 지킴', 60);
      writeLedger(ledger, [{ version: '0.3.34', publishedAt: '2026-11-20T08:00:00.000Z' }], [
        { version: '0.3.34', cutAt: '2026-11-19T08:30:00.000Z', publishAt: '2026-11-20T08:00:00.000Z' },
        { version: '0.3.35', cutAt: '2026-11-24T08:30:00.000Z', publishAt: null },
      ]);
      const r = resolveCurrentVersion({ hqRoot: hq, ledgerRoot: ledger, packageVersion: '0.3.34-dev.3' });
      expect(r.version).toBe('0.3.35');
      expect(r.source).toBe('schedule');
      expect(r.theme).toBeNull();
      expect(r.rosterCount).toBeNull();
      expect(r.published).toBe(false);
      expect(r.schedule).toEqual({ cutAt: '2026-11-24T08:30:00.000Z', landBy: null, publishAt: null });
    } finally { rmSync(hq, { recursive: true, force: true }); rmSync(ledger, { recursive: true, force: true }); }
  });

  test('③ without a plan or a newer schedule, the stripped package version stands (no regression)', () => {
    const hq = mkdtempSync(join(tmpdir(), 'opcv-')); const ledger = mkdtempSync(join(tmpdir(), 'opcv-ledger-'));
    try {
      writeLedger(ledger, [{ version: '0.3.33', publishedAt: '2026-11-15T08:00:00.000Z' }], [
        { version: '0.3.33', cutAt: '2026-11-14T08:30:00.000Z', publishAt: '2026-11-15T08:00:00.000Z' },
      ]);
      const r = resolveCurrentVersion({ hqRoot: hq, ledgerRoot: ledger, packageVersion: '0.3.34-dev.7' });
      expect(r).toEqual({ version: '0.3.34', source: 'package', theme: null, rosterCount: null, schedule: null, published: false });
    } finally { rmSync(hq, { recursive: true, force: true }); rmSync(ledger, { recursive: true, force: true }); }
  });

  test('판정식: 0.3.35 published + PLAN-0.3.36 current → the retro input version is 0.3.36, not the published one', async () => {
    const hq = mkdtempSync(join(tmpdir(), 'opcv-')); const ledger = mkdtempSync(join(tmpdir(), 'opcv-ledger-'));
    const dir = mkdtempSync(join(tmpdir(), 'opcv-dash-'));
    try {
      const plansDir = join(hq, 'seat-state', 'OP', 'plans'); mkdirSync(plansDir, { recursive: true });
      writePlan(plansDir, '0.3.36', 'current', '자율 운영 자가 진단', 12);
      writeLedger(ledger, [{ version: '0.3.35', publishedAt: '2026-11-24T09:00:00.000Z' }], [
        { version: '0.3.35', cutAt: '2026-11-24T08:30:00.000Z', publishAt: '2026-11-24T09:00:00.000Z' },
        { version: '0.3.36', cutAt: '2026-11-25T09:00:00.000Z', publishAt: null },
      ]);
      const current = resolveCurrentVersion({ hqRoot: hq, ledgerRoot: ledger, packageVersion: '0.3.35-dev.0' });
      expect(current.version).toBe('0.3.36');
      expect(current.source).toBe('plan');
      const s = await buildDashboard({
        ctx: probeCtx({ version: current.version, hqRoot: hq, current }),
        probes: [{ axis: '판', probe: versionProbe }],
        previous: null, ledgerLines: [],
      });
      writeSnapshot(join(hq, 'seat-state', 'OP', 'dashboard'), s);
      const prompt = formatSeatRetroPrompt({ seat: 'OP', intervalMin: 60, metrics: retroDashboardLines(join(hq, 'seat-state', 'OP', 'dashboard'), NOW) });
      expect(prompt).toContain('판: 0.3.36 (plan) · 테마 자율 운영 자가 진단 · 컷 2026-11-25 09:00Z · 로스터 12 칸');
      expect(prompt).not.toContain('판: 0.3.35');
    } finally { rmSync(hq, { recursive: true, force: true }); rmSync(ledger, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
  });

  test('⚠ a resolver result that is already published is marked «발행 완료 판» on the 판 row', async () => {
    const hq = mkdtempSync(join(tmpdir(), 'opcv-')); const ledger = mkdtempSync(join(tmpdir(), 'opcv-ledger-'));
    try {
      const plansDir = join(hq, 'seat-state', 'OP', 'plans'); mkdirSync(plansDir, { recursive: true });
      writePlan(plansDir, '0.3.35', 'current', '가볍고 믿을 수 있는 자율 운영', 66);
      writeLedger(ledger, [{ version: '0.3.35', publishedAt: '2026-11-24T09:00:00.000Z' }], [
        { version: '0.3.35', cutAt: '2026-11-24T08:30:00.000Z', publishAt: '2026-11-24T09:00:00.000Z' },
      ]);
      const current = resolveCurrentVersion({ hqRoot: hq, ledgerRoot: ledger, packageVersion: '0.3.35-dev.0' });
      expect(current.version).toBe('0.3.35');
      expect(current.published).toBe(true);
      const r = await versionProbe(probeCtx({ version: current.version, hqRoot: hq, current }) as ProbeContext);
      expect(r.value).toBe('0.3.35 (plan) · ⚠ 발행 완료 판 · 테마 가볍고 믿을 수 있는 자율 운영 · 컷 2026-11-24 08:30Z · 발행 2026-11-24 09:00Z · 로스터 66 칸');
    } finally { rmSync(hq, { recursive: true, force: true }); rmSync(ledger, { recursive: true, force: true }); }
  });

  test('compareVersions orders bare releases above their previews and sorts numerically', () => {
    expect(compareVersions('0.3.36', '0.3.35')).toBeGreaterThan(0);
    expect(compareVersions('0.3.10', '0.3.9')).toBeGreaterThan(0);
    expect(compareVersions('0.3.35', '0.3.35-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('0.3.35-rc.2', '0.3.35-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('0.3.35', '0.3.35')).toBe(0);
  });
});

// ONE-TARGET (11-27 · SEAT-ASSIGN-GUARD): PLAN-0.3.37.md still said `status: current` while release.graph.version was 0.3.38,
// so the resource steward assigned 35 cells of 0.3.37. The graph target now wins; the plan mark is the fallback.
describe('release.graph.version is the one target', () => {
  test('graph 0.3.38 beats a stale plan 0.3.37 «current»; unset graph → the plan mark still decides', () => {
    const hq = mkdtempSync(join(tmpdir(), 'cv-graph-'));
    try {
      const plans = join(hq, 'seat-state', 'OP', 'plans'); mkdirSync(plans, { recursive: true });
      writePlan(plans, '0.3.37', 'current', 'old theme', 40);
      writePlan(plans, '0.3.38', 'draft', 'graph foundation', 31);
      const ledger = join(hq, 'ledger');
      expect(resolveCurrentVersion({ hqRoot: hq, ledgerRoot: ledger, graphVersion: '0.3.38' })).toMatchObject({ version: '0.3.38', source: 'graph', theme: 'graph foundation', rosterCount: 31 });
      expect(resolveCurrentVersion({ hqRoot: hq, ledgerRoot: ledger, graphVersion: null })).toMatchObject({ version: '0.3.37', source: 'plan', theme: 'old theme' });
      expect(resolveCurrentVersion({ hqRoot: hq, ledgerRoot: ledger, graphVersion: '0.3.39' })).toMatchObject({ version: '0.3.39', source: 'graph', theme: null, rosterCount: null });
    } finally { rmSync(hq, { recursive: true, force: true }); }
  });
});
