// TUI-HERDR-NAMED-AGENT — `eln herdr prompt`: herdr `agent prompt` 가 custom 신고 agent(elanous)를
// «not an active named agent» 로 거부하므로(herdr 0.9.1~main `effective_known_agent()` 관문),
// 같은 의미를 elanous 쪽에서 낸다: 라벨·상태 확인 → `pane run`(agent prompt 와 같은 bracketed text ⊕ Enter) → wait.
import { describe, expect, test } from 'bun:test';

import { createFakeHerdr, type FakeHerdr } from '../ux-sim/fake-herdr.js';
import { herdrPrompt, HERDR_PROMPT_ACTIVITY_WINDOW_MS } from './herdr-prompt.js';

function tuiTurn(herdr: FakeHerdr, paneId: string, turnMs = 15): void {
  // 실제 TUI 처럼: 입력을 받으면 working 신고 → 턴이 끝나면 idle 신고.
  setTimeout(() => herdr.setStatus(paneId, 'working'), 5);
  setTimeout(() => herdr.setStatus(paneId, 'idle'), 5 + turnMs);
}

function logs(): { events: Array<{ event: string; data: Record<string, unknown> }>; log: (e: string, d: Record<string, unknown>) => void } {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  return { events, log: (event, data) => events.push({ event, data }) };
}

describe('herdrPrompt — elanous TUI 를 herdr 밖에서 깨운다', () => {
  test('idle elanous agent → pane run 으로 문장 제출 → --wait 는 working 관측 뒤 idle 에서 끝난다', async () => {
    const h = createFakeHerdr({
      panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }],
      onRun: (s, herdr) => tuiTurn(herdr, s.paneId),
    });
    const l = logs();
    const r = await herdrPrompt({ target: 'w1:p1', text: '상태를 한 줄로', wait: true, timeoutMs: 2000 }, { run: h.run, log: l.log });
    expect(r).toMatchObject({ ok: true, accepted: true, reason: 'settled', status: 'idle', paneId: 'w1:p1' });
    expect(h.submissions()).toEqual([{ paneId: 'w1:p1', text: '상태를 한 줄로' }]);
    expect(l.events).toHaveLength(1);
    expect(l.events[0]!.event).toBe('prompt');
    expect(l.events[0]!.data).toMatchObject({ target: 'w1:p1', accepted: true, reason: 'settled' });
    expect(typeof l.events[0]!.data.ms).toBe('number');
  });

  test('이름 대상도 pane id 로 풀어 제출한다', async () => {
    const h = createFakeHerdr({ panes: [{ paneId: 'w2:p3', agent: 'elanous', name: 'opt', status: 'done' }] });
    const r = await herdrPrompt({ target: 'opt', text: 'hi' }, { run: h.run, log: () => {} });
    expect(r).toMatchObject({ ok: true, accepted: true, reason: 'submitted', paneId: 'w2:p3' });
    expect(h.submissions()).toEqual([{ paneId: 'w2:p3', text: 'hi' }]);
    // --wait 없으면 agent wait 를 부르지 않는다.
    expect(h.calls().some((a) => a[0] === 'agent' && a[1] === 'wait')).toBe(false);
  });

  test.each([
    ['blocked', 'agent_blocked'],
    ['working', 'agent_working'],
    ['unknown', 'agent_unknown'],
  ] as const)('상태 %s 이면 입력 0 으로 거부(%s)', async (status, reason) => {
    const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'elanous', status }] });
    const l = logs();
    const r = await herdrPrompt({ target: 'w1:p1', text: 'x', wait: true }, { run: h.run, log: l.log });
    expect(r).toMatchObject({ ok: false, accepted: false, reason });
    expect(h.submissions()).toEqual([]);
    expect(l.events[0]!.data).toMatchObject({ accepted: false, reason });
  });

  test('elanous 가 아닌 agent(herdr 내장 kind)는 거부 — 그쪽은 herdr agent prompt 를 쓴다', async () => {
    const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'codex', status: 'idle' }] });
    const r = await herdrPrompt({ target: 'w1:p1', text: 'x' }, { run: h.run, log: () => {} });
    expect(r).toMatchObject({ ok: false, accepted: false, reason: 'not_elanous', status: 'idle' });
    expect(h.submissions()).toEqual([]);
  });

  test('없는 대상은 herdr 오류 코드를 그대로 이유로', async () => {
    const h = createFakeHerdr({ panes: [] });
    const r = await herdrPrompt({ target: 'w9:p9', text: 'x' }, { run: h.run, log: () => {} });
    expect(r).toMatchObject({ ok: false, accepted: false, reason: 'agent_not_found' });
  });

  test('빈 문장은 herdr 를 부르지 않고 거부(empty_agent_prompt)', async () => {
    const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }] });
    const r = await herdrPrompt({ target: 'w1:p1', text: '' }, { run: h.run, log: () => {} });
    expect(r).toMatchObject({ ok: false, accepted: false, reason: 'empty_agent_prompt' });
    expect(h.calls()).toEqual([]);
  });

  test('제출 뒤 활동 창 안에 working/blocked 가 안 보이면 agent_prompt_stalled (입력은 들어갔다)', async () => {
    expect(HERDR_PROMPT_ACTIVITY_WINDOW_MS).toBe(5000);
    const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }] });
    const r = await herdrPrompt({ target: 'w1:p1', text: 'x', wait: true }, { run: h.run, log: () => {}, activityWindowMs: 30 });
    expect(r).toMatchObject({ ok: false, accepted: true, reason: 'agent_prompt_stalled' });
  });

  test('턴이 wait 시작 전에 끝나도(state_change_seq 증가 ⊕ 정착) 성공으로 읽는다', async () => {
    const h = createFakeHerdr({
      panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }],
      onRun: (s, herdr) => { herdr.setStatus(s.paneId, 'working'); herdr.setStatus(s.paneId, 'idle'); },
    });
    const r = await herdrPrompt({ target: 'w1:p1', text: 'x', wait: true }, { run: h.run, log: () => {}, activityWindowMs: 30 });
    expect(r).toMatchObject({ ok: true, accepted: true, reason: 'settled', status: 'idle' });
  });

  test('blocked 로 정착하면 성공(herdr --wait 기본 정착 상태) · 상태는 blocked', async () => {
    const h = createFakeHerdr({
      panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }],
      onRun: (s, herdr) => { setTimeout(() => herdr.setStatus(s.paneId, 'blocked'), 5); },
    });
    const r = await herdrPrompt({ target: 'w1:p1', text: 'x', wait: true, timeoutMs: 1000 }, { run: h.run, log: () => {} });
    expect(r).toMatchObject({ ok: true, accepted: true, reason: 'settled', status: 'blocked' });
  });

  test('working 이 안 끝나면 호출자 timeout 으로 실패(timeout)', async () => {
    const h = createFakeHerdr({
      panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }],
      onRun: (s, herdr) => { setTimeout(() => herdr.setStatus(s.paneId, 'working'), 5); },
    });
    const r = await herdrPrompt({ target: 'w1:p1', text: 'x', wait: true, timeoutMs: 80 }, { run: h.run, log: () => {} });
    expect(r).toMatchObject({ ok: false, accepted: true, reason: 'timeout', status: 'working' });
  });
});

// 우편 깨움(msg-wake)이 같은 생산 함수를 부를 때 쓰는 두 손잡이 — 자리 폴더(`herdr.pane`)가 이미 대상을 정했으니
// 라벨을 묻지 않고(anyAgent), 상태 확인과 제출 «사이»에 호출자 관문(재해석·opt-in·마감)을 한 번 끼운다(beforeSubmit).
describe('herdrPrompt — 호출자 손잡이(anyAgent · beforeSubmit)', () => {
  test('anyAgent 면 herdr 내장 kind(claude) pane 에도 같은 idle 확인 ⊕ pane run 으로 넣는다', async () => {
    const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'claude', status: 'idle' }] });
    const r = await herdrPrompt({ target: 'w1:p1', text: 'wake', anyAgent: true }, { run: h.run, log: () => {} });
    expect(r).toMatchObject({ ok: true, accepted: true, reason: 'submitted', agent: 'claude' });
    expect(h.submissions()).toEqual([{ paneId: 'w1:p1', text: 'wake' }]);
  });

  test('anyAgent 여도 working/blocked 는 입력 0', async () => {
    for (const [status, reason] of [['working', 'agent_working'], ['blocked', 'agent_blocked']] as const) {
      const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'claude', status }] });
      const r = await herdrPrompt({ target: 'w1:p1', text: 'wake', anyAgent: true }, { run: h.run, log: () => {} });
      expect(r).toMatchObject({ ok: false, accepted: false, reason });
      expect(h.submissions()).toEqual([]);
    }
  });

  test('beforeSubmit 이 이유를 내면 제출하지 않고 그 이유로 끝난다 · undefined 면 그대로 제출', async () => {
    const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }] });
    const seen: string[] = [];
    const stop = await herdrPrompt({ target: 'w1:p1', text: 'x' }, {
      run: h.run, log: () => {},
      beforeSubmit: (v) => { seen.push(`${v.paneId}:${v.status}`); return 'target-moved:w1:p9'; },
    });
    expect(stop).toMatchObject({ ok: false, accepted: false, reason: 'target-moved:w1:p9', status: 'idle' });
    expect(h.submissions()).toEqual([]);
    expect(seen).toEqual(['w1:p1:idle']);
    const go = await herdrPrompt({ target: 'w1:p1', text: 'x' }, { run: h.run, log: () => {}, beforeSubmit: () => undefined });
    expect(go).toMatchObject({ ok: true, accepted: true, reason: 'submitted' });
    expect(h.submissions()).toHaveLength(1);
  });
});

describe('paneFallback — agent get 이 agent_not_found 면 pane get agent_status 로', () => {
  const stub = (paneStatus: string | null) => {
    const calls: string[] = [];
    const run = async (argv: readonly string[]) => {
      calls.push(argv.slice(0, 2).join(' '));
      if (argv[0] === 'agent' && argv[1] === 'get') return { code: 1, stdout: '', stderr: `${JSON.stringify({ error: { code: 'agent_not_found', message: 'not found' }, id: 'cli:agent:get' })}\n` };
      if (argv[0] === 'pane' && argv[1] === 'get') return paneStatus === null
        ? { code: 1, stdout: '', stderr: `${JSON.stringify({ error: { code: 'pane_not_found', message: 'no pane' }, id: 'cli:pane:get' })}\n` }
        : { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: 'wK:p5', agent: 'claude', agent_status: paneStatus } } }), stderr: '' };
      if (argv[0] === 'pane' && argv[1] === 'run') return { code: 0, stdout: '{}', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return { run, calls };
  };

  test('켜면 idle pane 에 제출 · 끄면 지금처럼 agent_not_found', async () => {
    const on = stub('idle');
    const r = await herdrPrompt({ target: 'wK:p5', text: 'hi', anyAgent: true, paneFallback: true }, { run: on.run, log: () => {} });
    expect(r).toMatchObject({ accepted: true, reason: 'submitted', paneId: 'wK:p5', agent: 'claude', status: 'idle' });
    expect(on.calls).toEqual(['agent get', 'pane get', 'pane run']);
    const off = stub('idle');
    const r2 = await herdrPrompt({ target: 'wK:p5', text: 'hi', anyAgent: true }, { run: off.run, log: () => {} });
    expect(r2).toMatchObject({ accepted: false, reason: 'agent_not_found' });
    expect(off.calls).toEqual(['agent get']);
  });

  test('pane 도 없으면 원래 agent_not_found · working 이면 넣지 않는다', async () => {
    const gone = stub(null);
    expect(await herdrPrompt({ target: 'wK:p5', text: 'hi', anyAgent: true, paneFallback: true }, { run: gone.run, log: () => {} }))
      .toMatchObject({ accepted: false, reason: 'agent_not_found' });
    const busy = stub('working');
    expect(await herdrPrompt({ target: 'wK:p5', text: 'hi', anyAgent: true, paneFallback: true }, { run: busy.run, log: () => {} }))
      .toMatchObject({ accepted: false, reason: 'agent_working' });
    expect(busy.calls).not.toContain('pane run');
  });
});
