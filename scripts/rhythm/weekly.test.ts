import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main, type WeeklyDeps } from './weekly.js';
import { collectLandings, main as dailyMain } from './daily.js';
import { parse as parseYaml } from 'yaml';

const now = new Date('2026-10-12T00:00:00Z');
const release = { version: '0.2.14', green: 21, total: 21, nextVersion: '0.2.15', nextGreen: 1, nextTotal: 3, cutAt: '2026-10-13T00:00:00Z', red: [{ name: 'TC-red' }] };
const fixtures = (root: string): WeeklyDeps => ({
  root, now: () => now, vaultRoot: null, sendEnabled: true,
  landings: async (_now, window) => {
    expect(window.from.toISOString()).toBe('2026-10-04T15:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-10-11T15:00:00.000Z');
    return Array.from({ length: 9 }, (_, i) => ({ title: `[TC] 착지 ${i} v0.2.14`, seat: 'TC', mergedAt: '2026-10-07T02:00:00Z' }));
  },
  release: async () => release,
  decisions: async () => [{ name: '오래된 결정', openedAt: '2026-10-08T00:00:00Z' }, { name: '새 결정', openedAt: '2026-10-11T00:00:00Z' }],
});
function temp() { return realpathSync(mkdtempSync(join(tmpdir(), 'rhythm-weekly-'))); }
function daily(root: string, day: string, lines: string) {
  const dir = join(root, 'rhythm', 'daily'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.md`), `# 데일리\n\n## ⑦ 외부 동향\n${lines}\n`);
}
function issues(root: string) {
  const dir = join(root, 'rhythm', 'weekly'); mkdirSync(dir, { recursive: true });
  const rows = [
    { id: 'late', title: '늦은 현안', owner: 'OP', due: '2026-10-07T00:00:00Z', status: 'open', at: '2026-10-07T01:00:00Z', by: 'OP' },
    { id: 'done', title: '끝난 현안', owner: 'MK', due: '2026-10-09T00:00:00Z', status: 'done', at: '2026-10-08T23:00:00Z', by: 'MK' },
    { id: 'current', title: '이번 주 현안', owner: 'UX', due: '2026-10-16T00:00:00Z', status: 'open', at: '2026-10-12T00:00:00Z', by: 'UX' },
  ];
  writeFileSync(join(dir, 'issues.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

test('weekly graph loads from YAML with Monday 09:00 KST stages and recipes', () => {
  const rhythm = join(dirname(import.meta.dir), '..', 'graphs', 'rhythm');
  const weekly = parseYaml(readFileSync(join(rhythm, 'weekly.yaml'), 'utf8'));
  expect(weekly.graph_id).toBe('rhythm-weekly');
  expect(weekly.nodes.map((node: { node_id: string; recipe?: string }) => [node.node_id, node.recipe])).toEqual([
    ['collect', 'cmd:weekly-collect'], ['compose', 'cmd:weekly-compose'], ['deliver', 'cmd:weekly-deliver'],
    ['done', undefined], ['failed', undefined],
  ]);
  expect(weekly.loop.trigger.cron).toBe('0 9 * * 1');
  expect(weekly.edges.map((edge: { map: Record<string, string> }) => edge.map)).toEqual([
    { ok: 'compose', fail: 'failed' }, { ok: 'deliver', fail: 'failed' }, { ok: 'done', fail: 'failed' },
  ]);
  const recipes = parseYaml(readFileSync(join(rhythm, 'recipes.yaml'), 'utf8'));
  for (const stage of ['collect', 'compose', 'deliver']) {
    expect(recipes[`weekly-${stage}`].command).toContain(`scripts/rhythm/weekly.ts\" ${stage} --json`);
    expect(recipes[stage].command).toContain(`scripts/rhythm/daily.ts\" ${stage} --json`);
  }
});

test('reused landing collector filters exact KST seven-day boundaries without changing the daily default', async () => {
  const root = temp();
  const bin = join(root, 'bin'); mkdirSync(bin);
  const oldPath = process.env.PATH, oldRoot = process.env.ELANOUS_STATE_DIR;
  const arrivals = [
    ['[TC] before', '2026-10-04T14:59:59Z'],
    ['[TC] first', '2026-10-04T15:00:00Z'],
    ['[OP] middle', '2026-10-07T00:00:00Z'],
    ['[MK] last', '2026-10-11T14:59:59Z'],
    ['[UX] outside', '2026-10-11T15:00:00Z'],
  ].map(([title, mergedAt]) => ({ title, mergedAt }));
  try {
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(root, 'args.txt')}'\nprintf '%s\\n' '${JSON.stringify(arrivals)}'\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    process.env.ELANOUS_STATE_DIR = root;
    const range = { from: new Date('2026-10-04T15:00:00Z'), to: new Date('2026-10-11T15:00:00Z') };
    expect((await collectLandings(now, range)).map(i => i.title)).toEqual(['[MK] last', '[OP] middle', '[TC] first']);
    expect(readFileSync(join(root, 'args.txt'), 'utf8')).toContain('merged:>=2026-10-04');
    expect((await collectLandings(now)).map(i => i.title)).toEqual(['[MK] last']);
    expect(readFileSync(join(root, 'args.txt'), 'utf8')).toContain('merged:>=2026-10-11');
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldRoot === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a 500-item merged PR response makes weekly landings unreadable rather than reporting a truncated total', async () => {
  const root = temp();
  const bin = join(root, 'bin'); mkdirSync(bin);
  const oldPath = process.env.PATH, oldRoot = process.env.ELANOUS_STATE_DIR;
  try {
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\ncat '${join(root, 'arrivals.json')}'\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    process.env.ELANOUS_STATE_DIR = root;
    const rows = Array.from({ length: 499 }, (_, number) => ({ number, title: `[TC] PR ${number}`, mergedAt: '2026-10-07T02:00:00Z' }));
    writeFileSync(join(root, 'arrivals.json'), JSON.stringify(rows));
    const { landings: _fake, ...deps } = fixtures(root);
    const complete = await main(['--dry-run', '--json'], { ...deps, print: () => {}, log: () => {} });
    if (!complete || !('markdown' in complete)) throw new Error('report missing');
    expect(complete.sections.landings).toBe('ok');
    expect(complete.markdown).toContain('총 499건 · 자리별 TC 499');
    writeFileSync(join(root, 'arrivals.json'), JSON.stringify([...rows, { number: 500, title: '[UX] before window', mergedAt: '2026-10-04T14:59:59Z' }]));
    const truncated = await main(['--dry-run', '--json'], { ...deps, print: () => {}, log: () => {} });
    if (!truncated || !('markdown' in truncated)) throw new Error('report missing');
    expect(truncated.sections).toMatchObject({ landings: 'unreadable', release: 'ok', issues: 'ok' });
    expect(truncated.markdown).toContain('## ① 지난주 성과\n못 읽음 · 병합 목록 500건 조회 상한 도달 · 주간 착지 집계 불완전');
    expect(truncated.markdown).not.toContain('총 499건');
    expect(truncated.header).toContain('S: 지난주 착지 못 읽음');
    expect(await collectLandings(now)).toEqual([]); // 기본 데일리 창은 500건 응답에도 기존대로 날짜만 거른다.
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldRoot === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('weekly CLI dry-run JSON aggregates last week, current issues and deduplicated daily news without sending', async () => {
  const root = temp(); let sends = 0; let output = ''; let tick: Record<string, unknown> | undefined;
  try {
    daily(root, '2026-10-06', '- 겹침 — https://example.org/shared\n- 하나 — https://example.org/one');
    daily(root, '2026-10-09', '- 겹침 — https://example.org/shared\n- 둘 — https://example.org/two');
    issues(root);
    const published = join(root, 'release', '0.2.14'); mkdirSync(published, { recursive: true });
    writeFileSync(join(published, 'release.json'), JSON.stringify({ version: '0.2.14', publishedAt: '2026-10-08T00:00:00Z' }));
    const result = await main(['--dry-run', '--json'], { ...fixtures(root), send: () => { sends++; return true; },
      log: (_category, _event, data) => { tick = data; }, print: line => { output = line; } });
    if (!result || !('markdown' in result)) throw new Error('report missing');
    const file = join(root, 'rhythm', 'weekly', '2026-W42.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(result.markdown);
    expect(JSON.parse(output).file).toBe(file);
    expect(result.header.split('\n').map(line => line.slice(0, 2))).toEqual(['S:', 'C:', 'Q:', 'A:']);
    for (const label of ['① 지난주 성과', '② 이번 주 판 계획', '③ 주간 현안', '④ 지난주 현안 이행 대조', '⑤ 결정 필요', '⑥ 주간 외부 동향']) expect(result.markdown).toContain(`## ${label}`);
    expect(result.markdown).toContain('총 9건 · 자리별 TC 9');
    expect(result.markdown).toContain('green 21/21');
    expect(result.markdown).toContain('발행된 판: 0.2.14');
    expect(result.markdown).toContain('late 늦은 현안 · OP');
    expect(result.markdown).toContain('done 끝난 현안 · MK');
    expect(result.markdown).toContain('— 기한 넘김');
    expect(result.markdown).toContain('— done (완료 2026-10-08T23:00:00Z)');
    expect(result.markdown).toContain('current 이번 주 현안 · UX');
    expect(result.markdown).toContain('오래된 결정');
    expect(result.markdown).not.toContain('새 결정 (');
    expect(result.markdown.match(/https:\/\/example.org\/shared/g)).toHaveLength(1);
    expect(result.markdown).toContain('https://example.org/one');
    expect(result.markdown).toContain('https://example.org/two');
    expect(tick).toMatchObject({ sections: { news: 'unreadable' }, issuesOpen: 2, issuesOverdue: 1, sent: false });
    expect(result.markdown).toContain('## ⑥ 주간 외부 동향\n못 읽음 · 2026-10-05 데일리 없음');
    expect(result.markdown).toContain('부분 수집 (완전한 주간 집계 아님):');
    expect(sends).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('daily entrypoint output flows into weekly news, while malformed article lines fail closed', async () => {
  const root = temp();
  try {
    const days = ['2026-10-06T00:00:00Z', '2026-10-09T00:00:00Z'];
    for (const [index, date] of days.entries()) {
      await dailyMain(['--dry-run', '--json'], {
        root, now: () => new Date(date!), vaultRoot: null, sendEnabled: false,
        landings: async () => [], release: async () => release, loops: async () => [], grid: async () => [], decisions: async () => [],
        news: async () => [
          { title: '공통 기사', url: 'https://example.org/from-daily', implication: '확인 필요' },
          { title: `기사 ${index}`, url: `https://example.org/daily-${index}`, implication: '후속 확인' },
        ], print: () => {}, log: () => {},
      });
    }
    for (const day of ['05', '07', '08', '10', '11']) daily(root, `2026-10-${day}`, '수집된 기사 0건');
    const result = await main(['--dry-run', '--json'], { ...fixtures(root), print: () => {}, log: () => {} });
    if (!result || !('markdown' in result)) throw new Error('report missing');
    expect(readFileSync(join(root, 'rhythm', 'daily', '2026-10-06.md'), 'utf8')).toContain('  시사점: 확인 필요');
    expect(result.sections.news).toBe('ok');
    expect(result.markdown.match(/https:\/\/example.org\/from-daily/g)).toHaveLength(1);
    expect(result.markdown).toContain('https://example.org/daily-0');
    expect(result.markdown).toContain('https://example.org/daily-1');
    const malformed = join(root, 'rhythm', 'daily', '2026-10-06.md');
    writeFileSync(malformed, readFileSync(malformed, 'utf8').replace('- 공통 기사 — https://example.org/from-daily', '- 공통 기사 (링크 손상)'));
    const broken = await main(['--dry-run', '--json'], { ...fixtures(root), print: () => {}, log: () => {} });
    if (!broken || !('markdown' in broken)) throw new Error('report missing');
    expect(broken.sections.news).toBe('unreadable');
    expect(broken.markdown).toContain('외부 동향 기사 형식 오류: - 공통 기사 (링크 손상)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('published-version read failure marks the combined landing section unreadable', async () => {
  const root = temp();
  try {
    const published = join(root, 'release', '0.2.14'); mkdirSync(published, { recursive: true });
    writeFileSync(join(published, 'release.json'), '{invalid json}');
    const result = await main(['--dry-run', '--json'], { ...fixtures(root), print: () => {}, log: () => {} });
    if (!result || !('markdown' in result)) throw new Error('report missing');
    expect(result.sections).toMatchObject({ landings: 'unreadable', release: 'ok', issues: 'ok' });
    expect(result.markdown).toContain('## ① 지난주 성과\n못 읽음 · 발행된 판 목록 못 읽음');
    expect(result.header).toContain('S: 지난주 착지 못 읽음');
    expect(result.markdown).not.toContain('총 9건');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dry-run still writes a configured vault copy like daily', async () => {
  const root = temp(); const vault = join(root, 'vault');
  try {
    const result = await main(['--dry-run', '--json'], { ...fixtures(root), vaultRoot: vault, print: () => {}, log: () => {} });
    if (!result || !('markdown' in result)) throw new Error('report missing');
    expect(readFileSync(join(vault, '00. Inbox', 'Weekly Review', '2026-W42.md'), 'utf8')).toBe(result.markdown);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing daily and a thrown collector isolate only their sections', async () => {
  const root = temp();
  try {
    const result = await main(['--dry-run', '--json'], { ...fixtures(root), release: async () => { throw new Error('release down'); }, print: () => {}, log: () => {} });
    if (!result || !('markdown' in result)) throw new Error('report missing');
    expect(result.sections).toMatchObject({ release: 'unreadable', news: 'unreadable', landings: 'ok', issues: 'ok' });
    expect(result.markdown).toContain('## ② 이번 주 판 계획\n못 읽음 · release down');
    expect(result.markdown).toContain('## ⑥ 주간 외부 동향\n못 읽음 · 데일리 없음');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('all seven daily news sections are required for an ok weekly status', async () => {
  const root = temp();
  try {
    for (const day of ['05', '06', '07', '08', '09', '10', '11']) daily(root, `2026-10-${day}`, '- 공통 — https://example.org/shared');
    const complete = await main(['--dry-run', '--json'], { ...fixtures(root), print: () => {}, log: () => {} });
    if (!complete || !('markdown' in complete)) throw new Error('report missing');
    expect(complete.sections.news).toBe('ok');
    expect(complete.markdown.match(/https:\/\/example.org\/shared/g)).toHaveLength(1);
    daily(root, '2026-10-08', '못 읽음 · omni-crawl 실패');
    const partial = await main(['--dry-run', '--json'], { ...fixtures(root), print: () => {}, log: () => {} });
    if (!partial || !('markdown' in partial)) throw new Error('report missing');
    expect(partial.sections.news).toBe('unreadable');
    expect(partial.markdown).toContain('## ⑥ 주간 외부 동향\n못 읽음 · 2026-10-08 못 읽음 · omni-crawl 실패');
    expect(partial.markdown).toContain('부분 수집 (완전한 주간 집계 아님):\n- 공통 — https://example.org/shared');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('issue append-only CLI add/done/list uses last id and requires attribution', async () => {
  const root = temp(); let output = '';
  const deps: WeeklyDeps = { root, now: () => now, print: line => { output = line; } };
  const previous = process.env.AI_AGENT;
  try {
    delete process.env.AI_AGENT;
    await expect(main(['issue', 'add', '--title', '확인', '--owner', 'TC', '--due', '2026-10-16T00:00:00Z'], deps)).rejects.toThrow('--by 또는 AI_AGENT 필요');
    const row = await main(['issue', 'add', '--title', '확인', '--owner', 'TC', '--due', '2026-10-16T00:00:00Z', '--by', 'OP'], deps);
    if (!row || !('id' in row)) throw new Error('issue missing');
    await main(['issue', 'done', row.id, '--by', 'TC'], deps);
    await main(['issue', 'list', '--json'], deps);
    expect(JSON.parse(output)).toMatchObject([{ id: row.id, status: 'done', by: 'TC' }]);
    expect(readFileSync(join(root, 'rhythm', 'weekly', 'issues.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  } finally {
    if (previous === undefined) delete process.env.AI_AGENT; else process.env.AI_AGENT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable issue ledger marks both issue sections unreadable while preserving other sections', async () => {
  const root = temp();
  try {
    const dir = join(root, 'rhythm', 'weekly'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'issues.jsonl'), '{bad json}\n');
    const result = await main(['--dry-run', '--json'], { ...fixtures(root), print: () => {}, log: () => {} });
    if (!result || !('markdown' in result)) throw new Error('report missing');
    expect(result.sections).toMatchObject({ landings: 'ok', release: 'ok', issues: 'unreadable', followThrough: 'unreadable' });
    expect(result.markdown).toContain('## ③ 주간 현안\n못 읽음 · 현안 원장 1줄 JSON 오류');
    expect(result.markdown).toContain('## ④ 지난주 현안 이행 대조\n못 읽음 · 현안 원장 1줄 JSON 오류');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('default weekly send remains off without an explicit weekly enable', async () => {
  const root = temp(); let sends = 0;
  const oldRoot = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    const { sendEnabled: _enabled, ...deps } = fixtures(root);
    const result = await main(['--json'], { ...deps, send: () => { sends++; return true; }, print: () => {}, log: () => {} });
    if (!result || !('markdown' in result)) throw new Error('report missing');
    expect(result.sent).toBe(false);
    expect(sends).toBe(0);
  } finally {
    if (oldRoot === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a previously open issue remains in last-week follow-through after completion this week', async () => {
  const root = temp();
  try {
    const dir = join(root, 'rhythm', 'weekly'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'issues.jsonl'), [
      { id: 'carry', title: '이월 현안', owner: 'TC', due: '2026-10-10T00:00:00Z', status: 'open', at: '2026-10-01T00:00:00Z', by: 'TC' },
      { id: 'carry', title: '이월 현안', owner: 'TC', due: '2026-10-10T00:00:00Z', status: 'done', at: '2026-10-12T00:00:00Z', by: 'TC' },
    ].map(i => JSON.stringify(i)).join('\n') + '\n');
    const result = await main(['--dry-run', '--json'], { ...fixtures(root), print: () => {}, log: () => {} });
    if (!result || !('markdown' in result)) throw new Error('report missing');
    expect(result.markdown).toContain('carry 이월 현안 · TC · 기한 2026-10-10T00:00:00Z — 기한 뒤 완료 (완료 2026-10-12T00:00:00Z)');
    expect(result.issuesOpen).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enabled weekly delivery sends once and a sent receipt prevents duplicate sends', async () => {
  const root = temp(); let sends = 0;
  const prev = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(root, 'graphs', 'rhythm');
  try {
    const deps: WeeklyDeps = { ...fixtures(root), send: (text, kind) => {
      sends++; expect(kind).toBe('ops-report'); expect(text).toContain('RHYTHM-WEEKLY:2026-W42'); return true;
    }, log: () => {}, print: () => {} };
    await main(['collect', '--json'], deps);
    await main(['compose', '--json'], deps);
    const first = await main(['deliver', '--json'], deps);
    if (!first || !('sent' in first)) throw new Error('delivery missing');
    expect(first.sent).toBe(true);
    const second = await main(['deliver', '--json'], deps);
    if (!second || !('sent' in second)) throw new Error('delivery missing');
    expect(second.sent).toBe(false);
    expect(sends).toBe(1);
  } finally {
    if (prev === undefined) delete process.env.ELANOUS_GRAPH_DIR; else process.env.ELANOUS_GRAPH_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone CLI vault failure aborts before sending and exits nonzero', async () => {
  const root = temp(); const blocked = join(root, 'blocked'); writeFileSync(blocked, 'file');
  let sends = 0;
  try {
    const deps = { ...fixtures(root), vaultRoot: blocked, send: () => { sends++; return true; }, print: () => {}, log: () => {} };
    await expect(main(['--json'], deps)).rejects.toThrow('볼트 사본 실패');
    expect(sends).toBe(0);
    expect(existsSync(join(root, 'rhythm', 'weekly', '2026-W42.md'))).toBe(true);
    const probe = join(root, 'probe.ts');
    writeFileSync(probe, `import { main } from ${JSON.stringify(join(import.meta.dir, 'weekly.ts'))};\nawait main(['--json'], { root: ${JSON.stringify(root)}, now: () => new Date('2026-10-12T00:00:00Z'), vaultRoot: ${JSON.stringify(blocked)}, sendEnabled: true, landings: async () => [], release: async () => (${JSON.stringify(release)}), decisions: async () => [], send: () => { console.log('SENT'); return true; }, log: () => {}, print: () => {} }).catch(e => { console.error(e.message); process.exitCode = 1; });\n`);
    const child = Bun.spawnSync(['bun', probe], { cwd: import.meta.dir, env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode).toBe(1);
    expect(new TextDecoder().decode(child.stderr)).toContain('볼트 사본 실패');
    expect(new TextDecoder().decode(child.stdout)).not.toContain('SENT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('graph stages fail closed on vault and send failures, and do not duplicate delivery', async () => {
  const root = temp(); const blocked = join(root, 'blocked'); writeFileSync(blocked, 'file');
  const prev = process.env.ELANOUS_GRAPH_DIR;
  process.env.ELANOUS_GRAPH_DIR = join(root, 'graphs', 'rhythm');
  let sends = 0;
  try {
    const base = { ...fixtures(root), sendEnabled: true, send: () => { sends++; return false; }, print: () => {}, log: () => {} };
    await main(['collect', '--json'], { ...base, vaultRoot: null });
    await expect(main(['compose', '--json'], { ...base, vaultRoot: blocked })).rejects.toThrow('볼트 사본 실패');
    const vault = join(root, 'vault');
    const composed = await main(['compose', '--json'], { ...base, vaultRoot: vault });
    if (!composed || !('markdown' in composed)) throw new Error('report missing');
    expect(readFileSync(join(vault, '00. Inbox', 'Weekly Review', '2026-W42.md'), 'utf8')).toBe(composed.markdown);
    await expect(main(['deliver', '--json'], base)).rejects.toThrow('발송 실패');
    expect(sends).toBe(1);
    await expect(main(['deliver', '--json'], base)).rejects.toThrow('발송 실패');
    expect(sends).toBe(1);
  } finally {
    if (prev === undefined) delete process.env.ELANOUS_GRAPH_DIR; else process.env.ELANOUS_GRAPH_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
