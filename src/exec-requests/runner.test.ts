import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecRequestRunner } from './runner.js';
import { ExecRequestStore } from './store.js';
import * as sender from '../web-push/sender.js';
import { _setPushSubsPathForTest, addSubscription } from '../web-push/subscriptions.js';

const roots: string[] = [];
afterEach(() => { _setPushSubsPathForTest(null); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(subscribed = true) {
  const root = mkdtempSync(join(tmpdir(), 'exec-transition-'));
  roots.push(root);
  _setPushSubsPathForTest(join(root, 'push-subs.json'));
  if (subscribed) addSubscription({ subscription: { endpoint: 'https://example.test/push', keys: { p256dh: 'a', auth: 'b' } } });
  const store = new ExecRequestStore(root);
  return { root, store, runner: new ExecRequestRunner({ store, root }) };
}
const tick = async () => { await Bun.sleep(10); };

test('plain question is answered once as a downloadable report, while missing inputs and null answers still fail', async () => {
  const { root, store } = fixture(false);
  let calls = 0;
  let title = '행사 준비 상황 알려줘';
  let reply: { title: string; text: string } | null = { title: 'CMO', text: '# 상황\n확인 필요' };
  const runner = new ExecRequestRunner({ store, root, graphs: async () => [],
    plan: async () => [{ seat: 'CMO', title, graphId: '', inputs: {}, reason: 'CMO: 요청에 맞는 설치된 실행 그래프가 없습니다' }],
    answer: async () => { calls++; return reply; },
  });
  const question = runner.submit('행사 준비 상황 알려줘');
  for (let i = 0; i < 100 && store.get(question.id)?.status === 'planning'; i++) await tick();
  const done = runner.get(question.id)!;
  expect(done.status).toBe('done');
  expect(done.results).toHaveLength(1);
  expect(done.results[0]!.kind).toBe('report');
  const name = decodeURIComponent(done.results[0]!.url.split('/').at(-1)!);
  expect(readFileSync(runner.file(question.id, name)!, 'utf8')).toBe('# 상황\n확인 필요');
  expect(runner.get(question.id)?.results).toHaveLength(1);
  expect(calls).toBe(1);
  title = '인스타 피드 — 사진 파일 필요';
  const missing = runner.submit('인스타 피드');
  for (let i = 0; i < 100 && store.get(missing.id)?.status === 'planning'; i++) await tick();
  expect(store.get(missing.id)?.status).toBe('failed');
  expect(store.get(missing.id)?.seats[0]?.reason).toBe('CMO: 요청에 맞는 설치된 실행 그래프가 없습니다');
  expect(store.get(missing.id)?.seats[0]?.title).toBe(title);
  expect(calls).toBe(1);
  title = '질문'; reply = null;
  const nullAnswer = runner.submit('질문');
  for (let i = 0; i < 100 && store.get(nullAnswer.id)?.status === 'planning'; i++) await tick();
  expect(store.get(nullAnswer.id)?.status).toBe('failed');
  expect(calls).toBe(2);
});

test('multiple graphless questions account for every seat and retain a null answer failure', async () => {
  const { root, store } = fixture(false);
  const calls: string[] = [];
  let secondAnswers = true;
  const runner = new ExecRequestRunner({ store, root, graphs: async () => [],
    plan: async () => [
      { seat: 'CMO', title: '행사 준비 상황', graphId: '', inputs: {}, reason: 'CMO: 요청에 맞는 설치된 실행 그래프가 없습니다' },
      { seat: 'COO', title: '일정 상황', graphId: '', inputs: {}, reason: 'COO: 요청에 맞는 설치된 실행 그래프가 없습니다' },
    ],
    answer: async (seat) => {
      calls.push(seat);
      return seat === 'COO' && !secondAnswers ? null : { title: seat, text: `# ${seat} 상황` };
    },
  });
  const request = runner.submit('행사와 일정 상황 알려줘');
  for (let i = 0; i < 100 && store.get(request.id)?.status === 'planning'; i++) await tick();
  const done = runner.get(request.id)!;
  expect(done.status).toBe('done');
  expect(done.seats.map(seat => seat.status)).toEqual(['done', 'done']);
  expect(done.results.map(result => result.seat)).toEqual(['CMO', 'COO']);
  expect(calls).toEqual(['CMO', 'COO']);

  secondAnswers = false;
  const partial = runner.submit('행사와 일정 상황 다시 알려줘');
  for (let i = 0; i < 100 && store.get(partial.id)?.status === 'planning'; i++) await tick();
  const failed = runner.get(partial.id)!;
  expect(failed.status).toBe('failed');
  expect(failed.seats.map(seat => seat.status)).toEqual(['done', 'failed']);
  expect(failed.seats[1]?.reason).toBe('COO: 요청에 맞는 설치된 실행 그래프가 없습니다');
  expect(failed.summary).toBe('COO: 요청에 맞는 설치된 실행 그래프가 없습니다');
  expect(failed.results.map(result => result.seat)).toEqual(['CMO']);
  expect(calls).toEqual(['CMO', 'COO', 'CMO', 'COO']);
});

test('a missing-input plan among graphless seats blocks the question shortcut and preserves both failures', async () => {
  const { root, store } = fixture(false);
  let answers = 0;
  const runner = new ExecRequestRunner({ store, root, graphs: async () => [],
    plan: async () => [
      { seat: 'COO', title: '행사 준비 상황', graphId: '', inputs: {}, reason: 'COO: 요청에 맞는 설치된 실행 그래프가 없습니다' },
      { seat: 'CMO', title: '피드 — 사진 파일 필요', graphId: '', inputs: {}, reason: 'CMO: 사진 파일 필요' },
    ],
    answer: async () => { answers++; return { title: '답', text: '잘못된 답' }; },
  });
  const request = runner.submit('행사 상황과 사진 피드');
  for (let i = 0; i < 100 && store.get(request.id)?.status === 'planning'; i++) await tick();
  const failed = runner.get(request.id)!;
  expect(failed.status).toBe('failed');
  expect(failed.seats.map(seat => seat.reason)).toEqual([
    'COO: 요청에 맞는 설치된 실행 그래프가 없습니다', 'CMO: 사진 파일 필요',
  ]);
  expect(failed.results).toHaveLength(0);
  expect(answers).toBe(0);
});

test('a graphless draft without a missing-input marker is not mistaken for a plain question', async () => {
  const { root, store } = fixture(false);
  let answers = 0;
  const runner = new ExecRequestRunner({ store, root, graphs: async () => [],
    plan: async () => [{ seat: 'CMO', title: '인스타 피드 초안', graphId: '', inputs: {}, reason: 'CMO: 요청에 맞는 설치된 실행 그래프가 없습니다' }],
    answer: async () => { answers++; return { title: '답', text: '잘못된 답' }; },
  });
  const request = runner.submit('인스타 피드 초안 만들어줘');
  for (let i = 0; i < 100 && store.get(request.id)?.status === 'planning'; i++) await tick();
  expect(store.get(request.id)?.status).toBe('failed');
  expect(store.get(request.id)?.seats[0]?.reason).toBe('CMO: 요청에 맞는 설치된 실행 그래프가 없습니다');
  expect(answers).toBe(0);
});

test('a question mixed with an unexecutable draft cannot mark the draft done', async () => {
  const { root, store } = fixture(false);
  let answers = 0;
  const runner = new ExecRequestRunner({ store, root, graphs: async () => [],
    plan: async () => [
      { seat: 'COO', title: '행사 상황', graphId: '', inputs: {}, reason: 'COO: 요청에 맞는 설치된 실행 그래프가 없습니다' },
      { seat: 'CMO', title: '인스타 피드 초안', graphId: '', inputs: {}, reason: 'CMO: 요청에 맞는 설치된 실행 그래프가 없습니다' },
    ],
    answer: async () => { answers++; return { title: '답', text: '상황' }; },
  });
  const request = runner.submit('행사 상황 알려줘? 인스타 피드 초안도 만들어줘');
  for (let i = 0; i < 100 && store.get(request.id)?.status === 'planning'; i++) await tick();
  const failed = runner.get(request.id)!;
  expect(failed.status).toBe('failed');
  expect(failed.seats.map(seat => seat.status)).toEqual(['failed', 'failed']);
  expect(failed.seats[1]?.reason).toBe('CMO: 요청에 맞는 설치된 실행 그래프가 없습니다');
  expect(failed.summary).toContain('CMO: 요청에 맞는 설치된 실행 그래프가 없습니다');
  expect(answers).toBe(0);
});

test('a question mark in the middle cannot turn a graphless work item into a seat answer', async () => {
  const { root, store } = fixture(false);
  let answers = 0;
  const runner = new ExecRequestRunner({ store, root, graphs: async () => [],
    plan: async () => [
      { seat: 'COO', title: '행사 상황', graphId: '', inputs: {} },
      { seat: 'CMO', title: '카드 만들어줘', graphId: '', inputs: {} },
    ],
    answer: async () => { answers++; return { title: '답', text: '상황' }; },
  });
  const request = runner.submit('행사 상황 알려줘? 카드 만들어줘');
  for (let i = 0; i < 100 && store.get(request.id)?.status === 'planning'; i++) await tick();
  expect(store.get(request.id)?.status).toBe('failed');
  expect(store.get(request.id)?.seats.map(seat => seat.status)).toEqual(['failed', 'failed']);
  expect(store.get(request.id)?.results).toHaveLength(0);
  expect(answers).toBe(0);
});

test('attached business card follows the graph execution path, not the seat answer path', async () => {
  const { root, store } = fixture(false);
  const photo = join(root, 'uploads', 'card.jpg');
  mkdirSync(join(root, 'uploads')); writeFileSync(photo, 'card');
  let answers = 0;
  let received: unknown;
  const runner = new ExecRequestRunner({ store, root,
    graphs: async () => [{ id: 'card-followup', title: 'Card', description: '', path: '/card.yaml', inputKeys: ['image'] }],
    plan: async (_text, attachments) => [{ seat: 'CMO', title: '초안', graphId: 'card-followup', inputs: { image: attachments![0]!.path } }],
    answer: async () => { answers++; return null; },
    run: (async (_path: string, opts: { input: unknown; runId: string }) => {
      received = opts.input;
      return { graphId: 'card-followup', runId: opts.runId, status: 'done', path: [], nodes: [], executed: 1, dryRun: false, statePath: '' };
    }) as typeof import('../graph-runner/runner.js').runGraph,
  });
  const request = runner.submit('명함 초안', [{ name: 'card.jpg', path: photo }]);
  for (let i = 0; i < 100 && store.get(request.id)?.status !== 'done'; i++) await tick();
  expect(received).toEqual({ image: photo });
  expect(store.get(request.id)?.attachments).toEqual([{ name: 'card.jpg', path: photo }]);
  expect(answers).toBe(0);
});

test('running → done, running → failed and planning → failed each send once; repeated aggregation sends none', async () => {
  const { root, store, runner } = fixture();
  const send = spyOn(sender, 'sendPushToAll').mockResolvedValue({ attempted: 1, delivered: 1, removed: 0, errors: [] });
  try {
    const done = store.create('보고서 작성');
    done.status = 'running';
    done.seats = [{ seat: 'COO', title: '보고', status: 'running', graphId: 'report', runId: 'run-done' }];
    store.save(done);
    const dir = join(root, 'graph-runs', 'report');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run-done.json'), JSON.stringify({ graphId: 'report', runId: 'run-done', status: 'done', path: [], nodes: [{ output: '{"summary":"완료 요약"}' }] }));
    expect(runner.get(done.id)?.status).toBe('done');
    await tick();
    expect(send.mock.calls[0]![0]).toMatchObject({ title: '맡긴 일 완료 · 보고서 작성', body: '완료 요약', url: `/exec?id=${done.id}`, tag: `exec-${done.id}` });
    runner.get(done.id);
    expect(send).toHaveBeenCalledTimes(1);

    const failed = store.create('두 번째 요청');
    failed.status = 'running';
    failed.seats = [{ seat: 'COO', title: '보고', status: 'running', graphId: 'report', runId: 'run-failed' }];
    store.save(failed);
    writeFileSync(join(dir, 'run-failed.json'), JSON.stringify({ graphId: 'report', runId: 'run-failed', status: 'failed', path: [], nodes: [{ error: '실패 이유' }] }));
    expect(runner.get(failed.id)?.status).toBe('failed');
    await tick();
    expect(send.mock.calls[1]![0]).toMatchObject({ title: '맡긴 일 실패 · 두 번째 요청', body: '실패 이유', url: `/exec?id=${failed.id}`, tag: `exec-${failed.id}` });
    runner.get(failed.id);
    expect(send).toHaveBeenCalledTimes(2);

    const planning = store.create('계획 실패');
    runner.reconcileInterrupted();
    await tick();
    expect(store.get(planning.id)?.status).toBe('failed');
    expect(send.mock.calls[2]![0]).toMatchObject({ title: '맡긴 일 실패 · 계획 실패', body: '데몬 재시작으로 COO 계획이 중단됐습니다' });
    runner.reconcileInterrupted();
    expect(send).toHaveBeenCalledTimes(3);
  } finally { send.mockRestore(); }
});

test('new approval sends once across repeat reads; push failure does not stop aggregation', async () => {
  const { root, store, runner } = fixture();
  const send = spyOn(sender, 'sendPushToAll').mockRejectedValue(new Error('offline'));
  try {
    const item = store.create('게시 요청');
    item.status = 'running';
    item.seats = [{ seat: 'COO', title: '게시', status: 'running', graphId: 'publish', runId: 'run-approval' }];
    store.save(item);
    const dir = join(root, 'graph-runs', 'publish');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run-approval.json'), JSON.stringify({ graphId: 'publish', runId: 'run-approval', status: 'awaiting-approval', path: ['publish'], nodes: [], pending: { nodeId: 'publish', message: '승인?', since: new Date().toISOString() } }));
    expect(runner.get(item.id)?.approvals).toHaveLength(1);
    await tick();
    expect(send.mock.calls[0]![0]).toMatchObject({ title: '게시 승인 대기 · 게시 요청', body: '승인하거나 보류해 주세요', url: `/exec?id=${item.id}`, tag: `exec-${item.id}` });
    runner.get(item.id);
    expect(send).toHaveBeenCalledTimes(1);
    writeFileSync(join(dir, 'run-approval.json'), JSON.stringify({ graphId: 'publish', runId: 'run-approval', status: 'done', path: [], nodes: [{ output: '{"summary":"게시 완료"}' }] }));
    expect(runner.get(item.id)?.status).toBe('done');
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.get(item.id)?.status).toBe('done');
  } finally { send.mockRestore(); }
});

test('zero subscriptions do not call the sender during runner transitions', async () => {
  const { store, runner } = fixture(false);
  const send = spyOn(sender, 'sendPushToAll').mockResolvedValue({ attempted: 0, delivered: 0, removed: 0, errors: [] });
  try {
    const item = store.create('계획 실패');
    runner.reconcileInterrupted();
    await tick();
    expect(store.get(item.id)?.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(0);
  } finally { send.mockRestore(); }
});

// EXEC2 — 10-02 운영 실측: 맡긴 일 done 도 results 0 이었다(doc-draft·geo-check 가 `<graphId>/<runId>/` 에 파일을 쓰고 · geo-check 는 `report` 키 · 글만 낸 그래프는 버려짐).
function seatRun(root: string, store: ExecRequestStore, graphId: string, runId: string, run: Record<string, unknown>) {
  const item = store.create(`요청 ${runId}`);
  item.status = 'running';
  item.seats = [{ seat: 'CMO', title: '초안', status: 'running', graphId, runId }];
  store.save(item);
  const dir = join(root, 'graph-runs', graphId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ graphId, runId, path: [], ...run }));
  return { item, dir };
}

test('EXEC2: a file in the run\'s own <graphId>/<runId>/ directory and geo-check `report` become results and are served', () => {
  const { root, store, runner } = fixture(false);
  const runId = 'run-own-dir';
  const own = join(root, 'graph-runs', 'doc-draft', runId);
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'draft.md'), '# 초안');
  const { item } = seatRun(root, store, 'doc-draft', runId, { status: 'done', nodes: [{ output: JSON.stringify({ outcome: 'ok', file: join(own, 'draft.md') }) }] });
  const got = runner.get(item.id)!;
  expect(got.results).toHaveLength(1);
  expect(got.results[0]).toMatchObject({ seat: 'CMO', kind: 'report' });
  const name = decodeURIComponent(got.results[0]!.url.split('/').pop()!);
  expect(runner.file(item.id, name)).toContain(join('doc-draft', runId, 'draft.md'));

  const geoId = 'run-geo';
  const geoDir = join(root, 'graph-runs', 'geo-check', geoId);
  mkdirSync(geoDir, { recursive: true });
  writeFileSync(join(geoDir, 'report.md'), '# GEO');
  const geo = seatRun(root, store, 'geo-check', geoId, { status: 'done', nodes: [{ output: JSON.stringify({ report: join(geoDir, 'report.md'), summary: '0/10' }) }] });
  expect(runner.get(geo.item.id)!.results).toHaveLength(1);
});

test('EXEC2: a sibling run\'s directory is still refused', () => {
  const { root, store, runner } = fixture(false);
  const other = join(root, 'graph-runs', 'doc-draft', 'run-other');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'draft.md'), '# 남의 것');
  const { item } = seatRun(root, store, 'doc-draft', 'run-mine', { status: 'done', nodes: [{ output: JSON.stringify({ outcome: 'ok', file: join(other, 'draft.md') }) }, { output: 'null' }] });
  // No file result from the sibling; text fallback has nothing either.
  expect(runner.get(item.id)!.results).toHaveLength(0);
});

test('EXEC2: a done graph that only answered in text gets one redacted report result; no output at all stays 0', () => {
  const { root, store, runner } = fixture(false);
  const { item } = seatRun(root, store, 'doc-draft', 'run-text', { status: 'done', nodes: [
    { output: JSON.stringify({ outcome: 'ok', markdown: '# 안내\n키 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 끝' }) }, { output: 'null' }] });
  const got = runner.get(item.id)!;
  expect(got.results).toHaveLength(1);
  expect(got.results[0]).toMatchObject({ kind: 'report', title: '초안' });
  const name = decodeURIComponent(got.results[0]!.url.split('/').pop()!);
  const served = runner.file(item.id, name)!;
  expect(served.endsWith(join('doc-draft', 'run-text.json.artifacts', 'result.md'))).toBe(true);
  const body = readFileSync(served, 'utf8');
  expect(body).toContain('# 안내');
  expect(body).not.toContain('sk-ant-api03-AAAA');
  runner.get(item.id);
  expect(runner.get(item.id)!.results).toHaveLength(1);

  const empty = seatRun(root, store, 'doc-draft', 'run-empty', { status: 'done', nodes: [{ output: JSON.stringify({ outcome: 'ok', words: 3 }) }] });
  expect(runner.get(empty.item.id)!.results).toHaveLength(0);
});

test('EXEC2: a failed run reports the failing node\'s error, not «그래프 런 failed»', () => {
  const { root, store, runner } = fixture(false);
  const { item } = seatRun(root, store, 'doc-draft', 'run-check-fail', { status: 'failed', nodes: [
    { output: JSON.stringify({ outcome: 'ok', markdown: '# x' }) },
    { output: JSON.stringify({ outcome: 'fail', error: '설치 명령 끝에 마침표가 붙었다' }) },
    { output: 'null' }] });
  expect(runner.get(item.id)!.seats[0]!.reason).toBe('설치 명령 끝에 마침표가 붙었다');
});
