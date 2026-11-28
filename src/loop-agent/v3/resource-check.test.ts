// CODE-BODY-TO-KIND — the shared sub kind `resource-check`: templates · predicates · ok terms · the engine over fake ports ·
// the params lint. Expectations are literals (rule 11), never built with the product's own fill().
import { describe, expect, test } from 'bun:test';
import { fill, matches, okOf, parseResourceCheck, runResourceCheck, templateProblem, type ResourceCheckPorts, type Row } from './resource-check.js';

const row = (id: string, status: string, facts: Record<string, unknown> = {}, owner: string | null = null): Row => ({ kind: 'thing', id, owner, status, facts });
// 출처: #40705 — fixture $policies numbers for the lint resolver (not a product bound)
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.startsWith('$policies.') ? ({ every: 60, retry: 30, max: 0 } as Record<string, number>)[v.slice(10)] ?? null : null);

describe('resource-check templates · predicates · ok terms', () => {
  test('fill: paths · filters · conditionals · nesting', () => {
    const ctx = { id: 'h1', status: 'bad', owner: null, facts: { used: 0.956, ratio: null, why: '', list: ['a', 'b'], n: 0 }, act: { ran: true, line: 'x'.repeat(5) } };
    expect(fill('{id} {facts.used|pct} {facts.ratio|or:?} {facts.list} {facts.list|len}', ctx)).toBe('h1 96% ? a,b 2');
    expect(fill('{?status=bad:outcome bad}{?status!=bad:fine} ({owner|or:OP})', ctx)).toBe('outcome bad (OP)');
    expect(fill('[{?facts.why: — {facts.why}}{!facts.why:none}]{?facts.n: n}{?act.ran: · {act.line|slice:3}}', ctx)).toBe('[none] · xxx');
    expect(fill('{facts.missing}|{facts.used|fixed2}', ctx)).toBe('|0.96');
    expect(templateProblem('{a|nope}')).toBe('unknown filter nope');
    expect(templateProblem('{a')).toBe('unbalanced braces');
    expect(templateProblem('{?x}')).toBe('conditional «?x» needs ?cond:text');
    expect(templateProblem('ok {a|or:-} {?b:{c|pct}}')).toBeNull();
  });
  test('matches: status · facts (one of) · facts_not · any · not', () => {
    const r = row('a', 'exhausted', { routed: true, handled: true, via: 'beat' });
    expect(matches(r, { status: ['exhausted'], factsNot: { routed: false }, not: { facts: { routed: true, handled: true } } })).toBe(false);
    expect(matches(r, { any: [{ status: ['bad'] }, { facts: { via: ['beat', 'trigger'] } }] })).toBe(true);
    expect(matches(r, { statusNot: ['exhausted'] })).toBe(false);
    expect(matches(r, null)).toBe(true);
  });
  test('okOf: any false → false · else any true → true · else null · when_nonzero guards a term', () => {
    expect(okOf([{ zero: ['a', 'b'] }], { a: 0, b: [] })).toBe(true);
    expect(okOf([{ zero: ['a'] }, { value: 'v' }], { a: 0, v: false })).toBe(false);
    expect(okOf([{ zero: ['a'], whenNonzero: ['n'] }, { value: 'v' }], { a: 3, n: 0, v: null })).toBeNull();
    // 출처: #40705 — at_most term fixture (a list longer than its max is a miss)
    expect(okOf([{ atMost: { path: 's', max: 0 } }, { zero: ['x'] }], { s: ['one'], x: 0 })).toBe(false);
    expect(okOf([{ falsy: 'g' }], { g: true })).toBe(false);
  });
});

function ports(o: { rows: Record<string, Row[] | null>; sent?: Record<string, string>; act?: ResourceCheckPorts['act']; run?: ResourceCheckPorts['run'] }) {
  const posts: Array<{ key: string; to: string; body: string }> = []; const marks: Record<string, string> = {}; const ladders: Array<{ det: string; obs: unknown[]; o: unknown }> = [];
  const p: ResourceCheckPorts = {
    at: '2026-11-28T09:00:00.000Z', nowMs: Date.parse('2026-11-28T09:00:00.000Z'), policies: { every: 60 },
    rows: k => o.rows[k] ?? null, sent: o.sent ?? {}, mark: (k, v) => { marks[k] = v; },
    post: (key, to, body) => { posts.push({ key, to, body }); return 900 + posts.length; },
    act: o.act ?? (() => undefined), run: o.run ?? (() => undefined), card: () => undefined,
    ladder: (det, obs, x) => { ladders.push({ det, obs: [...obs], o: x }); },
  };
  return { p, posts, marks, ladders };
}

describe('resource-check engine', () => {
  const spec = (extra: Record<string, unknown> = {}) => {
    const r = parseResourceCheck({
      checks: { watch: { rows: 'thing', owner: true, normal_if: { status: ['ok'] }, why: '{status}', cards: [{ action: 'card', when: { status: ['bad'] }, every_min: '$policies.every', mark: 'm:{id}', key: 'k:{id}:{day}', to: '{owner|or:OP}', body: '[c] {id} {status}', log: 'card {id}' }], ...extra } },
      counts: { bad: { rows: 'thing', where: { status_not: ['ok'] } }, all: { rows: 'thing' } },
      line: { value: 'bad {count.bad}/{count.all}', ok: [{ zero: ['count.bad'] }] },
    }, num, { actions: ['card', 'fix'], detectors: ['watch'] }, 'rc');
    expect(r.errors).toEqual([]);
    return r.spec!;
  };
  test('cards: target and text from params · throttle by mark · ladder gets the ref · KPI line', () => {
    const t = ports({ rows: { thing: [row('a', 'bad', {}, 'TC'), row('b', 'ok'), row('c', 'bad')] }, sent: { 'm:c': '2026-11-28T08:30:00.000Z' } });
    const out = runResourceCheck(spec(), t.p);
    expect(t.posts).toEqual([{ key: 'k:a:2026-11-28', to: 'TC', body: '[c] a bad' }]);
    expect(t.marks).toEqual({ 'm:a': '2026-11-28T09:00:00.000Z' });
    expect(out).toEqual({ kpi: { value: 'bad 2/3', ok: false }, actions: ['card a'] });
    expect(t.ladders).toEqual([{ det: 'watch', o: { complete: true, ownCard: true }, obs: [
      { subject: 'a', normal: false, why: 'bad', owner: 'TC', escalated: 'msg:901' }, { subject: 'b', normal: true, why: 'ok', owner: null, escalated: null }, { subject: 'c', normal: false, why: 'bad', owner: null, escalated: null }] }]);
  });
  test('act: retry window by mark · normalizes on ok · the row is re-read after the port', () => {
    let rows: Row[] = [row('a', 'bad'), row('b', 'bad')];
    const calls: string[] = [];
    const t = ports({ rows: {}, sent: { 'try:b': '2026-11-28T08:50:00.000Z' }, act: (a, r) => { calls.push(`${a}:${r.id}`); rows = rows.map(x => (x.id === r.id ? { ...x, facts: { fixed: true } } : x)); return { ok: true, line: 'done', log: `fix ${r.id}` }; } });
    const p = { ...t.p, rows: () => rows };
    const s = parseResourceCheck({ checks: { watch: { rows: 'thing', normal_if: { status: ['ok'] }, why: { normal: '{?act.ok:fixed {facts.fixed}}', abnormal: '{?act.tried:waiting}' }, act: { action: 'fix', when: { status: ['bad'] }, retry_min: '$policies.retry', mark: 'try:{id}', normalizes: true } } }, line: { value: '-', ok: [{ value: 'x' }] } },
      num, { actions: ['fix'], detectors: ['watch'] }, 'rc');
    expect(s.errors).toEqual([]);
    const out = runResourceCheck(s.spec!, p);
    expect(calls).toEqual(['fix:a']);
    expect(t.marks).toEqual({ 'try:a': '2026-11-28T09:00:00.000Z' });
    expect(out.actions).toEqual(['fix a']);
    expect(t.ladders[0]!.obs).toEqual([
      { subject: 'a', normal: true, why: 'fixed true', acted: { action: 'fix', ok: true, line: 'done' }, escalated: null },
      { subject: 'b', normal: false, why: 'waiting', escalated: null }]);
  });
  test('unknown rows (null) → no cards, no ladder · a run step that throws is one log line', () => {
    const t = ports({ rows: { thing: null }, run: () => { throw new Error('boom'); } });
    const s = parseResourceCheck({ run: [{ action: 'fix', fail_log: 'fix-failed' }], checks: { watch: { rows: 'thing', normal_if: { status: ['ok'] }, why: '-' } }, line: { value: 'run {run.fix|or:none}', ok: [{ value: 'run.fix.ok' }] } },
      num, { actions: ['fix'], detectors: ['watch'] }, 'rc');
    const out = runResourceCheck(s.spec!, t.p);
    expect(t.ladders).toEqual([]);
    expect(out).toEqual({ kpi: { value: 'run none', ok: null }, actions: ['fix-failed Error: boom'] });
  });
  test('lint: a card needs a throttle · a step / card names one of the sub\'s rights · templates must parse · unknown detector', () => {
    const r = parseResourceCheck({ checks: { other: { rows: 'x', normal_if: { status: ['ok'] }, why: '{a|zzz}', cards: [{ action: 'mail', mark: 'm', key: 'k', to: 'OP', body: 'b' }] } }, line: { value: 'v', ok: [] } },
      num, { actions: ['card'], detectors: ['watch'] }, 'rc');
    expect(r.spec).toBeNull();
    expect(r.errors).toEqual([
      'rc.checks.other: other is not one of this sub\'s detectors',
      'rc.checks.other.why: unknown filter zzz',
      'rc.checks.other.cards[0]: every_min | every_h ($policies) or once: true is required — an unthrottled card is a storm',
      'rc.checks.other.cards[0]: action mail is not one of this sub\'s actions (card)',
      'rc.line.ok needs at least one term (when is the KPI met)',
    ]);
  });
});
