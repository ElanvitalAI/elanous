// Ops-ledger native tools (우편 msg · 판 release checklist) — focused tests.
//
// Covers the in-process dispatchers (same ledgers as the `elanous msg` /
// `elanous release checklist` CLIs), the seat/OP permission boundaries, the
// HQ-fence denial path, the RunShell steering for covered CLI shapes, and the
// catalog ↔ runtime ↔ registry wiring.

import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../../msg/msg-store.js';
import { dispatchMsgAsk } from './msg-ask.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../instance/resolve.js';
import { listChecklist } from '../../release-loop/checklist.js';
import {
  dispatchMsgAck,
  dispatchMsgList,
  dispatchMsgPost,
  dispatchChecklistAdd,
  dispatchChecklistEdit,
  dispatchChecklistList,
  dispatchChecklistMove,
  dispatchChecklistSet,
  type MsgLedgerDeps,
} from './ops-ledger.js';
import { dispatchRunShell, rejectedLedgerCliResult } from './shell.js';
import { debug } from '../../debug/log.js';
import { ALL_OPS_LEDGER_RUNTIMES } from '../../tool-runtime/ops-ledger-runtimes.js';
import { runShellRuntime } from '../../tool-runtime/run-shell-runtime.js';
import { findNativeTool } from '../../native-tool-catalog.js';
import { _resetToolRuntimeRegistryForTest, dispatchToolByName, getToolRuntime, listToolRuntimes } from '../../tool-runtime/registry.js';
import { registerAllDefaultToolRuntimes } from '../../tool-runtime/index.js';
import { buildSessionRuntimeToolSpecs } from '../../session-runtime/index.js';
import { dispatchDashboardSessionRuntimeTool } from '../../dashboard/session-runtime-dispatch.js';

describe('ops-ledger msg tools (우편)', () => {
  let dir: string;
  let msgDeps: MsgLedgerDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ops-ledger-msg-'));
    const dbPath = join(dir, 'messages.db');
    msgDeps = { openStore: () => new MsgStore(dbPath) };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('post → list → ack → list 왕복 · 커서 전진 · 300ms 이내', async () => {
    const posted = await dispatchMsgPost({ from: 'OP', to: 'TC', body: '릴리스 컷 18시 KST' }, msgDeps);
    expect(posted.ok).toBe(true);
    expect(posted.message.id).toBeGreaterThan(0);
    expect(posted.message.from).toBe('OP');
    expect(posted.message.to).toBe('TC');

    const startedAt = Date.now();
    const listed = await dispatchMsgList({ to: 'TC' }, msgDeps);
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(listed.ok).toBe(true);
    expect(listed.count).toBe(1);
    expect(listed.after).toBe(0);
    expect(listed.messages[0]!.body).toBe('릴리스 컷 18시 KST');

    const acknowledged = await dispatchMsgAck({ to: 'TC', id: posted.message.id }, msgDeps);
    expect(acknowledged.ok).toBe(true);
    expect(acknowledged.cursor).toBe(posted.message.id);

    const afterAck = await dispatchMsgList({ to: 'TC' }, msgDeps);
    expect(afterAck.count).toBe(0);
    expect(afterAck.after).toBe(posted.message.id);
  });

  test('좌석 정규화 · ALL 발신 거부 · 인자 검증', async () => {
    const posted = await dispatchMsgPost({ from: 'coo', to: 'cto', body: '별칭 좌석' }, msgDeps);
    expect(posted.message.from).toBe('OP');
    expect(posted.message.to).toBe('TC');

    await expect(dispatchMsgPost({ from: 'ALL', to: 'OP', body: 'broad' }, msgDeps)).rejects.toThrow('ALL cannot send messages');
    await expect(dispatchMsgPost({ from: 'OP', to: 'TC' }, msgDeps)).rejects.toThrow("'body' must be a nonempty string");
    await expect(dispatchMsgList({ to: 'TC', limit: 1001 }, msgDeps)).rejects.toThrow("'limit' must be an integer between 1 and 1000");
    await expect(dispatchMsgList({ to: 'TC', after: -1 }, msgDeps)).rejects.toThrow("'after'");
    await expect(dispatchMsgList({}, msgDeps)).rejects.toThrow("'to' must be a nonempty string");
  });

  test('MsgAsk는 같은 원장에 질문을 쓰고 replyTo로 연결된 첫 답만 돌려준다', async () => {
    const store = msgDeps.openStore!();
    try {
      let replied = false;
      const result = await dispatchMsgAsk({ from: 'OP', to: 'TC', question: '상태?', waitSeconds: 2 }, {
        ...msgDeps,
        sleep: async () => {
          if (replied) return;
          replied = true;
          const question = store.list('TC')[0]!;
          store.post({ from: 'TC', to: 'OP', body: '연결 없는 답' });
          store.post({ from: 'UX', to: 'OP', body: '다른 발신자', replyTo: question.id });
          store.post({ from: 'TC', to: 'UX', body: '다른 수신자', replyTo: question.id });
          store.post({ from: 'TC', to: 'OP', body: '진행 중', replyTo: question.id });
        },
      });
      expect(result.ok).toBe(true);
      expect(result.question.to).toBe('TC');
      expect(result.reply?.replyTo).toBe(result.question.id);
      expect(result.reply?.body).toBe('진행 중');
      expect(store.unreadCount('TC')).toBe(1);
      expect(store.getCursor('TC')).toBe(0);
    } finally { store.close(); }
  });

  test('MsgAsk timeout은 게시한 질문 id를 잃지 않고, 사전 취소·잘못된 인자는 쓰기 0', async () => {
    const timeout = await dispatchMsgAsk({ from: 'OP', to: 'TC', question: '답?', waitSeconds: 0 }, msgDeps);
    expect(timeout.ok).toBe(false);
    expect(timeout.output).toContain(`#${timeout.question.id}`);
    const store = msgDeps.openStore!();
    try {
      expect(store.list('TC')[0]?.id).toBe(timeout.question.id);
      const abort = new AbortController();
      abort.abort();
      await expect(dispatchMsgAsk({ from: 'OP', to: 'TC', question: '취소' }, { ...msgDeps, signal: abort.signal })).rejects.toThrow('before posting');
      await expect(dispatchMsgAsk({ from: 'ALL', to: 'TC', question: '거부' }, msgDeps)).rejects.toThrow('ALL cannot send');
      await expect(dispatchMsgAsk({ from: 'OP', to: 'ALL', question: '거부' }, msgDeps)).rejects.toThrow('one recipient seat');
      await expect(dispatchMsgAsk({ from: 'OP', to: 'TC', question: 'bad', waitSeconds: 301 }, msgDeps)).rejects.toThrow('waitSeconds');
      expect(store.list('TC')).toHaveLength(1);
    } finally { store.close(); }
  });

  test('MsgAsk 폴링이 늦어 기한 뒤 도착한 연결 답은 timeout으로 남긴다', async () => {
    const store = msgDeps.openStore!();
    try {
      const result = await dispatchMsgAsk({ from: 'OP', to: 'TC', question: '기한?', waitSeconds: 1 }, {
        ...msgDeps,
        sleep: async () => {
          await new Promise(resolve => setTimeout(resolve, 1100));
          const question = store.list('TC')[0]!;
          store.post({ from: 'TC', to: 'OP', body: '늦은 답', replyTo: question.id });
        },
      });
      expect(result.ok).toBe(false);
      expect(result.reply).toBeNull();
      expect(result.output).toContain(`#${result.question.id}`);
      expect(store.listReplies(result.question.id)[0]?.body).toBe('늦은 답');
    } finally { store.close(); }
  });

  test('MsgAsk 기한 직전 도착한 답은 마지막 조회에서 받는다', async () => {
    const store = msgDeps.openStore!();
    try {
      const result = await dispatchMsgAsk({ from: 'OP', to: 'TC', question: '직전?', waitSeconds: 1 }, {
        ...msgDeps,
        sleep: async () => {
          const question = store.list('TC')[0]!;
          await new Promise(resolve => setTimeout(resolve, 900));
          store.post({ from: 'TC', to: 'OP', body: '기한 안 답', replyTo: question.id });
        },
      });
      expect(result.ok).toBe(true);
      expect(result.reply?.body).toBe('기한 안 답');
    } finally { store.close(); }
  });

  test('MsgAsk 대기 상한은 벽시계가 아닌 단조 경과 시간으로 판정한다', async () => {
    let elapsed = 0;
    const result = await dispatchMsgAsk({ from: 'OP', to: 'TC', question: '시계?', waitSeconds: 2 }, {
      ...msgDeps,
      monotonicNow: () => elapsed,
      wallNow: () => 100_000 + elapsed,
      sleep: async ms => { elapsed += ms; },
    });
    expect(result.ok).toBe(false);
    expect(elapsed).toBe(2000);
  });

  test('MsgAsk는 계속 가득 찬 답 페이지에서도 단조 기한에 멈춘다', async () => {
    const store = msgDeps.openStore!();
    let pages = 0;
    spyOn(store, 'listReplies').mockImplementation((_id, _limit, afterId = 0) => {
      pages += 1;
      return Array.from({ length: 1000 }, (_, index) => ({
        id: afterId + index + 1, from: 'UX', to: 'OP', body: '다른 자리', replyTo: 1,
        createdAt: new Date().toISOString(),
      }));
    });
    let elapsed = 0;
    const result = await dispatchMsgAsk({ from: 'OP', to: 'TC', question: '계속?', waitSeconds: 1 }, {
      openStore: () => store,
      monotonicNow: () => { elapsed += 100; return elapsed; },
      wallNow: () => 100_000 + elapsed,
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThan(20);
  });

  test('MsgAsk는 단조 기한 뒤 벽시계상 적시 답도 수락하지 않는다', async () => {
    const store = msgDeps.openStore!();
    let elapsed = 0;
    let polls = 0;
    const wallBase = Date.now();
    try {
      spyOn(store, 'listReplies').mockImplementation((questionId) => ++polls === 1 ? [] : [{
        id: questionId + 1, from: 'TC', to: 'OP', body: '벽시계상 적시 답', replyTo: questionId,
        createdAt: new Date(wallBase + 900).toISOString(),
      }]);
      const result = await dispatchMsgAsk({ from: 'OP', to: 'TC', question: '기한?', waitSeconds: 1 }, {
        openStore: () => store,
        monotonicNow: () => elapsed,
        wallNow: () => wallBase + elapsed - (elapsed > 0 ? 100 : 0),
        sleep: async () => { elapsed = 1001; },
      });
      expect(result.ok).toBe(false);
      expect(result.reply).toBeNull();
      expect(polls).toBe(2);
    } finally { store.close(); }
  });

  test('MsgAsk는 가득 찬 답 페이지가 계속돼도 실제 타이머 취소를 받는다', async () => {
    const store = msgDeps.openStore!();
    const abort = new AbortController();
    let pages = 0;
    try {
      spyOn(store, 'listReplies').mockImplementation((_id, _limit, afterId = 0) => {
        pages += 1;
        return Array.from({ length: 1000 }, (_, index) => ({
          id: afterId + index + 1, from: 'UX', to: 'OP', body: '다른 자리', replyTo: 1,
          createdAt: new Date().toISOString(),
        }));
      });
      const started = performance.now();
      const timer = setTimeout(() => abort.abort(), 20);
      try {
        const result = await dispatchMsgAsk({ from: 'OP', to: 'TC', question: '취소?', waitSeconds: 300 }, {
          openStore: () => store, signal: abort.signal,
        });
        expect(result.ok).toBe(false);
        expect(result.output).toContain('cancelled');
        expect(pages).toBeGreaterThan(1);
        expect(performance.now() - started).toBeLessThan(1000);
      } finally { clearTimeout(timer); }
    } finally { store.close(); }
  });

  test('MsgAsk는 대기 중 벽시계가 이동하면 답 판정을 보류하고 질문 ID를 남긴다', async () => {
    const store = msgDeps.openStore!();
    let elapsed = 0;
    let wallShift = 0;
    try {
      const result = await dispatchMsgAsk({ from: 'OP', to: 'TC', question: '시각?', waitSeconds: 2 }, {
        ...msgDeps,
        monotonicNow: () => elapsed,
        wallNow: () => 100_000 + elapsed + wallShift,
        sleep: async ms => {
          elapsed += ms;
          wallShift -= 5_000;
          const question = store.list('TC')[0]!;
          store.post({ from: 'TC', to: 'OP', body: '시계 이동 중 답', replyTo: question.id });
        },
      });
      expect(result.ok).toBe(false);
      expect(result.reply).toBeNull();
      expect(result.output).toContain('clock adjusted');
      expect(result.output).toContain(`#${result.question.id}`);
      expect(store.listReplies(result.question.id)).toHaveLength(1);
    } finally { store.close(); }
  });
});

describe('ops-ledger msg tools — 채워 넣은 인자', () => {
  test('after:0 · limit:0 · kind:"" · replyTo:0 은 «안 줌» · 지난 우편은 includeAcknowledged 로만', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-ledger-msg-fill-'));
    const msgDeps: MsgLedgerDeps = { openStore: () => new MsgStore(join(dir, 'messages.db')) };
    try {
      for (let i = 1; i <= 3; i += 1) await dispatchMsgPost({ from: 'TC', to: 'OP', body: `m${i}`, kind: '', replyTo: 0 }, msgDeps);
      await dispatchMsgAck({ to: 'OP', id: 2 }, msgDeps);
      const filled = await dispatchMsgList({ to: 'OP', after: 0, limit: 0, includeAcknowledged: false }, msgDeps);
      expect(filled.messages.map(message => message.body)).toEqual(['m3']);
      const all = await dispatchMsgList({ to: 'OP', includeAcknowledged: true }, msgDeps);
      expect(all.messages.map(message => message.body)).toEqual(['m1', 'm2', 'm3']);
      expect(all.after).toBe(0);
      const paged = await dispatchMsgList({ to: 'OP', after: 1 }, msgDeps);
      expect(paged.messages.map(message => message.body)).toEqual(['m2', 'm3']);
      expect(all.messages[0]!.kind ?? null).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ops-ledger checklist tools (판)', () => {
  let dir: string;
  let oldTrack: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ops-ledger-checklist-'));
    setElanousConfigDir(dir);
    oldTrack = process.env.ELANOUS_TRACK;
    process.env.ELANOUS_TRACK = 'OP';
  });

  afterEach(() => {
    if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  });

  test('add → set → list 왕복 · 요약 · 담당 거르기 · 인자 검증', async () => {
    const added = await dispatchChecklistAdd({ id: 'K1', title: '첫 칸', version: '9.9.9', owner: 'OP' });
    expect(added.ok).toBe(true);
    expect(added.version).toBe('9.9.9');
    expect(added.item?.id).toBe('K1');
    expect(added.summary?.yellow).toBe(1);
    expect('snapshot' in added).toBe(false);

    const set = await dispatchChecklistSet({ id: 'K1', version: '9.9.9', status: 'red', evidence: '#1' });
    expect(set.ok).toBe(true);
    expect(set.item?.status).toBe('red');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'K1')?.owner).toBe('OP');

    const listed = await dispatchChecklistList({ version: '9.9.9' });
    expect(listed.ok).toBe(true);
    expect(listed.summary.red).toBe(1);
    expect(listed.summary.blocked).toEqual(['K1']);
    expect(listed.items).toHaveLength(1);

    const filtered = await dispatchChecklistList({ version: '9.9.9', owner: 'MK' });
    expect(filtered.items).toHaveLength(0);

    await expect(dispatchChecklistSet({ id: 'K1', version: '9.9.9', status: 'bogus' })).rejects.toThrow('잘못된 상태');
    const beforeInvalid = listChecklist('9.9.9');
    await expect(dispatchChecklistEdit({ id: 'K1', version: '9.9.9', field: 'accelerator', value: 'maybe' })).rejects.toThrow("'accelerator' value must be true or false");
    await expect(dispatchChecklistEdit({ id: 'K1', version: '9.9.9', field: 'status', value: 'green' })).rejects.toThrow('고칠 수 없는 칸');
    await expect(dispatchChecklistEdit({ id: 'K1', version: '9.9.9', field: 'priority', value: 'P9' })).rejects.toThrow();
    expect(listChecklist('9.9.9')).toEqual(beforeInvalid);
    await expect(dispatchChecklistSet({ id: 'K1', version: '9.9.9' })).rejects.toThrow('갱신할 칸을 지정하라');
    await expect(dispatchChecklistList({ version: 'not-a-version' })).rejects.toThrow('체크리스트 판 또는 별칭이 아니다');
  });

  test('쓰기 fence와 읽기·쓰기 저장소는 현재 인스턴스의 단일 root를 쓴다', async () => {
    const roots: string[] = [];
    const deps = { fence: (_command: string, root: string) => { roots.push(root); return null; } };
    await dispatchChecklistAdd({ id: 'ROOT1', title: 'same root', version: '9.9.9' }, deps);
    await dispatchChecklistSet({ id: 'ROOT1', version: '9.9.9', status: 'red' }, deps);
    expect((await dispatchChecklistList({ version: '9.9.9' })).items.map(item => item.id)).toContain('ROOT1');
    await dispatchChecklistMove({ id: 'ROOT1', from: '9.9.9', to: '9.9.10', reason: 'root parity' }, deps);
    expect(roots).toEqual([releaseLedgerRoot(), releaseLedgerRoot(), releaseLedgerRoot()]);
    expect((await dispatchChecklistList({ version: '9.9.10' })).items.map(item => item.id)).toContain('ROOT1');
  });

  test('출력 상한 — 이력은 historyLimit 로만 · 쓰기 결과는 그 칸 ⊕ 요약뿐', async () => {
    await dispatchChecklistAdd({ id: 'H1', title: 'history', version: '9.9.9' });
    await dispatchChecklistAdd({ id: 'H2', title: 'other', version: '9.9.9' });
    for (let i = 0; i < 30; i += 1) {
      await dispatchChecklistSet({ id: 'H1', version: '9.9.9', evidence: `근거 ${i} ${'x'.repeat(200)}` });
    }
    const full = listChecklist('9.9.9');
    expect(full.history.length).toBeGreaterThan(30);

    const plain = await dispatchChecklistList({ version: '9.9.9' });
    expect(plain.history).toEqual([]);
    expect(plain.historyTotal).toBe(full.history.length);
    expect(plain.items).toHaveLength(2);

    const one = await dispatchChecklistList({ version: '9.9.9', id: 'H1', historyLimit: 5 });
    expect(one.items.map(item => item.id)).toEqual(['H1']);
    expect(one.history).toHaveLength(5);
    expect(one.history.every(entry => entry.id === 'H1')).toBe(true);
    expect(one.history).toEqual(full.history.filter(entry => entry.id === 'H1').slice(-5));
    await expect(dispatchChecklistList({ version: '9.9.9', historyLimit: 201 })).rejects.toThrow("'historyLimit'");

    // A write returns one cell — its JSON stays a fraction of the ledger with history.
    const set = await dispatchChecklistSet({ id: 'H2', version: '9.9.9', status: 'red', evidence: 'small' });
    expect(set.item?.id).toBe('H2');
    expect(JSON.stringify(set).length).toBeLessThan(JSON.stringify(full).length / 4);
  });

  test('채워 넣은 인자 — 실측 10-14 gpt-6-sol 의 넓은 채움이 칸을 덮지 않는다', async () => {
    await dispatchChecklistAdd({ id: 'F1', title: 'fill', version: '9.9.8', owner: 'OP', priority: 'P0' });
    // The exact live ChecklistSet arguments (node-c · 13:26:18Z) — every property filled.
    const set = await dispatchChecklistSet({
      id: 'F1', version: '9.9.8', status: 'yellow', evidence: '우편 5통 확인', owner: 'OP', disposition: 'block',
      kind: 'postpub', dispatchKind: 'ops', priority: 'P2', deadlineVersion: '9.9.8', predecessors: [],
      ceoMinutes: 0, ceoDate: '', accelerator: false, refs: [],
    });
    expect(set.ok).toBe(true);
    const cell = listChecklist('9.9.8').items.find(item => item.id === 'F1')!;
    expect(cell).toMatchObject({ status: 'yellow', evidence: '우편 5통 확인', owner: 'OP', priority: 'P0' });
    expect(cell.kind).toBeUndefined();
    expect(cell.disposition).toBeUndefined();
    expect(cell.dispatchKind).toBeUndefined();
    expect(cell.ceoMinutes).toBeUndefined();

    // Filled "" / [] read as absent on add and list too.
    const added = await dispatchChecklistAdd({ id: 'F2', title: 'fill add', version: '', owner: '', priority: '', deadlineVersion: '', predecessors: [], refs: [] });
    expect(added.ok).toBe(true);
    expect(added.item?.owner).toBeUndefined();
    expect(added.item?.priority).toBeUndefined();
    const listed = await dispatchChecklistList({ version: '9.9.8', owner: '', id: '', historyLimit: 0 });
    expect(listed.items.map(item => item.id)).toContain('F1');
    await expect(dispatchChecklistSet({ id: 'F1', version: '9.9.8', status: '', evidence: '', refs: [] })).rejects.toThrow('갱신할 칸을 지정하라');
  });

  test('ChecklistEdit — 한 번에 한 칸 · 값 인코딩 · 나머지는 그대로 · 본부 거부', async () => {
    await dispatchChecklistAdd({ id: 'P1', title: 'pred', version: '9.9.9' });
    await dispatchChecklistAdd({ id: 'E1', title: 'edit', version: '9.9.9', owner: 'OP', priority: 'P1' });
    const edits: Array<[string, string]> = [
      ['priority', 'P0'], ['disposition', 'known-issue'], ['kind', 'postpub'], ['dispatchKind', 'measure'],
      ['deadlineVersion', '9.9.10'], ['predecessors', 'P1'], ['ceoMinutes', '15'], ['ceoDate', '2026-10-15'], ['accelerator', 'true'],
    ];
    for (const [field, value] of edits) {
      const result = await dispatchChecklistEdit({ id: 'E1', version: '9.9.9', field, value });
      expect(result.ok).toBe(true);
      expect(result.field).toBe(field);
    }
    const cell = listChecklist('9.9.9').items.find(item => item.id === 'E1')!;
    expect(cell).toMatchObject({
      owner: 'OP', priority: 'P0', disposition: 'known-issue', kind: 'postpub', dispatchKind: 'measure',
      deadlineVersion: '9.9.10', predecessors: ['P1'], ceoMinutes: 15, ceoDate: '2026-10-15', accelerator: true,
    });
    await dispatchChecklistEdit({ id: 'E1', version: '9.9.9', field: 'predecessors', value: '' });
    await dispatchChecklistEdit({ id: 'E1', version: '9.9.9', field: 'accelerator', value: 'false' });
    const cleared = listChecklist('9.9.9').items.find(item => item.id === 'E1')!;
    expect(cleared.predecessors ?? []).toEqual([]);
    expect(cleared.accelerator).toBeUndefined();
    expect(cleared.priority).toBe('P0');
    const history = listChecklist('9.9.9').history.filter(entry => entry.id === 'E1' && entry.field === 'priority');
    expect(history.at(-1)).toMatchObject({ by: 'OP', to: 'P0' });
    const denied = await dispatchChecklistEdit({ id: 'E1', version: '9.9.9', field: 'owner', value: 'TC' }, { fence: () => '본부 아님' });
    expect(denied).toMatchObject({ ok: false, error: '본부 아님' });
    await expect(dispatchChecklistEdit({ id: 'E1', version: '9.9.9', field: 'ceoMinutes', value: '-3' })).rejects.toThrow('ceoMinutes');
  });

  test('screen 칸 green 짝 경고', async () => {
    await dispatchChecklistAdd({ id: 'S1', title: '다섯 화면', version: '9.9.9' });
    await dispatchChecklistEdit({ id: 'S1', version: '9.9.9', field: 'kind', value: 'screen' });
    const incomplete = await dispatchChecklistSet({ id: 'S1', version: '9.9.9', status: 'green', evidence: '짝: PWA ok · 데스크톱 ok' });
    expect(incomplete.parityWarning).toBeDefined();
    const complete = await dispatchChecklistSet({ id: 'S1', version: '9.9.9', status: 'green', evidence: '짝: PWA ok · 데스크톱 ok · 폴드 ok · 아이폰 ok · 아이패드 ok' });
    expect(complete.parityWarning).toBeUndefined();
  });

  test('별칭 코드네임 판 해석', async () => {
    writeFileSync(join(effectiveInstanceRoot(), 'config.json'), JSON.stringify({ release: { codenames: { '9.9.9': 'aurora' } } }));
    const added = await dispatchChecklistAdd({ id: 'K1', title: '별칭 칸', version: 'aurora' });
    expect(added.version).toBe('9.9.9');
    const listed = await dispatchChecklistList({ version: 'aurora' });
    expect(listed.version).toBe('9.9.9');
    expect(listed.codename).toBe('aurora');
  });

  test('본부 임대 거부는 구조화 실패로 돌아온다', async () => {
    const denied = await dispatchChecklistAdd({ id: 'K1', title: '첫 칸', version: '9.9.9' }, { fence: () => '본부 아님' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe('본부 아님');
    expect(denied.item).toBeUndefined();
    const deniedSet = await dispatchChecklistSet({ id: 'K1', version: '9.9.9', status: 'green' }, { fence: () => '본부 아님' });
    expect(deniedSet.ok).toBe(false);
    const deniedMove = await dispatchChecklistMove({ id: 'K1', from: '9.9.8', to: '9.9.9', reason: 'next' }, { fence: () => '본부 아님' });
    expect(deniedMove.ok).toBe(false);
  });

  test('move — OP 는 이월하고 · 자리는 남의 칸을 못 옮긴다 · 이유 필수', async () => {
    await dispatchChecklistAdd({ id: 'K2', title: 'carry', version: '0.2.9' });
    await dispatchChecklistAdd({ id: 'K3', title: 'other seat', version: '0.2.9', owner: 'MK' });

    await expect(dispatchChecklistMove({ id: 'K2', from: '0.2.9', to: '0.2.10' })).rejects.toThrow('이동 이유가 필요하다');

    const moved = await dispatchChecklistMove({ id: 'K2', from: '0.2.9', to: '0.2.10', reason: 'next cut' });
    expect(moved.ok).toBe(true);
    expect(moved.actor).toBe('OP');
    expect(moved.item?.id).toBe('K2');
    expect(listChecklist('0.2.10').items.map((item) => item.id)).toContain('K2');
    const moveHistory = listChecklist('0.2.10').history.filter((entry) => entry.id === 'K2' && entry.field === 'move');
    expect(moveHistory.at(-1)).toMatchObject({ reason: 'next cut' });

    process.env.ELANOUS_TRACK = 'TC';
    await expect(dispatchChecklistMove({ id: 'K3', from: '0.2.9', to: '0.2.10', reason: 'next' })).rejects.toThrow();
  });
});

describe('ops-ledger RunShell 스티어링', () => {
  test('TUI dashboard 진입점의 실제 카탈로그로 msg list를 거부하며 subprocess 0건', async () => {
    registerAllDefaultToolRuntimes();
    const tools = buildSessionRuntimeToolSpecs({
      userText: 'TC 우편 msg list 확인',
      hostTools: [],
      runtimeTools: listToolRuntimes('tui'),
    });
    expect(tools.map(tool => tool.name)).toContain('RunShell');
    expect(tools.map(tool => tool.name)).toContain('MsgList');

    const spawn = spyOn(childProcess, 'spawn');
    try {
      // Control proves this spy sees the shell primitive's actual subprocess boundary.
      await dispatchRunShell({ command: ['true'] });
      expect(spawn).toHaveBeenCalledTimes(1);
      spawn.mockClear();
      const result = await dispatchDashboardSessionRuntimeTool(
        'RunShell', { command: ['elanous', 'msg', 'list', '--to', 'TC'] }, {
          contextUserText: 'TC 우편 msg list 확인',
          turnRefUserText: null,
          muted: line => line,
          pushChatLine: () => {},
          draw: () => {},
          getToolRuntime,
          dispatchToolRuntime: (name, args) => dispatchToolByName(name, args, {
            surface: 'tui', agentHostTools: tools,
          }),
          dispatchPluginTool: async () => ({ ok: false, error: 'unexpected plugin dispatch' }),
        },
      ) as { approvalKey?: string };
      expect(result.approvalKey).toBe('rejected:ops-ledger-cli');
      expect(spawn).toHaveBeenCalledTimes(0);
    } finally {
      spawn.mockRestore();
    }
  });

  test('덮은 CLI 모양은 네이티브 툴로 안내하고 나머지는 통과한다', async () => {
    const availableToolNames = ALL_OPS_LEDGER_RUNTIMES.map(runtime => runtime.spec.name);
    const steer = (command: string[]) => rejectedLedgerCliResult(command, availableToolNames);
    const msgListReject = await dispatchRunShell(
      { command: ['elanous', 'msg', 'list', '--to', 'OP', '--json'] }, { availableToolNames });
    expect(msgListReject.approvalKey).toBe('rejected:ops-ledger-cli');
    const privateBody = 'private-message-body-token';
    const postReject = steer(['elanous', 'msg', 'post', '--from', 'TC', '--to', 'OP', '--body', privateBody]);
    expect(postReject?.output).toContain('MsgPost');
    expect(postReject?.output).not.toContain(privateBody);
    expect(msgListReject.output).toContain('MsgList');
    expect(msgListReject.outcome).toBe('spawn-error');

    const setReject = await dispatchRunShell(
      { command: ['bun', 'bin/elanous.mjs', 'release', 'checklist', 'set', 'K1', '--status', 'green', '--version', '9.9.9'] },
      { availableToolNames });
    expect(setReject.approvalKey).toBe('rejected:ops-ledger-cli');
    expect(setReject.output).toContain('ChecklistSet');

    expect(steer(['eln', 'release', 'checklist', 'move', 'K1', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'next'])?.output).toContain('ChecklistMove');
    expect(steer(['/usr/local/bin/elanous', 'msg', 'post', '--from', 'OP', '--to', 'TC', '--body', 'hi'])?.output).toContain('MsgPost');
    expect(steer(['elanous', 'msg', 'ack', '7', '--to', 'TC'])?.output).toContain('MsgAck');
    expect(steer(['elanous', 'release', 'checklist', 'list', '--version', '9.9.9'])?.output).toContain('ChecklistList');
    expect(steer(['elanous', 'release', 'checklist', 'add', 'K9', 'title'])?.output).toContain('ChecklistAdd');
    expect(steer(['env', 'elanous', 'msg', 'list', '--to', 'OP'])?.output).toContain('MsgList');
    expect(steer(['/usr/bin/env', 'FOO=bar', 'bunx', '--bun', 'elanous', 'release', 'checklist', 'set', 'K1'])?.output).toContain('ChecklistSet');

    // 안 덮은 것 · 다른 우주 명시 · 다른 바이너리 — 통과.
    expect(steer(['git', 'status'])).toBeNull();
    expect(steer(['elanous', 'msg', 'watch', '--to', 'OP'])).toBeNull();
    expect(steer(['elanous', 'release', 'checklist', 'status'])).toBeNull();
    expect(steer(['elanous', 'release', 'checklist', 'rm', 'K1'])).toBeNull();
    expect(steer(['elanous', '--test', 'msg', 'list', '--to', 'OP'])).toBeNull();
    expect(steer(['elanous', 'release', 'checklist', 'set', 'K1', '--status', 'green', '--config-dir', '/tmp/other'])).toBeNull();
    expect(steer(['elanous', 'release', 'checklist', 'set', 'K1', '--config-dir=/tmp/other'])).toBeNull();
    expect(steer(['elanous', 'msg', 'list', '--to', 'OP', '--state-dir=/tmp/other'])).toBeNull();
    expect(steer(['env', 'ELANOUS_STATE_DIR=/tmp/other', 'elanous', 'msg', 'list', '--to', 'OP'])).toBeNull();
    expect(steer(['env', 'ELANOUS_TRACK=TC', 'elanous', 'release', 'checklist', 'move', 'K1', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'x'])).toBeNull();
    expect(steer(['env', '-u', 'ELANOUS_TRACK', 'elanous', 'release', 'checklist', 'move', 'K1'])).toBeNull();
    expect(steer(['env', '--unset=ELANOUS_TRACK', 'elanous', 'msg', 'post', '--from', 'OP', '--to', 'TC'])).toBeNull();
    expect(steer(['env', 'ELANOUS_DEBUG=1', 'elanous', 'msg', 'list', '--to', 'OP'])?.output).toContain('MsgList');
    expect(steer(['env', '-i', 'elanous', 'msg', 'list', '--to', 'OP'])).toBeNull();
    expect(steer(['env', 'elanous', '--test', 'msg', 'list', '--to', 'OP'])).toBeNull();
    expect(steer(['bun', 'run.ts', 'msg', 'list'])).toBeNull();
    expect(rejectedLedgerCliResult(['elanous', 'msg', 'list', '--to', 'OP'])).toBeNull();
    expect(rejectedLedgerCliResult(['elanous', 'msg', 'list', '--to', 'OP'], ['ChecklistList'])).toBeNull();
    expect(steer(['elanous', 'msg', 'list', '--to', 'OP'])?.output).toContain('MsgList');
    const runtimeReject = await runShellRuntime.run(
      { command: ['elanous', 'msg', 'list', '--to', 'OP'] },
      { surface: 'tui', agentHostTools: [ALL_OPS_LEDGER_RUNTIMES[0]!.spec] },
    );
    expect(runtimeReject.approvalKey).toBe('rejected:ops-ledger-cli');
  });
});

describe('ops-ledger 배선 — 카탈로그 ↔ 런타임 ↔ 등록부', () => {
  afterEach(() => {
    _resetToolRuntimeRegistryForTest();
  });

  test('9개 런타임이 카탈로그 항목과 1:1 이고 별칭이 이름으로 풀린다', () => {
    expect(ALL_OPS_LEDGER_RUNTIMES).toHaveLength(9);
    for (const runtime of ALL_OPS_LEDGER_RUNTIMES) {
      const entry = findNativeTool(runtime.id);
      expect(entry).toBeDefined();
      expect(entry!.aliases).toContain(runtime.spec.name);
      expect(entry!.host).toContain('tui');
      expect(entry!.host).toContain('skill');
      expect(entry!.defaultEnabled).toBe(true);
      expect(entry!.cleanerFitThanShell).toBe(true);
    }
    registerAllDefaultToolRuntimes();
    for (const runtime of ALL_OPS_LEDGER_RUNTIMES) {
      expect(getToolRuntime(runtime.spec.name)?.id).toBe(runtime.id);
    }
    expect(getToolRuntime('MsgPost')?.id).toBe('msg_post');
    expect(getToolRuntime('MsgAsk')?.id).toBe('msg_ask');
    expect(getToolRuntime('checklist_move')?.id).toBe('checklist_move');
  });

  test('기본 TUI 도구 목록에서 아홉 도구가 노출되고 기존 여덟 도구가 디스패치된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-ledger-tui-'));
    const oldState = process.env.ELANOUS_STATE_DIR;
    const oldTrack = process.env.ELANOUS_TRACK;
    process.env.ELANOUS_STATE_DIR = dir;
    process.env.ELANOUS_TRACK = 'OP';
    setElanousConfigDir(dir);
    try {
      registerAllDefaultToolRuntimes();
      const specs = buildSessionRuntimeToolSpecs({
        userText: '우편을 읽고 판을 점검해 줘',
        hostTools: [],
        runtimeTools: listToolRuntimes('tui'),
      });
      const names = new Set(specs.map((spec) => spec.name));
      for (const runtime of ALL_OPS_LEDGER_RUNTIMES) expect(names.has(runtime.spec.name)).toBe(true);

      const calls: Array<[string, Record<string, unknown>]> = [
        ['MsgPost', { from: 'OP', to: 'TC', body: 'probe' }],
        ['MsgList', { to: 'TC' }],
        ['MsgAck', { to: 'TC', id: 1 }],
        ['ChecklistAdd', { id: 'K1', title: 'probe', version: '9.9.8' }],
        ['ChecklistSet', { id: 'K1', version: '9.9.8', status: 'yellow', evidence: 'probe' }],
        ['ChecklistEdit', { id: 'K1', version: '9.9.8', field: 'priority', value: 'P1' }],
        ['ChecklistList', { version: '9.9.8' }],
        ['ChecklistMove', { id: 'K1', from: '9.9.8', to: '9.9.9', reason: 'next' }],
      ];
      for (const [name, args] of calls) {
        expect(names.has(name)).toBe(true);
        const startedAt = performance.now();
        const result = await dispatchToolByName(name, args, { surface: 'tui' });
        expect(performance.now() - startedAt).toBeLessThan(300);
        expect('ok' in result && result.ok).toBe(true);
      }
      const asked = await dispatchToolByName('MsgAsk', { from: 'OP', to: 'TC', question: 'follow-up?', waitSeconds: 0 }, { surface: 'tui' });
      expect('ok' in asked && asked.ok).toBe(false);
      expect(String(asked.output)).toMatch(/MsgAsk #\d+ posted/);
      const received = await dispatchToolByName('MsgList', { to: 'TC' }, { surface: 'tui' });
      expect(('messages' in received && (received.messages as Array<{ body: string }>).some(message => message.body === 'follow-up?'))).toBe(true);
    } finally {
      if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
      if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
      resetElanousConfigDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ops-ledger 한 턴 시나리오 — OP 가 우편 5통을 읽고 판을 손본다', () => {
  test('RunShell 시도는 네이티브로 안내되고 · 셸 subprocess 0 · 네이티브 호출마다 <300ms · 호출 관측 줄', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-ledger-turn-'));
    const oldState = process.env.ELANOUS_STATE_DIR;
    const oldTrack = process.env.ELANOUS_TRACK;
    process.env.ELANOUS_STATE_DIR = dir;
    process.env.ELANOUS_TRACK = 'OP';
    setElanousConfigDir(dir);
    registerAllDefaultToolRuntimes();
    const userText = 'OP 앞 우편 5통 읽고 요약해 줘, 판 칸도 정리';
    const tools = buildSessionRuntimeToolSpecs({ userText, hostTools: [], runtimeTools: listToolRuntimes('tui') });
    const log = spyOn(debug, 'log');
    const spawn = spyOn(childProcess, 'spawn');
    try {
      for (let i = 1; i <= 5; i += 1) await dispatchMsgPost({ from: 'TC', to: 'OP', body: `보고 ${i}` });
      log.mockClear();

      const dispatch = (name: string, args: Record<string, unknown>) => dispatchDashboardSessionRuntimeTool(name, args, {
        contextUserText: userText,
        turnRefUserText: null,
        muted: line => line,
        pushChatLine: () => {},
        draw: () => {},
        getToolRuntime,
        dispatchToolRuntime: (toolName, toolArgs) => dispatchToolByName(toolName, toolArgs, { surface: 'tui', agentHostTools: tools }),
        dispatchPluginTool: async () => ({ ok: false, error: 'unexpected plugin dispatch' }),
      }) as Promise<Record<string, unknown>>;

      // The model's habitual CLI spelling is refused with the native tool name.
      const shell = await dispatch('RunShell', { command: ['eln', 'release', 'checklist', 'list', '--version', '9.9.8', '--json'] });
      expect(String(shell.output)).toContain('ChecklistList');

      const calls: Array<[string, Record<string, unknown>]> = [
        ['MsgList', { to: 'OP' }],
        ['ChecklistAdd', { id: 'T1', title: 'turn cell', version: '9.9.8', owner: 'OP' }],
        ['ChecklistList', { version: '9.9.8', owner: 'OP' }],
        ['ChecklistSet', { id: 'T1', version: '9.9.8', status: 'red', evidence: '우편 3 근거' }],
        ['ChecklistEdit', { id: 'T1', version: '9.9.8', field: 'priority', value: 'P0' }],
        ['ChecklistMove', { id: 'T1', from: '9.9.8', to: '9.9.9', reason: '다음 판' }],
        ['MsgPost', { from: 'OP', to: 'TC', body: '5통 확인' }],
        ['MsgAck', { to: 'OP', id: 5 }],
      ];
      // MsgAsk's linked reply path is exercised in its own focused test above.
      expect(calls.map(([name]) => name).sort()).toEqual(ALL_OPS_LEDGER_RUNTIMES.filter(runtime => runtime.id !== 'msg_ask').map(runtime => runtime.spec.name).sort());
      const results: Record<string, Record<string, unknown>> = {};
      const wallMs: Record<string, number> = {};
      for (const [name, args] of calls) {
        const startedAt = performance.now();
        results[name] = await dispatch(name, args);
        wallMs[name] = performance.now() - startedAt;
        expect(results[name]!.ok).toBe(true);
      }
      // Per-tool budget: each native call, measured end to end through the TUI dispatch path.
      for (const [name] of calls) expect({ tool: name, underBudget: wallMs[name]! < 300 }).toEqual({ tool: name, underBudget: true });
      expect((results.MsgList!.messages as unknown[]).length).toBe(5);
      expect(results.MsgAck!.cursor).toBe(5);
      expect((await dispatchMsgList({ to: 'OP' })).count).toBe(0);

      // RunShell-0: no shell subprocess for the whole turn.
      expect(spawn).toHaveBeenCalledTimes(0);
      const ledgerCalls = log.mock.calls.filter(([category, event]) => category === 'ops-ledger' && event === 'call')
        .map(([, , data]) => data as Record<string, unknown>);
      // One ops-ledger call line per tool, in call order, each with its own elapsed ms.
      expect(ledgerCalls.map(data => data.tool)).toEqual(calls.map(([name]) => name));
      for (const data of ledgerCalls) {
        expect(typeof data.ms).toBe('number');
        expect({ tool: data.tool, ok: data.ok, underBudget: (data.ms as number) < 300 }).toEqual({ tool: data.tool, ok: true, underBudget: true });
        expect(data.actor).toBe('OP');
        expect(JSON.stringify(data)).not.toContain('5통 확인');
        expect(JSON.stringify(data)).not.toContain('우편 3 근거');
      }
      const steered = log.mock.calls.filter(([category, event]) => category === 'shell.dispatch' && event === 'ledger-cli.steered');
      expect(steered).toHaveLength(1);
    } finally {
      spawn.mockRestore();
      log.mockRestore();
      _resetToolRuntimeRegistryForTest();
      if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
      if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
      resetElanousConfigDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
