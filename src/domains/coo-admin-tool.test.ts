import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../user-config.js';
import { dispatchCooAdmin, COO_ADMIN_SPEC } from './coo-admin-tool.js';
import { buildCoreTools } from './core-tools.js';
import { parseElanousCard } from './elanous-card.js';

const projectId = '12345678-1234-1234-1234-123456789abc';
const node = (title: string, dueDate: string | null, priority: number, type = 'started') => ({
  identifier: title, title, url: `https://linear.app/issue/${title}`, dueDate, priority,
  state: { name: '진행', type }, assignee: { name: '담당' }, updatedAt: '2026-10-01T00:00:00Z',
});
const fetchIssues = (nodes: ReturnType<typeof node>[]) => (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(init.body as string);
  expect(body.query).toContain('CooProjectIssues');
  return Response.json({ data: { issues: { nodes, pageInfo: { hasNextPage: false } } } });
}) as unknown as typeof fetch;
const deps = (nodes: ReturnType<typeof node>[]) => ({ project: projectId, now: new Date('2026-10-02T12:00:00Z'), getSecret: async () => 'key', fetch: fetchIssues(nodes) });

test('coo.linearProject defaults and accepts user configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-config-'));
  try {
    const path = join(dir, 'config.json');
    expect(buildUserConfig(path).coo?.linearProject).toBe('외부 행정·큰 일 (COO)');
    writeFileSync(path, JSON.stringify({ coo: { linearProject: '맞춤 프로젝트' } }));
    expect(buildUserConfig(path).coo?.linearProject).toBe('맞춤 프로젝트');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('COO chat tool is registered with admin question triggers', () => {
  expect(buildCoreTools().names.has('coo_admin')).toBe(true);
  for (const trigger of ['행정 뭐 남았어', 'COO 할 일', '마감 다가오는 행정']) expect(COO_ADMIN_SPEC.description).toContain(trigger);
});

test('sorts open items by deadline, priority tie-break, undated last and links each', async () => {
  const result = await dispatchCooAdmin({}, deps([
    node('없음', null, 1), node('늦게', '2026-10-06', 1), node('완료', '2026-10-01', 1, 'completed'),
    node('같은날낮음', '2026-10-04', 3), node('같은날높음', '2026-10-04', 1), node('먼저', '2026-10-03', 2),
    node('없는날낮음', null, 4),
  ]));
  expect(result.split('\n').filter(line => line.includes(' · '))).toEqual([
    'D-1 · 먼저 · 진행 · 담당', 'D-2 · 같은날높음 · 진행 · 담당', 'D-2 · 같은날낮음 · 진행 · 담당',
    'D-4 · 늦게 · 진행 · 담당', '마감 없음 · 없음 · 진행 · 담당', '마감 없음 · 없는날낮음 · 진행 · 담당',
  ]);
  expect(result).not.toContain('완료');
  expect(result).toContain('https://linear.app/issue/없는날낮음');
  expect(result.indexOf('https://linear.app/issue/없는날낮음')).toBeLessThan(result.indexOf('```elanous-card'));
  const cards = parseElanousCard(result);
  expect(cards).toHaveLength(1);
  expect(cards[0]?.kind).toBe('coo-admin');
  expect(cards[0]?.items.map(item => item.title)).toEqual(['먼저', '같은날높음', '같은날낮음', '늦게', '없음', '없는날낮음']);
  expect(cards[0]?.items[0]).toEqual({ title: '먼저', due: '2026-10-03', daysLeft: 1, state: '진행', owner: '담당', url: 'https://linear.app/issue/먼저' });
});

test('same deadline ranks urgent before high, low and unspecified priority', async () => {
  const result = await dispatchCooAdmin({}, deps([
    node('미지정', '2026-10-04', 0), node('낮음', '2026-10-04', 4),
    node('긴급', '2026-10-04', 1), node('높음', '2026-10-04', 2),
  ]));
  expect(result.split('\n').filter(line => line.startsWith('D-2'))).toEqual([
    'D-2 · 긴급 · 진행 · 담당', 'D-2 · 높음 · 진행 · 담당',
    'D-2 · 낮음 · 진행 · 담당', 'D-2 · 미지정 · 진행 · 담당',
  ]);
});

test('250 completed issues ahead of an open one never produce a false zero count', async () => {
  const completed = Array.from({ length: 250 }, (_, i) => node(`완료-${i}`, null, 1, 'completed'));
  const remaining = node('열린 행정', '2026-10-04', 1);
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string);
    const visible = query.includes('state: { type: { nin: ["completed", "canceled"] } }') ? [remaining] : [...completed, remaining];
    const start = Number(variables.after ?? 0);
    const end = Math.min(start + variables.first, visible.length);
    return Response.json({ data: { issues: { nodes: visible.slice(start, end), pageInfo: { hasNextPage: end < visible.length, endCursor: String(end) } } } });
  }) as unknown as typeof fetch;
  const result = await dispatchCooAdmin({}, { ...deps([]), fetch: fetchFn });
  expect(result).toContain('D-2 · 열린 행정 · 진행 · 담당');
  expect(result).not.toContain('남은 행정 0건');
});

test('251st item may have the earliest deadline: label the 250-item answer as partial', async () => {
  const all = [
    ...Array.from({ length: 250 }, (_, i) => node(`행정-${i}`, '2026-10-10', 2)),
    node('가장 임박', '2026-10-03', 1),
  ];
  const requests: number[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(init.body as string);
    requests.push(variables.first);
    const start = Number(variables.after ?? 0);
    const end = Math.min(start + variables.first, all.length);
    return Response.json({ data: { issues: { nodes: all.slice(start, end), pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } } });
  }) as unknown as typeof fetch;
  const result = await dispatchCooAdmin({}, { ...deps([]), fetch: fetchFn });
  expect(requests).toEqual([100, 100, 50]);
  expect(result).toContain('최대 250건 중 조회한 항목만 마감 순으로 표시');
  expect(result).not.toContain('가장 임박');
  expect(result).toContain('D-8 · 행정-0 · 진행 · 담당');
});

test('yesterday is overdue by one calendar day', async () => {
  expect(await dispatchCooAdmin({}, deps([node('어제', '2026-10-01', 1)]))).toContain('지남 1일 · 어제');
});

test('no key returns setting instruction with zero network calls', async () => {
  let requests = 0;
  expect(await dispatchCooAdmin({}, { project: projectId, getSecret: async () => undefined, fetch: (async () => { requests++; throw new Error('unexpected'); }) as unknown as typeof fetch }))
    .toBe('Linear 키가 없습니다 — `elanous connector linear set-key`');
  expect(requests).toBe(0);
});

test('GraphQL failure is not reported as zero issues', async () => {
  const result = await dispatchCooAdmin({}, { ...deps([]), fetch: (async () => Response.json({ errors: [{ message: 'service unavailable' }] })) as unknown as typeof fetch });
  expect(result).toContain('못 읽었습니다(Linear GraphQL: service unavailable)');
  expect(result).not.toContain('0건');
});
