import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { composeDaily, main, collectGrid, collectLoops, collectRelease, type DailyDeps, type DailyParts } from './daily.js';
import { devVersion, listChecklist } from '../../src/release-loop/checklist.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../src/elanous-config-dir.js';

const now = new Date('2026-10-05T00:00:00Z');
const parts: DailyParts = {
  landings: { status: 'ok', value: Array.from({ length: 7 }, (_, i) => ({ title: `[MK] 착지 ${i}`, seat: 'MK', mergedAt: '2026-10-04T02:00:00Z' })) },
  release: { status: 'ok', value: { version: '0.2.14', green: 21, total: 21, nextVersion: '0.2.15', nextGreen: 1, nextTotal: 3, cutAt: '2026-10-06T00:00:00Z', red: [] } },
  loops: { status: 'ok', value: [{ name: 'zz-failing', status: 'failing', scope: 'MK' }, { name: 'aa-late', status: 'late' }] },
  grid: { status: 'ok', value: [{ name: 'MK', running: 2, cap: 6, idle: true }] },
  decisions: { status: 'ok', value: [{ name: 'old', openedAt: '2026-10-01T00:00:00Z' }, { name: 'new', openedAt: '2026-10-04T00:00:00Z' }, { name: 'middle', openedAt: '2026-10-03T00:00:00Z' }] },
  news: { status: 'unreadable', reason: 'crawl unavailable' },
};

test('SCQA · six other sections · deterministic top risk and unreadable external trend', () => {
  const result = composeDaily(parts, now);
  expect(result.header.split('\n').map(line => line.slice(0, 2))).toEqual(['S:', 'C:', 'Q:', 'A:']);
  expect(result.risks[0]).toMatchObject({ name: 'zz-failing', score: 3 });
  expect(result.markdown).toContain('## ⑥ 위험 톱 5\n1. zz-failing — 3점');
  for (const name of ['① 어제 착지', '② 판', '③ 루프', '④ 그리드', '⑤ 결정 대기', '⑥ 위험 톱 5']) expect(result.markdown).toContain(name);
  expect(result.markdown).toContain('## ⑦ 외부 동향\n못 읽음 · crawl unavailable');
  expect(result.markdown).toContain('총 7건 · 자리별 MK 7');
  expect(result.markdown).toContain('green 21/21');
  expect(result.markdown).toContain('MK 2/6');
  expect(result.markdown).toContain('3건');
  expect(result.sections.news).toBe('unreadable');
});

test('yesterday landing section uses one bounded line per success, failure and running harness ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-run-summary-'));
  try {
    const dir = join(root, 'self-dev-runs');
    mkdirSync(dir);
    const rawGoal = 'GOAL_ORIGINAL_' + 'x'.repeat(180);
    const prBody = 'PR_BODY_' + 'y'.repeat(180);
    const updatedAt = new Date('2026-10-04T02:00:00Z').getTime();
    const today = new Date('2026-10-05T00:00:00Z').getTime();
    for (const [runId, status, summaryLine] of [
      ['success', 'done', 'CTX-SUCCESS · merged · PR #17'],
      ['failure', 'failed', 'CTX-FAILURE · gate-failed'],
      ['ongoing', 'running', `CTX-ONGOING · ${'z'.repeat(180)}`],
    ] as const) {
      writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId, createdAt: updatedAt, updatedAt: runId === 'success' ? today : updatedAt,
        goals: [{ feature: rawGoal }], results: [
          ...(runId === 'success' ? [{ taskId: 'earlier', feature: rawGoal, status: 'done', prNumber: 16 }] : []),
          { taskId: runId, feature: rawGoal, status, prBody, ...(runId === 'success' ? { prNumber: 17 } : {}) },
        ], summaryLine }));
    }
    const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: false,
      landings: async () => [{ title: rawGoal, seat: 'MK', mergedAt: '2026-10-04T02:00:00Z', prNumber: 17 }], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
      loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [], log: () => {}, print: () => {},
    };
    const review = await main(['--dry-run'], deps);
    const landing = review.markdown.split('## ① 어제 착지\n')[1]!.split('\n\n## ② 판')[0]!;
    const lines = landing.split('\n').filter(line => line.startsWith('CTX-'));
    expect(lines).toHaveLength(3);
    expect(lines).toContain('CTX-SUCCESS · merged · PR #17');
    expect(lines).toContain('CTX-FAILURE · gate-failed');
    expect(lines.find(line => line.startsWith('CTX-ONGOING'))!.length).toBe(120);
    expect(lines.every(line => line.length <= 120)).toBe(true);
    expect(landing).not.toContain(rawGoal);
    expect(landing).not.toContain(prBody);
    expect(landing).not.toContain('z'.repeat(120));
    expect(landing).not.toContain('- ' + rawGoal);
    const baseline = composeDaily({ ...parts, landings: { status: 'ok', value: [{ title: rawGoal, seat: 'MK', mergedAt: '2026-10-04T02:00:00Z', prNumber: 17 }] },
      loops: { status: 'ok', value: [] }, grid: { status: 'ok', value: [] },
      decisions: { status: 'ok', value: [] }, news: { status: 'ok', value: [] } }, now).markdown;
    expect(review.markdown.split('## ② 판\n')[1]).toBe(baseline.split('## ② 판\n')[1]);
    expect(landing.split('\n').slice(0, 2)).toEqual(['총 1건 · 자리별 MK 1', 'CTX-SUCCESS · merged · PR #17']);
    expect(readFileSync(review.file, 'utf8')).toBe(review.markdown);
    const failed = await main(['--dry-run'], { ...deps, landings: async () => { throw new Error('PR collection unavailable'); } });
    const unreadableLanding = failed.markdown.split('## ① 어제 착지\n')[1]!.split('\n\n## ② 판')[0]!;
    expect(failed.sections.landings).toBe('unreadable');
    expect(unreadableLanding).toContain('못 읽음 · PR collection unavailable');
    expect(unreadableLanding.split('\n').filter(line => line.startsWith('CTX-'))).toHaveLength(2);
    expect(unreadableLanding).toContain('CTX-FAILURE · gate-failed');
    expect(unreadableLanding).toContain('CTX-ONGOING');
    expect(unreadableLanding.split('\n').filter(line => line.startsWith('CTX-')).every(line => line.length <= 120)).toBe(true);
    expect(unreadableLanding).not.toContain(rawGoal);
    expect(unreadableLanding).not.toContain(prBody);
    expect(failed.markdown.split('## ② 판\n')[1]).toBe(review.markdown.split('## ② 판\n')[1]);
    const truncated = await main(['--dry-run'], { ...deps, landings: async () => [
      { title: '[MK] unrelated', seat: 'MK', mergedAt: '2026-10-04T02:00:00Z' },
    ] });
    const unmatched = truncated.markdown.split('## ① 어제 착지\n')[1]!.split('\n\n## ② 판')[0]!;
    expect(unmatched.split('\n').filter(line => line.startsWith('CTX-'))).toHaveLength(2);
    expect(unmatched).not.toContain('CTX-SUCCESS');
    expect(unmatched).not.toContain(rawGoal);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two merged PRs from one harness run both replace raw landing titles with the same bounded summary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-two-prs-'));
  try {
    const dir = join(root, 'self-dev-runs');
    mkdirSync(dir);
    const rawGoal = 'GOAL_ORIGINAL_' + 'x'.repeat(180);
    const prBody = 'PR_BODY_' + 'y'.repeat(180);
    const today = new Date('2026-10-05T00:00:00Z').getTime();
    writeFileSync(join(dir, 'two-prs.json'), JSON.stringify({ runId: 'two-prs', createdAt: today, updatedAt: today,
      goals: [{ feature: rawGoal }], results: [
        { taskId: 'first', feature: rawGoal, status: 'done', prNumber: 16, prBody },
        { taskId: 'second', feature: rawGoal, status: 'done', prUrl: 'https://github.com/org/repo/pull/17', prBody },
      ], summaryLine: `CTX-TWO-PRS · ${'s'.repeat(180)}` }));
    const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: false,
      landings: async () => [16, 17].map(prNumber => ({ title: `${rawGoal} #${prNumber} ${prBody}`, seat: 'MK', mergedAt: '2026-10-04T02:00:00Z', prNumber })),
      release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
      loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [], log: () => {}, print: () => {},
    };
    const review = await main(['--dry-run'], deps);
    const landing = review.markdown.split('## ① 어제 착지\n')[1]!.split('\n\n## ② 판')[0]!;
    const lines = landing.split('\n');
    expect(lines[0]).toBe('총 2건 · 자리별 MK 2');
    expect(lines.slice(1)).toHaveLength(2);
    expect(lines[1]).toBe(lines[2]);
    expect(lines[1]!.startsWith('CTX-TWO-PRS · ')).toBe(true);
    expect(lines.slice(1).every(line => line.length <= 120)).toBe(true);
    expect(landing).not.toContain(rawGoal);
    expect(landing).not.toContain(prBody);
    expect(landing).not.toContain('s'.repeat(120));
    expect(review.markdown.split('## ② 판\n')[1]).toBe(composeDaily({ ...parts,
      landings: { status: 'ok', value: [] }, loops: { status: 'ok', value: [] }, grid: { status: 'ok', value: [] },
      decisions: { status: 'ok', value: [] }, news: { status: 'ok', value: [] },
    }, now).markdown.split('## ② 판\n')[1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI --dry-run --json writes KST report after a collector throws, with no send', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-daily-'));
  let sends = 0;
  let output = '';
  let tick: Record<string, unknown> | undefined;
  const deps: DailyDeps = {
    now: () => now, root, vaultRoot: null, sendEnabled: true,
    landings: async () => (parts.landings as Extract<DailyParts['landings'], { status: 'ok' }>).value,
    release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => (parts.loops as Extract<DailyParts['loops'], { status: 'ok' }>).value,
    grid: async () => (parts.grid as Extract<DailyParts['grid'], { status: 'ok' }>).value,
    decisions: async () => (parts.decisions as Extract<DailyParts['decisions'], { status: 'ok' }>).value,
    news: async () => { throw new Error('crawl unavailable'); },
    send: () => { sends++; return true; },
    log: (_category, _event, data) => { tick = data; },
    print: line => { output = line; },
  };
  try {
    const result = await main(['--dry-run', '--json'], deps);
    const file = join(root, 'rhythm', 'daily', '2026-10-05.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(result.markdown);
    expect(result.sections).toMatchObject({ landings: 'ok', release: 'ok', loops: 'ok', grid: 'ok', decisions: 'ok', news: 'unreadable' });
    expect(JSON.parse(output).file).toBe(file);
    expect(JSON.parse(output).markdown).toContain('못 읽음 · crawl unavailable');
    expect(tick).toMatchObject({ risks: 4, sent: false, sections: { news: 'unreadable' } });
    expect(sends).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no-argument grid collector reads the isolated checklist ledger and process observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-grid-'));
  const bin = join(root, 'bin');
  const tree = join(root, 'mk-tree');
  const version = devVersion().replace(/-dev\.\d+$/, '');
  const oldPath = process.env.PATH;
  const oldState = process.env.ELANOUS_STATE_DIR;
  try {
    setElanousConfigDir(root);
    mkdirSync(join(tree, '.claude'), { recursive: true });
    writeFileSync(join(tree, '.claude', 'seat'), 'MK\n');
    mkdirSync(bin);
    mkdirSync(join(root, 'release', version), { recursive: true });
    writeFileSync(join(root, 'release', version, 'checklist.json'), JSON.stringify({ version, released: '', dev: devVersion(),
      items: [
        { id: 'MK-open', title: '오늘 발사', owner: 'MK', status: 'yellow', updatedAt: now.toISOString(), updatedBy: 'MK' },
        { id: 'MK-done', title: '지난 칸', owner: 'MK', status: 'done', updatedAt: now.toISOString(), updatedBy: 'MK' },
      ], history: [] }));
    expect(listChecklist(version).items.map(item => item.id)).toEqual(['MK-open', 'MK-done']);
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nif [ "$1" = "-axo" ]; then\n  printf "501 1 0.0 01:00:00 bun bin/elanous.mjs harness ask one\\n502 1 0.0 00:40:00 bun bin/elanous.mjs harness say two\\n503 1 0.0 00:00:10 bun bin/elanous.mjs harness processes\\n"\nelse\n  exit 1\nfi\n');
    writeFileSync(join(bin, 'lsof'), `#!/bin/sh\nprintf 'p%s\\nn${tree}\\n' "$3"\n`);
    chmodSync(join(bin, 'ps'), 0o755); chmodSync(join(bin, 'lsof'), 0o755);
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    process.env.ELANOUS_STATE_DIR = root;
    const grid = await collectGrid();
    expect(grid.find(seat => seat.name === 'MK')).toEqual({ name: 'MK', running: 2, cap: 6, idle: true, nextCell: 'MK-open 오늘 발사' });
    expect(grid.find(seat => seat.name === 'TC')).toMatchObject({ running: 0, cap: 8, idle: false });
    expect(composeDaily({ ...parts, grid: { status: 'ok', value: grid } }, now).markdown).toContain('노는 자리: MK → MK-open 오늘 발사');
  } finally {
    resetElanousConfigDir();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loop collector keeps each result scope, falling back to CLI-wide scope when absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-loops-'));
  const oldPath = process.env.PATH;
  const oldState = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    writeFileSync(join(root, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(root, 'args.txt')}'\nprintf "{\\"scope\\":\\"graph-only\\",\\"results\\":[{\\"id\\":\\"failing-loop\\",\\"state\\":\\"failing\\",\\"scope\\":\\"MK\\"},{\\"id\\":\\"late-loop\\",\\"state\\":\\"late\\",\\"scope\\":\\"TC\\"},{\\"id\\":\\"legacy-loop\\",\\"state\\":\\"alive\\"}]}\\n"\n`);
    chmodSync(join(root, 'bun'), 0o755);
    process.env.PATH = `${root}:${oldPath ?? ''}`;
    const loops = await collectLoops();
    expect(readFileSync(join(root, 'args.txt'), 'utf8').trim().split('\n')).toEqual(['bin/elanous.mjs', `--test=${root}`, 'loop', 'status', '--all', '--json']);
    expect(loops).toEqual([
      { name: 'failing-loop', status: 'failing', scope: 'MK' },
      { name: 'late-loop', status: 'late', scope: 'TC' },
      { name: 'legacy-loop', status: 'alive', scope: 'graph-only' },
    ]);
    expect(composeDaily({ ...parts, loops: { status: 'ok', value: loops } }, now).markdown).toContain('late-loop (late · TC)');
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
    rmSync(root, { recursive: true, force: true });
  }
});

test('production loop collector invokes the operating CLI without --test', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-loop-args-'));
  const oldPath = process.env.PATH;
  const oldState = process.env.ELANOUS_STATE_DIR;
  try {
    if (oldState !== undefined) delete process.env.ELANOUS_STATE_DIR;
    setElanousConfigDir(join(homedir(), '.elanous'));
    writeFileSync(join(root, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(root, 'args.txt')}'\nprintf '{"results":[]}\\n'\n`);
    chmodSync(join(root, 'bun'), 0o755);
    process.env.PATH = `${root}:${oldPath ?? ''}`;
    expect(await collectLoops()).toEqual([]);
    expect(readFileSync(join(root, 'args.txt'), 'utf8').trim().split('\n')).toEqual(['bin/elanous.mjs', 'loop', 'status', '--all', '--json']);
  } finally {
    resetElanousConfigDir();
    if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('release collector does not create an absent ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-ledger-'));
  const old = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    await expect(collectRelease()).rejects.toThrow('판 원장 없음');
    expect(existsSync(join(root, 'release', 'features.sqlite'))).toBe(false);
  } finally {
    if (old === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('graph collect → compose → deliver reads one report and sends at most once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-graph-'));
  let sends = 0;
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true,
    landings: async () => (parts.landings as Extract<DailyParts['landings'], { status: 'ok' }>).value,
    release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => (parts.loops as Extract<DailyParts['loops'], { status: 'ok' }>).value,
    grid: async () => (parts.grid as Extract<DailyParts['grid'], { status: 'ok' }>).value,
    decisions: async () => (parts.decisions as Extract<DailyParts['decisions'], { status: 'ok' }>).value,
    news: async () => [], send: () => { sends++; return true; }, log: () => {}, print: () => {},
  };
  const old = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(process.cwd(), 'graphs/rhythm');
  try {
    await main(['collect', '--json'], deps);
    expect(sends).toBe(0);
    const composed = await main(['compose', '--json'], { ...deps, landings: async () => { throw new Error('compose recollected'); } });
    expect(composed.markdown).toContain('총 7건');
    expect(sends).toBe(0);
    const delivered = await main(['deliver', '--json'], deps);
    expect(delivered.sent).toBe(true);
    expect(delivered.risks[0]).toMatchObject({ name: 'zz-failing', score: 3 });
    expect(delivered.sections.news).toBe('ok');
    const repeated = await main(['deliver', '--json'], deps);
    expect(repeated.sent).toBe(false);
    expect(sends).toBe(1);
  } finally {
    if (old === undefined) delete process.env.ELANOUS_GRAPH_DIR;
    else process.env.ELANOUS_GRAPH_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('KST day is the delivery identity even when the same-day report changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-send-day-'));
  let sends = 0;
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true,
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: (text, kind) => { expect(kind).toBe('ops-report'); expect(text).toContain('RHYTHM-DAILY:2026-10-05'); sends++; return true; },
    log: () => {}, print: () => {},
  };
  try {
    expect((await main([], deps)).sent).toBe(true);
    expect((await main([], { ...deps, landings: async () => [{ title: 'new landing', seat: 'MK', mergedAt: now.toISOString() }] })).sent).toBe(false);
    expect(sends).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown delivery is not success and retries only after an authoritative negative receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-send-uncertain-'));
  let sends = 0;
  let verdict: 'unknown' | 'not-sent' | 'sent' = 'unknown';
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true,
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: () => { sends++; if (sends === 1) throw new Error('connection lost after attempt'); return true; },
    receipt: key => { expect(key).toBe('2026-10-05'); return verdict; }, log: () => {}, print: () => {},
  };
  try {
    const file = join(root, 'rhythm', 'daily', '2026-10-05.md');
    expect((await main([], deps)).sendError).toContain('결과 불명');
    expect(existsSync(`${file}.sent`)).toBe(false);
    const delivery = new Database(join(root, 'rhythm', 'daily', 'delivery.sqlite'), { readonly: true });
    try { expect(delivery.prepare('SELECT state FROM deliveries WHERE day = ?').get('2026-10-05')).toEqual({ state: 'unknown' }); }
    finally { delivery.close(); }
    expect((await main([], deps)).sendError).toContain('영수증 확인 필요');
    expect(sends).toBe(1);
    verdict = 'not-sent';
    expect((await main([], deps)).sent).toBe(true);
    expect(sends).toBe(2);
    const completed = new Database(join(root, 'rhythm', 'daily', 'delivery.sqlite'), { readonly: true });
    try { expect(completed.prepare('SELECT state FROM deliveries WHERE day = ?').get('2026-10-05')).toEqual({ state: 'sent' }); }
    finally { completed.close(); }
    expect((await main([], deps)).sent).toBe(false);
    expect(sends).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('positive receipt after interrupted attempt records completion without a duplicate send', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-send-receipt-'));
  let sends = 0;
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true,
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: () => { sends++; throw new Error('reply lost'); }, receipt: () => 'sent', log: () => {}, print: () => {},
  };
  try {
    expect((await main([], deps)).sent).toBe(false);
    expect((await main([], deps)).sendError).toBeNull();
    expect((await main([], deps)).sent).toBe(false);
    expect(sends).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('risk weights, alphabetical ties, past cut, and default no-send gate', async () => {
  const input: DailyParts = {
    ...parts,
    release: { status: 'ok', value: { ...(parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value, red: [{ name: 'z-red' }, { name: 'a-red' }] } },
    loops: { status: 'ok', value: [{ name: 'failing', status: 'failing' }, { name: 'late', status: 'late' }] },
  };
  expect(composeDaily(input, now).risks.map(r => `${r.name}:${r.score}`)).toEqual(['failing:3', 'a-red:2', 'old:2', 'z-red:2', 'MK:1']);
  expect(composeDaily(input, new Date('2026-10-07T00:00:00Z')).risks.some(r => r.name === 'a-red')).toBe(false);
  const root = mkdtempSync(join(tmpdir(), 'rhythm-no-send-'));
  let sent = 0;
  try {
    const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: false,
      landings: async () => [], release: async () => (input.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
      loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
      send: () => { sent++; return true; }, log: () => {} };
    expect((await main(['--no-news'], { ...deps, print: () => {} })).sent).toBe(false);
    expect(sent).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('graph stages fail the node on an unsent review or a failed vault copy instead of reaching done', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-stage-fail-'));
  const blocked = join(root, 'vault-is-a-file');
  writeFileSync(blocked, 'not a directory');
  const base: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true,
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: () => false, receipt: () => 'unknown', log: () => {}, print: () => {},
  };
  const prev = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(root, 'graphs', 'rhythm');
  try {
    const collected = await main(['collect', '--json'], { ...base, vaultRoot: blocked });
    expect(collected.vaultFatal).toBe(true);
    await expect(main(['compose', '--json'], { ...base, vaultRoot: blocked })).rejects.toThrow('볼트 사본 실패');
    const vault = join(root, 'vault');
    expect((await main(['compose', '--json'], { ...base, vaultRoot: vault })).vaultFatal).toBe(false);
    expect(readFileSync(join(vault, '00. Inbox', 'Daily Review', '2026-10-05.md'), 'utf8')).toBe(collected.markdown);
    await expect(main(['deliver', '--json'], base)).rejects.toThrow('발송 실패');
    expect((await main(['deliver', '--json'], { ...base, sendEnabled: false })).sendError).toBeNull();
  } finally {
    if (prev === undefined) delete process.env.ELANOUS_GRAPH_DIR; else process.env.ELANOUS_GRAPH_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
