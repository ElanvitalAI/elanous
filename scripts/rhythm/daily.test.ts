import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { composeDaily, main, runDaily, collectGrid, collectLoops, collectRelease, collectLandings, type DailyDeps, type DailyParts, type DailySendRequest } from './daily.js';
import { devVersion, listChecklist } from '../../src/release-loop/checklist.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../src/elanous-config-dir.js';
import { DecisionLedger } from '../../src/decisions/decision-ledger.js';

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

test('yesterday landings show the ten newest PRs, count every seat, and mark only omitted landings', () => {
  const landings = Array.from({ length: 12 }, (_, i) => ({
    title: `landing-${i}`, seat: i % 2 ? 'TC' : 'MK', mergedAt: `2026-10-04T${String(i).padStart(2, '0')}:00:00Z`, prNumber: i + 1,
  }));
  const report = composeDaily({ ...parts, landings: { status: 'ok', value: landings } }, now);
  const section = report.markdown.split('## ① 어제 착지\n')[1]!.split('\n\n## ② 판')[0]!;
  expect(section.split('\n')).toEqual([
    '총 12건 · 자리별 MK 6 · TC 6', ...landings.slice(2).reverse().map(i => `- ${i.title}`), '외 2건',
  ]);
  expect(report.header).toContain('어제 착지 12건');
  expect(landings[0]!.title).toBe('landing-0');
  expect(composeDaily({ ...parts, landings: { status: 'ok', value: landings.slice(2) } }, now).markdown).not.toContain('외 0건');
});

test('duplicate PR landings count once and twenty-five unlanded runs show ten lines plus fifteen omitted', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ line: `run-${String(i).padStart(2, '0')} · pr-opened`, prNumbers: [], updatedYesterday: true }));
  const report = composeDaily({ ...parts, landings: { status: 'ok', value: [
    { title: 'PR #23807', seat: 'TC', mergedAt: '2026-10-04T03:00:00Z', prNumber: 23807 },
    { title: 'PR #23807', seat: 'TC', mergedAt: '2026-10-04T02:00:00Z', prNumber: 23807 },
  ], runSummaries: items } }, now);
  const section = report.markdown.split('## ① 어제 착지\n')[1]!.split('\n\n## ② 판')[0]!;
  expect(section.split('\n').filter(line => line === '- PR #23807')).toHaveLength(1);
  expect(section).toContain('총 1건 · 자리별 TC 1');
  expect(section.split('하니스 런\n')[1]!.split('\n')).toEqual([...items.slice(0, 10).map(item => item.line), '외 15개']);
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
    expect(existsSync(review.file)).toBe(false);
    const failed = await main(['--dry-run'], { ...deps, landings: async () => { throw new Error('PR collection unavailable'); } });
    const unreadableLanding = failed.markdown.split('## ① 어제 착지\n')[1]!.split('\n\n## ② 판')[0]!;
    expect(failed.sections.landings).toBe('unreadable');
    expect(unreadableLanding).toContain('못 읽음 · PR collection unavailable');
    expect(unreadableLanding.split('\n')).toHaveLength(1);
    expect(unreadableLanding).not.toContain('CTX-FAILURE');
    expect(unreadableLanding).not.toContain('CTX-ONGOING');
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

test('CLI --dry-run --json prints KST report after a collector throws without touching the report or sending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-daily-'));
  let sends = 0;
  let output = '';
  let tick: Record<string, unknown> | undefined;
  const deps: DailyDeps = {
    now: () => now, root, vaultRoot: null, sendEnabled: true, target: { chatId: 12345, botToken: 'test-token' },
    landings: async () => (parts.landings as Extract<DailyParts['landings'], { status: 'ok' }>).value,
    release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => (parts.loops as Extract<DailyParts['loops'], { status: 'ok' }>).value,
    grid: async () => (parts.grid as Extract<DailyParts['grid'], { status: 'ok' }>).value,
    decisions: async () => (parts.decisions as Extract<DailyParts['decisions'], { status: 'ok' }>).value,
    news: async () => { throw new Error('crawl unavailable'); },
    send: () => { sends++; return { chatId: 12345, messageId: 17 }; },
    log: (_category, _event, data) => { tick = data; },
    print: line => { output = line; },
  };
  try {
    const result = await main(['--dry-run', '--json'], deps);
    const file = join(root, 'rhythm', 'daily', '2026-10-05.md');
    expect(existsSync(file)).toBe(false);
    const persisted = 'previous operating report';
    mkdirSync(join(root, 'rhythm', 'daily'), { recursive: true });
    writeFileSync(file, persisted);
    const before = statSync(file).mtimeMs;
    const repeated = await main(['--dry-run', '--json'], deps);
    expect(repeated.markdown).toBe(result.markdown);
    expect(readFileSync(file, 'utf8')).toBe(persisted);
    expect(statSync(file).mtimeMs).toBe(before);
    expect(result.sections).toMatchObject({ landings: 'ok', release: 'ok', loops: 'ok', grid: 'ok', decisions: 'ok', news: 'unreadable' });
    expect(JSON.parse(output).file).toBe(file);
    expect(JSON.parse(output).markdown).toContain('못 읽음 · crawl unavailable');
    expect(tick).toBeUndefined();
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

test('PROACT1-LITE production collect selects the top three and staged delivery sends the same proposals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-proact-'));
  const outbound: string[] = [];
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true, target: { chatId: 12345, botToken: 'test-token' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [{ name: 'delayed', status: 'late' }], grid: async () => [], decisions: async () => [], news: async () => [],
    proactSignals: async () => ({
      decisions: [
        { id: 'D-1', title: '결정1', status: 'open', blocked: true, raisedAt: '2026-10-03T00:00:00Z' },
        { id: 'D-2', title: '결정2', status: 'open', blocked: true, raisedAt: '2026-10-03T00:00:00Z' },
      ],
      yellow: [{ version: 'v1', item: { id: 'Y-1', title: '마감', status: 'yellow' } }],
      schedules: [{ version: 'v1', landBy: '2026-10-05T01:00:00Z' }],
      draftAssessment: { drafts: [{ number: 11, title: '낡은 초안' }], sweep: { complete: true, entries: [
        { number: 11, action: 'close', reason: 'stale-unobserved', applied: false },
      ] } },
    }),
    send: request => { outbound.push(request.text); return { chatId: 12345, messageId: 17 }; },
    log: () => {}, print: () => {},
  };
  const old = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(process.cwd(), 'graphs/rhythm');
  try {
    const collected = await main(['collect'], deps);
    expect(collected.markdown.split('## PROACT1-LITE 제안\n')[1]?.trim().split('\n')).toHaveLength(3);
    expect(collected.markdown).toContain('결정1');
    expect(collected.markdown).not.toContain('낡은 초안');
    const delivered = await main(['deliver'], { ...deps, proactSignals: async () => { throw new Error('stage must not recollect'); } });
    expect(delivered.sent).toBe(true);
    expect(outbound[0]).toContain('## PROACT1-LITE 제안\n');
    expect(outbound[0]).toContain('마감');
    expect(outbound[0]).not.toContain('낡은 초안');
  } finally {
    if (old === undefined) delete process.env.ELANOUS_GRAPH_DIR; else process.env.ELANOUS_GRAPH_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('PROACT1-LITE suppresses repeated proposals on another collect of the same daily run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-proact-repeat-'));
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: false,
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    proactSignals: async () => ({ decisions: [{ id: 'D-repeat', title: '반복 결정', status: 'open', blocked: true, raisedAt: '2026-10-01T00:00:00Z' }] }),
    log: () => {}, print: () => {},
  };
  const old = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(process.cwd(), 'graphs/rhythm');
  try {
    const first = await main(['collect'], deps);
    expect(first.markdown.match(/\[proact:decision:D-repeat\]/g)).toHaveLength(1);
    const second = await main(['collect'], deps);
    expect(second.markdown.match(/\[proact:decision:D-repeat\]/g)).toHaveLength(1);
    expect(second.markdown.split('## PROACT1-LITE 제안\n')[1]?.trim().split('\n')).toHaveLength(1);
  } finally {
    if (old === undefined) delete process.env.ELANOUS_GRAPH_DIR; else process.env.ELANOUS_GRAPH_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('PROACT1-LITE does not repeat a proposal on the next day', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-proact-nextday-'));
  const base = { root, vaultRoot: null, sendEnabled: false,
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    proactSignals: async () => ({ decisions: [{ id: 'D-day', title: '이틀 결정', status: 'open', blocked: true, raisedAt: '2026-10-01T00:00:00Z' }] }),
    log: () => {}, print: () => {} } satisfies DailyDeps;
  const old = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(process.cwd(), 'graphs/rhythm');
  try {
    const first = await main(['collect'], { ...base, now: () => now });
    expect(first.markdown.match(/\[proact:decision:D-day\]/g)).toHaveLength(1);
    const nextDay = await main(['collect'], { ...base, now: () => new Date(now.getTime() + 86_400_000) });
    expect(nextDay.markdown).not.toContain('[proact:decision:D-day]');
  } finally {
    if (old === undefined) delete process.env.ELANOUS_GRAPH_DIR; else process.env.ELANOUS_GRAPH_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('PROACT1-LITE production collect proposes a waiting decision stored in the real ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-proact-ledger-'));
  const raised = new DecisionLedger({ stateDir: root, now: () => new Date('2026-10-02T00:00:00Z') }).raise({
    title: '재개 대기 결정', category: 'scope', scqa: { s: '런이 질문에서 멈췄다.', c: '답이 없으면 진행 못 한다.' },
    options: [{ key: 'a', label: '진행', consequence: '재개' }, { key: 'b', label: '보류', consequence: '대기' }],
    recommendation: { option: 'a', why: '근거 충분' }, raisedBy: { agent: 'harness' }, resume: { questionId: 'auq:h3:abcde' } });
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: false,
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [], log: () => {}, print: () => {} };
  const old = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(process.cwd(), 'graphs/rhythm');
  try {
    const collected = await main(['collect'], deps);
    expect(collected.markdown).toContain(`[proact:decision:${raised.id}]`);
    expect(collected.markdown).toContain('재개 대기 결정');
  } finally {
    if (old === undefined) delete process.env.ELANOUS_GRAPH_DIR; else process.env.ELANOUS_GRAPH_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000); // 실제 수집 경로(주입 없음)는 하위 프로세스를 띄워 수십 초 걸린다.

test('daily review sends a separate three-article news message once with its own receipt and ledger row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-news-send-'));
  const requests: DailySendRequest[] = [];
  const news = [
    { title: 'A', url: 'https://a.example/1', implication: '시사 A' },
    { title: 'B', url: 'https://b.example/2', implication: '시사 B' },
  ];
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true, target: { chatId: 42, botToken: 't' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => news,
    send: request => { requests.push(request); return { chatId: 42, messageId: requests.length }; }, log: () => {},
  };
  try {
    const first = await runDaily({}, deps);
    expect(first).toMatchObject({ sent: true, deliveryState: 'sent', status: 'ok', sendError: null });
    expect(first.deliveryLine).toContain('news=sent');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.text).toEndWith('RHYTHM-DAILY:2026-10-05');
    expect(requests[0]!.text).not.toContain('https://a.example/1');
    expect(requests[1]).toMatchObject({ channel: 'telegram', chatId: 42, botToken: 't', kind: 'ops-report' });
    expect(requests[1]!.text).toBe('## 외부 동향\n- A — https://a.example/1\n  시사점: 시사 A\n- B — https://b.example/2\n  시사점: 시사 B\nRHYTHM-DAILY:2026-10-05-news');
    const db = new Database(join(root, 'rhythm', 'daily', 'delivery.sqlite'), { readonly: true });
    try { expect(db.prepare('SELECT day, state, chat_id, message_id FROM deliveries ORDER BY day').all()).toEqual([
      { day: '2026-10-05', state: 'sent', chat_id: '42', message_id: '1' },
      { day: '2026-10-05-news', state: 'sent', chat_id: '42', message_id: '2' },
    ]); } finally { db.close(); }
    const repeated = await runDaily({}, deps);
    expect(repeated.deliveryState).toBe('already-sent');
    expect(repeated.deliveryLine).toContain('news=already-sent');
    expect(requests).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unreadable news skips the second send; five articles show only the first three in staged delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-news-stage-'));
  const requests: DailySendRequest[] = [];
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true, target: { chatId: 42, botToken: 't' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [],
    news: async () => { throw new Error('crawl unavailable'); },
    send: request => { requests.push(request); return { chatId: 42, messageId: requests.length }; }, log: () => {},
  };
  try {
    const unreadable = await runDaily({}, deps);
    expect(unreadable.sections.news).toBe('unreadable');
    expect(requests).toHaveLength(1);
    const next = new Date(now.getTime() + 86_400_000);
    const five = Array.from({ length: 5 }, (_, i) => ({ title: `기사 ${i}`, url: `https://news.example/${i}`, implication: `시사 ${i}` }));
    await runDaily({ stage: 'collect' }, { ...deps, now: () => next, news: async () => five });
    const delivered = await runDaily({ stage: 'deliver' }, { ...deps, now: () => next,
      news: async () => { throw new Error('deliver must read collected report'); } });
    expect(delivered.deliveryLine).toContain('news=sent');
    expect(requests).toHaveLength(3);
    const newsText = requests[2]!.text;
    expect(newsText.match(/^- .* — https:\/\/news\.example\/\d+$/gm)).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect(newsText).toContain(`https://news.example/${i}\n  시사점: 시사 ${i}`);
    expect(newsText).not.toContain('https://news.example/3');
    expect(newsText).not.toContain('https://news.example/4');
    expect((await runDaily({ stage: 'deliver' }, { ...deps, now: () => next })).deliveryLine).toContain('news=already-sent');
    expect(requests).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('news send failure leaves the first confirmed delivery unchanged and requires a news receipt before retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-news-unknown-'));
  const requests: DailySendRequest[] = [];
  const receiptKeys: string[] = [];
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true, target: { chatId: 42, botToken: 't' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [],
    news: async () => [{ title: 'A', url: 'https://a.example/1', implication: '시사 A' }],
    send: request => { requests.push(request); return requests.length === 1 ? { chatId: 42, messageId: 1 } : null; },
    receipt: key => { receiptKeys.push(key); return 'unknown'; }, log: () => {},
  };
  try {
    const first = await runDaily({}, deps);
    expect(first).toMatchObject({ sent: true, status: 'ok', deliveryState: 'sent', sendError: null });
    expect(first.deliveryLine).toContain('news=unknown');
    const repeated = await runDaily({}, deps);
    expect(repeated).toMatchObject({ sent: false, status: 'ok', deliveryState: 'already-sent', sendError: null });
    expect(repeated.deliveryLine).toContain('news=unknown');
    expect(requests).toHaveLength(2);
    expect(receiptKeys).toEqual(['2026-10-05-news']);
    const receiptSent = await runDaily({}, { ...deps, receipt: key => {
      expect(key).toBe('2026-10-05-news'); return { chatId: 42, messageId: 2 };
    } });
    expect(receiptSent.deliveryLine).toContain('news=receipt-sent');
    expect(requests).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('graph collect → compose → deliver reads one report and sends at most once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-graph-'));
  let sends = 0;
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true, target: { chatId: 12345, botToken: 'test-token' },
    landings: async () => (parts.landings as Extract<DailyParts['landings'], { status: 'ok' }>).value,
    release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => (parts.loops as Extract<DailyParts['loops'], { status: 'ok' }>).value,
    grid: async () => (parts.grid as Extract<DailyParts['grid'], { status: 'ok' }>).value,
    decisions: async () => (parts.decisions as Extract<DailyParts['decisions'], { status: 'ok' }>).value,
    news: async () => [], send: () => { sends++; return { chatId: 12345, messageId: 17 }; }, log: () => {}, print: () => {},
  };
  const old = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(process.cwd(), 'graphs/rhythm');
  try {
    await main(['collect', '--json'], deps);
    expect(sends).toBe(0);
    const composed = await main(['compose', '--json'], { ...deps, landings: async () => { throw new Error('compose recollected'); } });
    expect(composed.markdown).toContain('총 7건');
    expect(composed.deliveryState).toBe('pending');
    expect(composed.status).toBe('pending');
    expect(composed.deliveryLine).toContain('compose pending');
    expect(composed.deliveryLine).not.toContain('send-disabled');
    expect(sends).toBe(0);
    const delivered = await main(['deliver', '--json'], deps);
    expect(delivered.sent).toBe(true);
    expect(delivered.deliveryLine).toContain('target=telegram:12345 · sent · sent=true · chars=');
    expect(delivered.deliveryLine).toContain('receipt=RHYTHM-DAILY:2026-10-05');
    expect(delivered.deliveryLine).toMatch(/chars=[1-9]\d*/);
    expect(delivered.status).toBe('ok');
    expect(delivered.risks[0]).toMatchObject({ name: 'zz-failing', score: 3 });
    expect(delivered.sections.news).toBe('ok');
    const repeated = await main(['deliver', '--json'], deps);
    expect(repeated.sent).toBe(false);
    expect(repeated.deliveryState).toBe('already-sent');
    expect(repeated.status).toBe('ok');
    expect(sends).toBe(1);
  } finally {
    if (old === undefined) delete process.env.ELANOUS_GRAPH_DIR;
    else process.env.ELANOUS_GRAPH_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('daily entrypoint requires a recipient-confirmed final transport record, not a truthy send result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-recipient-'));
  const requests: { chatId: number; text: string; kind: string }[] = [];
  const ticks: Record<string, unknown>[] = [];
  let output = '';
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true,
    target: { chatId: 12345, botToken: 'test-token' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: request => { requests.push(request); return { chatId: 99999, messageId: 17 }; },
    receipt: () => 'unknown', log: (_category, _event, data) => { ticks.push(data); }, print: line => { output = line; },
  };
  try {
    const failed = await main([], deps);
    expect(failed.status).toBe('degraded');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ channel: 'telegram', chatId: 12345, botToken: 'test-token', kind: 'ops-report' });
    expect(requests[0]!.text).toContain('RHYTHM-DAILY:2026-10-05');
    expect(output).toContain('deliver degraded · target=unknown · unknown · sent=false');
    expect(ticks.at(-1)).toMatchObject({ status: 'degraded', sent: false, target: 'unknown' });
    const db = new Database(join(root, 'rhythm', 'daily', 'delivery.sqlite'), { readonly: true });
    try { expect(db.prepare('SELECT state FROM deliveries WHERE day = ?').get('2026-10-05')).toEqual({ state: 'unknown' }); }
    finally { db.close(); }
    const recovered = await main([], { ...deps, receipt: () => 'not-sent',
      send: request => { requests.push(request); return { chatId: request.chatId, messageId: 18 }; } });
    expect(recovered).toMatchObject({ sent: true, status: 'ok' });
    expect(recovered.deliveryLine).toContain('target=telegram:12345 · sent · sent=true');
    expect(requests).toHaveLength(2);
    expect(ticks.at(-1)).toMatchObject({ target: 'telegram:12345', status: 'ok', sent: true });
    const confirmed = new Database(join(root, 'rhythm', 'daily', 'delivery.sqlite'), { readonly: true });
    try { expect(confirmed.prepare('SELECT state, chat_id, message_id FROM deliveries WHERE day = ?').get('2026-10-05'))
      .toEqual({ state: 'sent', chat_id: '12345', message_id: '18' }); }
    finally { confirmed.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('daily entrypoint resolves the configured recipient and final Telegram transport checks the reply chat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-transport-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const previousPath = process.env.PATH;
  const previousState = process.env.ELANOUS_STATE_DIR;
  const argsFile = join(root, 'curl-args');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat > '${join(root, 'curl-input')}'\nprintf '{"ok":true,"result":{"chat":{"id":12345},"message_id":77}}\\n'\n`);
  chmodSync(join(bin, 'curl'), 0o755);
  try {
    setElanousConfigDir(root);
    process.env.ELANOUS_STATE_DIR = root;
    writeFileSync(join(root, 'config.json'), JSON.stringify({ telegram: { enabled: true, botToken: 'test-token', homeChannel: 12345 } }));
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    const base: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true,
      landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
      loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
      log: () => {}, print: () => {},
    };
    const result = await main([], base);
    expect(result.status).toBe('ok');
    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual(['-sS', '-m', '25', '--config', '-']);
    expect(readFileSync(argsFile, 'utf8')).not.toContain('test-token');
    expect(readFileSync(argsFile, 'utf8')).not.toContain('RHYTHM-DAILY:2026-10-05');
    expect(readFileSync(argsFile, 'utf8')).not.toContain('확인된 위험 없음');
    const configInput = readFileSync(join(root, 'curl-input'), 'utf8');
    expect(configInput).toContain('chat_id=12345');
    expect(configInput).toContain('RHYTHM-DAILY:2026-10-05');
    expect(configInput).toContain('https://api.telegram.org/bottest-token/sendMessage');
    const store = new Database(join(root, 'rhythm', 'daily', 'delivery.sqlite'), { readonly: true });
    try { expect(store.prepare('SELECT state, chat_id, message_id FROM deliveries WHERE day = ?').get('2026-10-05'))
      .toEqual({ state: 'sent', chat_id: '12345', message_id: '77' }); }
    finally { store.close(); }
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '{"ok":true,"result":{"chat":{"id":99999},"message_id":78}}\\n'\n`);
    const wrongRecipient = await main([], { ...base, now: () => new Date('2026-10-06T00:00:00Z') });
    expect(wrongRecipient).toMatchObject({ sent: false, status: 'degraded', deliveryState: 'unknown' });
    expect(wrongRecipient.deliveryLine).toContain('target=unknown');
  } finally {
    resetElanousConfigDir();
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousState;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('auxiliary outbound record failure cannot reverse recipient-confirmed delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-record-failure-'));
  const ticks: Record<string, unknown>[] = [];
  let sends = 0;
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true,
    target: { chatId: 12345, botToken: 'test-token' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: () => { sends++; return { chatId: 12345, messageId: 77 }; },
    recordDelivery: () => { throw new Error('memory store unavailable'); },
    log: (_category, _event, data) => { ticks.push(data); }, print: () => {},
  };
  try {
    const first = await main([], deps);
    expect(first).toMatchObject({ sent: true, sendError: null, status: 'ok', deliveryState: 'sent', recordError: '보조 기록 실패 · memory store unavailable' });
    expect(first.deliveryLine).toContain('보조 기록 실패 · memory store unavailable');
    expect(ticks.at(-1)).toMatchObject({ sent: true, deliveryState: 'sent', recordError: '보조 기록 실패 · memory store unavailable' });
    const db = new Database(join(root, 'rhythm', 'daily', 'delivery.sqlite'), { readonly: true });
    try { expect(db.prepare('SELECT state, chat_id, message_id FROM deliveries WHERE day = ?').get('2026-10-05'))
      .toEqual({ state: 'sent', chat_id: '12345', message_id: '77' }); }
    finally { db.close(); }
    const second = await main([], deps);
    expect(second.deliveryState).toBe('already-sent');
    expect(sends).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enabled daily without a configured recipient cannot call the final sender', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-no-recipient-'));
  let sends = 0;
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true,
    target: { chatId: NaN, botToken: 'test-token' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: () => { sends++; return { chatId: 12345, messageId: 1 }; }, log: () => {}, print: () => {},
  };
  try {
    const result = await main([], deps);
    expect(result).toMatchObject({ sent: false, status: 'degraded', deliveryState: 'no-recipient' });
    expect(result.deliveryLine).toContain('target=unknown');
    expect(sends).toBe(0);
    expect(existsSync(join(root, 'rhythm', 'daily', 'delivery.sqlite'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KST day is the delivery identity even when the same-day report changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-send-day-'));
  let sends = 0;
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true, target: { chatId: 12345, botToken: 'test-token' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: request => { expect(request).toMatchObject({ channel: 'telegram', chatId: 12345, botToken: 'test-token', kind: 'ops-report' }); expect(request.text).toContain('RHYTHM-DAILY:2026-10-05'); sends++; return { chatId: 12345, messageId: 17 }; },
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
  let verdict: 'unknown' | 'not-sent' | { chatId: number; messageId: number } = 'unknown';
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true, target: { chatId: 12345, botToken: 'test-token' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: () => { sends++; if (sends === 1) throw new Error('connection lost after attempt'); return { chatId: 12345, messageId: 17 }; },
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
  const deps: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true, target: { chatId: 12345, botToken: 'test-token' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: () => { sends++; throw new Error('reply lost'); }, receipt: () => ({ chatId: 12345, messageId: 17 }), log: () => {}, print: () => {},
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
      send: () => { sent++; return { chatId: 12345, messageId: 17 }; }, log: () => {} };
    expect((await main(['--no-news'], { ...deps, print: () => {} })).sent).toBe(false);
    expect(sent).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('disabled delivery, bounded gh errors and injected ad news are visibly degraded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-degraded-'));
  const vault = join(root, 'vault');
  const stderr = `gh failed ${'x'.repeat(400)}\n${'harness run details\n'.repeat(300)}`;
  let sends = 0;
  const ticks: Record<string, unknown>[] = [];
  let output = '';
  const deps: DailyDeps = { now: () => now, root, vaultRoot: vault, sendEnabled: false,
    landings: async () => { throw new Error(stderr); }, release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [],
    news: async () => [
      { title: 'AI 규제 동향', url: 'https://example.org/ai', implication: '정책 확인' },
      { title: '토토 입플', url: 'https://example.org/spam', implication: '광고' },
      { title: 'AI 플랫폼', url: 'https://example.org/spam2', implication: '카지노 슬롯 광고' },
    ], send: () => { sends++; return { chatId: 12345, messageId: 17 }; }, receipt: () => 'unknown',
    log: (_category, _event, data) => { ticks.push(data); }, print: line => { output = line; },
  };
  const previous = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(root, 'graphs', 'rhythm');
  try {
    const collected = await main(['collect', '--json'], deps);
    const composed = await main(['compose', '--json'], deps);
    expect(composed.status).toBe('degraded'); // Unreadable landings, not a delivery decision.
    expect(composed.deliveryState).toBe('pending');
    expect(composed.deliveryLine).toContain('compose degraded');
    expect(composed.deliveryLine).not.toContain('send-disabled');
    expect(ticks).toHaveLength(0);
    const delivered = await main(['deliver'], deps);
    expect(delivered.status).toBe('degraded');
    expect(delivered.deliveryLine).toContain('deliver degraded · target=unknown · send-disabled · sent=false · chars=0 · receipt=RHYTHM-DAILY:2026-10-05');
    expect(output).toContain(delivered.deliveryLine);
    expect(ticks.at(-1)).toMatchObject({ status: 'degraded', deliveryState: 'send-disabled', receiptKey: 'RHYTHM-DAILY:2026-10-05', chars: 0, sections: { landings: 'unreadable' } });
    expect(sends).toBe(0);
    expect(existsSync(join(root, 'rhythm', 'daily', 'delivery.sqlite'))).toBe(false);
    expect(readFileSync(join(vault, '00. Inbox', 'Daily Review', '2026-10-05.md'), 'utf8')).toBe(collected.markdown);
    const sLine = delivered.header.split('\n')[0]!;
    const landing = delivered.markdown.split('## ① 어제 착지\n')[1]!.split('\n\n## ② 판')[0]!;
    expect(sLine.split('\n')).toHaveLength(1);
    expect(sLine.length).toBeLessThanOrEqual(200);
    expect(landing.split('\n')).toHaveLength(1);
    expect(landing.startsWith('못 읽음 · gh failed')).toBe(true);
    expect(landing.length).toBeLessThanOrEqual(200);
    expect(sLine).not.toContain('harness run details');
    expect(landing).not.toContain('harness run details');
    expect(delivered.markdown).toContain('AI 규제 동향');
    expect(delivered.markdown).not.toContain('토토 입플');
    expect(delivered.markdown).not.toContain('카지노');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_DIR; else process.env.ELANOUS_GRAPH_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('PR seats require a run result URL in the queried repository, not a title or another repository PR number', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-pr-seats-'));
  const bin = join(root, 'bin');
  const oldPath = process.env.PATH;
  const oldState = process.env.ELANOUS_STATE_DIR;
  try {
    mkdirSync(bin);
    mkdirSync(join(root, 'self-dev-runs'));
    writeFileSync(join(root, 'self-dev-runs', 'recorded.json'), JSON.stringify({
      runId: 'recorded', updatedAt: now.getTime(), seat: 'TC', results: [
        { taskId: 'one', feature: 'landing', status: 'done', prNumber: 41, prUrl: 'https://github.com/other/project/pull/41' },
        { taskId: 'two', feature: 'landing', status: 'done', prUrl: 'https://github.com/example/agent/pull/42' },
        { taskId: 'three', feature: 'landing', status: 'done', prNumber: 44, prUrl: 'https://github.com/example/agent/pull/44' },
      ],
    }));
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nprintf '[{"number":41,"title":"[MK] misleading","mergedAt":"2026-10-04T02:00:00Z"},{"number":42,"title":"no prefix","mergedAt":"2026-10-04T03:00:00Z"},{"number":43,"title":"[OP] unmatched","mergedAt":"2026-10-04T04:00:00Z"},{"number":44,"title":"same repo","mergedAt":"2026-10-04T05:00:00Z"}]\\n'\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    process.env.ELANOUS_STATE_DIR = root;
    const landings = await collectLandings(now, undefined, { repoName: 'example/agent', stateRoot: root });
    expect(landings.map(i => [i.prNumber, i.seat])).toEqual([[44, 'TC'], [43, '미분류'], [42, 'TC'], [41, '미분류']]);
    const section = composeDaily({ ...parts, landings: { status: 'ok', value: landings } }, now).markdown.split('## ① 어제 착지\n')[1]!.split('\n\n## ② 판')[0]!;
    expect(section).toContain('총 4건 · 자리별 TC 2 · 미분류 2');
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
    rmSync(root, { recursive: true, force: true });
  }
});

test('configured source or explicit repo is used for gh, and missing source never launches gh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-gh-source-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const prevPath = process.env.PATH;
  const prevState = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(root, 'args.txt')}'\nprintf '[]\\n'\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    process.env.PATH = `${bin}:${prevPath ?? ''}`;
    expect(await collectLandings(now, undefined, { repoName: 'example/agent' })).toEqual([]);
    expect(readFileSync(join(root, 'args.txt'), 'utf8')).toContain('example/agent');
    rmSync(join(root, 'args.txt'));
    await expect(collectLandings(now, undefined, { repoRoot: root })).rejects.toThrow('저장소 미지정');
    expect(existsSync(join(root, 'args.txt'))).toBe(false);
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n url = https://github.com/example/agent.git\n');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf 'https://github.com/example/agent.git\\n'\n`);
    chmodSync(join(bin, 'git'), 0o755);
    expect(await collectLandings(now, undefined, { repoRoot: root })).toEqual([]);
    expect(readFileSync(join(root, 'args.txt'), 'utf8')).toContain('example/agent');
  } finally {
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    if (prevState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});

test('successful send and readable sections cannot mask a failed vault copy in standalone run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-vault-status-'));
  const blocked = join(root, 'blocked');
  writeFileSync(blocked, 'not a directory');
  let tick: Record<string, unknown> | undefined;
  let output = '';
  let sends = 0;
  const deps: DailyDeps = { now: () => now, root, vaultRoot: blocked, sendEnabled: true, target: { chatId: 12345, botToken: 'test-token' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: () => { sends++; return { chatId: 12345, messageId: 17 }; }, log: (_category, _event, data) => { tick = data; }, print: line => { output = line; },
  };
  try {
    await expect(main([], deps)).rejects.toThrow('볼트 사본 실패');
    expect(sends).toBe(1);
    expect(tick).toMatchObject({ status: 'degraded', deliveryState: 'sent', sent: true });
    expect(output).toContain('deliver degraded · target=telegram:12345 · sent · sent=true');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('graph stages fail the node on a send failure or a failed vault copy instead of reaching done', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rhythm-stage-fail-'));
  const blocked = join(root, 'vault-is-a-file');
  writeFileSync(blocked, 'not a directory');
  const base: DailyDeps = { now: () => now, root, vaultRoot: null, sendEnabled: true, target: { chatId: 12345, botToken: 'test-token' },
    landings: async () => [], release: async () => (parts.release as Extract<DailyParts['release'], { status: 'ok' }>).value,
    loops: async () => [], grid: async () => [], decisions: async () => [], news: async () => [],
    send: () => null, receipt: () => 'unknown', log: () => {}, print: () => {},
  };
  const prev = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(root, 'graphs', 'rhythm');
  try {
    const collected = await main(['collect', '--json'], { ...base, vaultRoot: blocked });
    expect(collected.vaultFatal).toBe(true);
    expect(collected.status).toBe('degraded');
    expect(collected.deliveryState).toBe('pending');
    expect(collected.deliveryLine).not.toContain('send-disabled');
    let composeOutput = '';
    await expect(main(['compose'], { ...base, vaultRoot: blocked, print: line => { composeOutput = line; } })).rejects.toThrow('볼트 사본 실패');
    expect(composeOutput).toContain('compose degraded');
    expect(composeOutput).not.toContain('send-disabled');
    const vault = join(root, 'vault');
    expect((await main(['compose', '--json'], { ...base, vaultRoot: vault })).vaultFatal).toBe(false);
    expect(readFileSync(join(vault, '00. Inbox', 'Daily Review', '2026-10-05.md'), 'utf8')).toBe(collected.markdown);
    await expect(main(['deliver', '--json'], base)).rejects.toThrow('발송 실패');
    const disabled = await main(['deliver', '--json'], { ...base, sendEnabled: false });
    expect(disabled.sendError).toBeNull();
    expect(disabled.status).toBe('degraded');
    expect(disabled.deliveryLine).toContain('send-disabled');
  } finally {
    if (prev === undefined) delete process.env.ELANOUS_GRAPH_DIR; else process.env.ELANOUS_GRAPH_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
