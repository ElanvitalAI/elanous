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
const withEvidence = (nodes: ReturnType<typeof node>[], dates: Record<string, { deadline?: string | null; preparation?: string | null; representative?: string | null }>) => ({
  ...deps(nodes),
  dateEvidence: { project: projectId, verifiedIssues: Object.entries(dates).map(([title, date]) => ({
    identifier: title, title, url: `https://linear.app/issue/${title}`,
    officialDeadline: date.deadline ?? null, preparationPeriod: date.preparation ?? null,
    representativeActionDate: date.representative ?? null,
  })) },
});

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

test('prioritizes open items regardless of deadline and links each; only grounded dates enter the card', async () => {
  const nodes = [
    node('없음', null, 1), node('늦게', '2026-10-06', 1), node('완료', '2026-10-01', 1, 'completed'),
    node('같은날낮음', '2026-10-04', 3), node('같은날높음', '2026-10-04', 1), node('먼저', '2026-10-03', 2),
    node('없는날낮음', null, 4),
  ];
  const result = await dispatchCooAdmin({}, withEvidence(nodes, {
    늦게: { deadline: '2026-10-06' }, 같은날높음: { deadline: '2026-10-04' },
    같은날낮음: { deadline: '2026-10-04' }, 먼저: { deadline: '2026-10-03' },
  }));
  expect(result.split('\n').filter(line => line.includes(' · 우선순위 '))).toEqual([
    '확인된 마감일 2026-10-04 (D-2) · 우선순위 1 · 같은날높음 · 진행 · 담당',
    '확인된 마감일 2026-10-06 (D-4) · 우선순위 1 · 늦게 · 진행 · 담당',
    '기한 미확인 · 확인 예정일 미정 · 우선순위 1 · 없음 · 진행 · 담당',
    '확인된 마감일 2026-10-03 (D-1) · 우선순위 2 · 먼저 · 진행 · 담당',
    '확인된 마감일 2026-10-04 (D-2) · 우선순위 3 · 같은날낮음 · 진행 · 담당',
    '기한 미확인 · 확인 예정일 미정 · 우선순위 4 · 없는날낮음 · 진행 · 담당',
  ]);
  expect(result).not.toContain('완료');
  expect(result).toContain('https://linear.app/issue/없는날낮음');
  expect(result.indexOf('https://linear.app/issue/없는날낮음')).toBeLessThan(result.indexOf('```elanous-card'));
  const cards = parseElanousCard(result);
  expect(cards).toHaveLength(1);
  expect(cards[0]?.kind).toBe('coo-admin');
  expect(cards[0]?.items.map(item => item.title)).toEqual(['같은날높음', '늦게', '없음', '먼저', '같은날낮음', '없는날낮음']);
  expect(cards[0]?.items[0]).toEqual({ title: '같은날높음', due: '2026-10-04', daysLeft: 2, state: '진행', owner: '담당', url: 'https://linear.app/issue/같은날높음' });
  expect(cards[0]?.items[2]).toMatchObject({ title: '없음', due: null, daysLeft: null });
});

test('same deadline ranks urgent before high, low and unspecified priority', async () => {
  const result = await dispatchCooAdmin({}, withEvidence([
    node('미지정', '2026-10-04', 0), node('낮음', '2026-10-04', 4),
    node('긴급', '2026-10-04', 1), node('높음', '2026-10-04', 2),
  ], Object.fromEntries(['미지정', '낮음', '긴급', '높음'].map(title => [title, { deadline: '2026-10-04' }]))));
  expect(result.split('\n').filter(line => line.startsWith('확인된 마감일 2026-10-04'))).toEqual([
    '확인된 마감일 2026-10-04 (D-2) · 우선순위 1 · 긴급 · 진행 · 담당',
    '확인된 마감일 2026-10-04 (D-2) · 우선순위 2 · 높음 · 진행 · 담당',
    '확인된 마감일 2026-10-04 (D-2) · 우선순위 4 · 낮음 · 진행 · 담당',
    '확인된 마감일 2026-10-04 (D-2) · 우선순위 미지정 · 미지정 · 진행 · 담당',
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
  expect(result).toContain('기한 미확인 · 확인 예정일 미정 · 우선순위 1 · 열린 행정 · 진행 · 담당');
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
  expect(result).toContain('최대 250건 중 조회한 항목만 우선순위·확인된 마감 순으로 표시');
  expect(result).not.toContain('가장 임박');
  expect(result).toContain('기한 미확인 · 확인 예정일 미정 · 우선순위 2 · 행정-0 · 진행 · 담당');
});

test('confirmed deadline, preparation and representative-action dates are distinct, and overdue uses calendar days', async () => {
  const result = await dispatchCooAdmin({}, withEvidence([node('어제', '2026-10-01', 1)], {
    어제: { deadline: '2026-10-01', preparation: '2026-09-28', representative: '2026-09-30' },
  }));
  expect(result).toContain('확인된 마감일 2026-10-01 (지남 1일) · 우선순위 1 · 어제 · 진행 · 담당 · 준비 시작일 2026-09-28 · 대표 손이 필요한 날 2026-09-30');
  expect(parseElanousCard(result)[0]?.items[0]).toMatchObject({ due: '2026-10-01', daysLeft: -1 });
});

test('default evidence does not promote Linear planning due dates to confirmed deadlines or write back to Linear', async () => {
  const queries: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    queries.push(body.query);
    if (body.query.includes('CooProjects')) return Response.json({ data: { projects: { nodes: [{ id: projectId, name: '외부 행정·큰 일 (COO)' }], pageInfo: { hasNextPage: false } } } });
    return Response.json({ data: { issues: { nodes: [
      { ...node('통신판매업 신고 — 유료 서비스(클라우드 보관함 과금) 전', '2026-10-23', 2), identifier: 'ELA-22',
        url: 'https://linear.app/elanous-lab/issue/ELA-22/통신판매업-신고-유료-서비스클라우드-보관함-과금-전' },
    ], pageInfo: { hasNextPage: false } } } });
  }) as unknown as typeof fetch;
  const result = await dispatchCooAdmin({}, { ...deps([]), project: '외부 행정·큰 일 (COO)', fetch: fetchFn });
  expect(result).toContain('기한 미확인 · 확인 예정일 미정 · 우선순위 2 · 통신판매업 신고 — 유료 서비스(클라우드 보관함 과금) 전');
  expect(result).not.toContain('확인된 마감일 2026-10-23');
  expect(parseElanousCard(result)[0]?.items[0]).toMatchObject({ due: null, daysLeft: null });
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain('query CooProjects');
  expect(queries[1]).toContain('query CooProjectIssues');
  expect(queries.every(query => !query.includes('mutation'))).toBe(true);
});

test('unverified dates, invalid dates and mismatched issue URLs cannot become deadlines or action dates', async () => {
  const result = await dispatchCooAdmin({}, {
    ...withEvidence([node('실험', '2026-10-03', 1)], { 실험: { deadline: '2026-02-30', preparation: '2026-10-01', representative: '2026-10-02' } }),
    dateEvidence: { project: projectId, verifiedIssues: [{ identifier: '실험', title: '실험', url: 'https://linear.app/issue/다른항목',
      officialDeadline: '2026-10-03', preparationPeriod: '2026-10-01', representativeActionDate: '2026-10-02' }] },
  });
  expect(result).toContain('기한 미확인 · 확인 예정일 미정');
  expect(result).not.toContain('준비 시작일');
  expect(result).not.toContain('대표 손이 필요한 날');
  expect(parseElanousCard(result)[0]?.items[0]).toMatchObject({ due: null, daysLeft: null });
  const invalid = await dispatchCooAdmin({}, withEvidence([node('실험', '2026-10-03', 1)], {
    실험: { deadline: '2026-02-30', preparation: '2026-02-30', representative: '2026-02-30' },
  }));
  expect(invalid).toContain('기한 미확인 · 확인 예정일 미정');
  expect(invalid).not.toContain('준비 시작일');
  expect(invalid).not.toContain('대표 손이 필요한 날');
  const changedTitle = await dispatchCooAdmin({}, {
    ...withEvidence([node('실험', '2026-10-03', 1)], {}),
    dateEvidence: { project: projectId, verifiedIssues: [{ identifier: '실험', title: '옛 제목', url: 'https://linear.app/issue/실험',
      officialDeadline: '2026-10-03', preparationPeriod: null, representativeActionDate: null }] },
  });
  expect(changedTitle).toContain('기한 미확인 · 확인 예정일 미정');
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
