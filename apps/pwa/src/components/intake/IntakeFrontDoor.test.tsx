import { afterEach, describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { DaemonContext } from '@/components/providers/DaemonProvider';
import {
  IntakeFrontDoor,
  ROUTE_DEBOUNCE_MS,
  scheduleRoutePreview,
  type IntakeFrontDoorDeps,
  type IntakeFrontDoorState,
} from './IntakeFrontDoor';

const store = new Map<string, string>();

const localStorageStub: Storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => { store.clear(); },
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() { return store.size; },
};

Object.defineProperty(globalThis, 'localStorage', { value: localStorageStub, configurable: true });

const STUB_DAEMON = {
  config: { baseUrl: 'http://localhost:31415', token: '', provider: '' },
  setConfig: () => {},
  client: {
    fetchJson: async () => ({}),
    fetchResponse: async () => new Response('{}'),
  } as never,
  sessionId: 'sess-test',
  setSessionId: () => {},
};

function markup(state?: IntakeFrontDoorState, deps?: IntakeFrontDoorDeps): string {
  return renderToStaticMarkup(
    <DaemonContext.Provider value={STUB_DAEMON}>
      <IntakeFrontDoor state={state} deps={deps} />
    </DaemonContext.Provider>,
  );
}

function buttonTag(html: string, testId: string): string {
  return html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
}

function isEmphasized(html: string, testId: string): boolean {
  return /data-emphasized="true"/.test(buttonTag(html, testId));
}

function isDisabled(html: string, testId: string): boolean {
  const tag = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
  return /(?:^|\s)disabled(?:=""|(?=[\s>]))/.test(tag);
}

afterEach(() => {
  store.clear();
});

describe('IntakeFrontDoor', () => {
  test('칸이 비면 세 버튼이 모두 비활성', () => {
    const html = markup();
    expect(html).toContain('보내면 elanous 가 이 글을 처리합니다(흡수 · 작업 분할 · 그래프 실행).');
    expect(isDisabled(html, 'intake-absorb')).toBe(true);
    expect(isDisabled(html, 'intake-split')).toBe(true);
    expect(isDisabled(html, 'intake-graph')).toBe(true);
    expect(html).toContain('>흡수<');
    expect(html).toContain('>작업으로 나누기<');
    expect(html).toContain('>그래프로 실행<');
  });

  test('«그래프로 실행» 뒤 acceptanceId 가 화면에', () => {
    const html = markup({
      text: '그래프에 넣을 글',
      busy: false,
      error: null,
      absorbIds: null,
      acceptanceId: 'acc-screen-1',
      graph: { phase: 'launch-started', runId: 'run-9' },
      splitOpen: false,
      splitMemo: '',
      recent: [],
    });
    expect(isDisabled(html, 'intake-graph')).toBe(false);
    expect(html).toContain('data-testid="intake-acceptance-id"');
    expect(html).toContain('acc-screen-1');
    expect(html).toContain('launch-started');
    expect(html).toContain('run-9');
  });

  test('가짜 끝 사건을 받아 그래프 기록 줄에 단계·마지막 시각·완료 또는 실패를 표시한다', () => {
    const base: IntakeFrontDoorState = {
      text: '', busy: false, error: null, absorbIds: null, acceptanceId: 'acc-1',
      graph: { phase: 'launch-started', runId: 'run-9' }, splitOpen: false, splitMemo: '',
      recent: [{ track: 'graph', at: 't0', preview: '그래프 글', acceptanceId: 'acc-1', runId: 'run-9' }],
    };
    const completed = markup({ ...base, runEvents: { 'run-9': [
      { event: 'implemented', ts: 't1', runId: 'run-9', payload: { ok: true } },
      { event: 'run-terminal', ts: 't2', runId: 'run-9', payload: { runStatus: 'completed' } },
    ] } });
    expect(completed).toContain('data-testid="intake-run-stage"');
    expect(completed).toContain('data-testid="intake-run-last-event" dateTime="t2"');
    expect(completed.match(/<li[^>]*data-testid="intake-recent-row"[^>]*>.*?<\/li>/)?.[0]).toContain('완료');

    const failed = markup({ ...base, runEvents: { 'run-9': [
      { event: 'run-terminal', ts: 't3', runId: 'run-9', payload: { runStatus: 'failed', error: 'x\nsecret' } },
    ] } });
    const row = failed.match(/<li[^>]*data-testid="intake-recent-row"[^>]*>.*?<\/li>/)?.[0];
    expect(row).toContain('실패');
    expect(row).toContain('x');
    expect(row).not.toContain('secret');
  });

  test('runId 뒤 사건을 조회해 종료 시 폴링을 멈추고 화면을 떠나면 타이머를 정리한다', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    const intervals = new Map<number, { fn: () => void; ms: number }>();
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let sequence = 0;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const id = ++sequence;
      timers.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      const id = ++sequence;
      intervals.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: number) => { intervals.delete(id); }) as typeof clearInterval;
    try {
      const calls: string[] = [];
      let terminal = false;
      const daemon = {
        ...STUB_DAEMON,
        client: { fetchJson: async (path: string) => {
          calls.push(path);
          if (path.startsWith('/v1/harness/ask-status')) return { phase: 'launch-started', runId: 'run-9' };
          if (path.startsWith('/v1/harness/run-events')) return terminal
            ? [{ event: 'run-terminal', ts: 't2', runId: 'run-9', payload: { runStatus: 'failed', error: 'x' } }]
            : [{ event: 'implementing', ts: 't1', runId: 'run-9' }];
          return { acceptanceId: 'acc-1' };
        } } as never,
      };
      let tree!: ReturnType<typeof create>;
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><IntakeFrontDoor /></DaemonContext.Provider>); });
      await act(async () => { tree.root.findByProps({ 'data-testid': 'intake-front-door-field' }).props.onChange({ target: { value: '그래프 글' } }); });
      await act(async () => { tree.root.findByProps({ 'data-testid': 'intake-graph' }).props.onClick(); });
      expect(calls).toContain('/v1/harness/ask-status?acceptanceId=acc-1');
      expect(calls).toContain('/v1/harness/run-events?runId=run-9');
      expect([...timers.values()].some(({ ms }) => ms === 30_000)).toBe(true);
      now = 5 * 60_000 + 1;
      const askInterval = [...intervals.values()].find(({ ms }) => ms === 5_000);
      const askCalls = calls.filter((path) => path.startsWith('/v1/harness/ask-status')).length;
      await act(async () => { askInterval!.fn(); });
      expect(calls.filter((path) => path.startsWith('/v1/harness/ask-status'))).toHaveLength(askCalls);
      expect([...timers.values()].some(({ ms }) => ms === 30_000)).toBe(true);
      await act(async () => { tree.unmount(); });
      expect([...timers.values()].some(({ ms }) => ms === 30_000)).toBe(false);
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><IntakeFrontDoor /></DaemonContext.Provider>); });
      expect([...timers.values()].some(({ ms }) => ms === 30_000)).toBe(true);
      terminal = true;
      const [pollId, poll] = [...timers.entries()].find(([, { ms }]) => ms === 30_000)!;
      timers.delete(pollId);
      await act(async () => { poll.fn(); });
      expect(JSON.stringify(tree.toJSON())).toContain('실패');
      expect([...timers.values()].some(({ ms }) => ms === 30_000)).toBe(false);
      const count = calls.length;
      await act(async () => { tree.unmount(); });
      expect(calls).toHaveLength(count);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      Date.now = originalNow;
    }
  });

  test('흡수 기록의 id별 상태·노트를 표시하고 미완료/조회 실패만 60초마다 재시도하며 떠나면 멈춘다', async () => {
    store.set('elanous.intake.recent', JSON.stringify([{
      track: 'absorb', at: 't0', preview: '흡수할 글', ids: ['done', 'waiting', 'missing'],
    }]));
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let sequence = 0;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const id = ++sequence;
      timers.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
    const calls: string[] = [];
    let waitingDone = false;
    let missingFound = false;
    const daemon = { ...STUB_DAEMON, client: { fetchJson: async (path: string) => {
      calls.push(path);
      if (path.endsWith('/done')) return { id: 'done', status: 'absorbed', outputs: [
        { kind: 'goal', ref: 'goal-1' }, { kind: 'note', ref: 'notes/result.md' },
      ] };
      if (path.endsWith('/waiting')) return { id: 'waiting', status: waitingDone ? 'checked' : 'queued', outputs: [] };
      if (path.endsWith('/missing')) {
        if (!missingFound) throw new Error('404');
        return { id: 'missing', status: 'discarded', outputs: [] };
      }
      throw new Error(`unexpected path: ${path}`);
    } } as never };
    let tree: ReturnType<typeof create> | undefined;
    const advance = async () => {
      const due = [...timers.entries()].filter(([, { ms }]) => ms === 60_000);
      for (const [id] of due) timers.delete(id);
      await act(async () => { for (const [, timer] of due) timer.fn(); });
    };
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><IntakeFrontDoor /></DaemonContext.Provider>); });
      expect(calls).toEqual(['/v1/intake-ledger/items/done', '/v1/intake-ledger/items/waiting', '/v1/intake-ledger/items/missing']);
      const statuses = () => tree!.root.findAllByProps({ 'data-testid': 'intake-absorb-status' }).map((node) => node.children.join(''));
      expect(statuses()).toEqual([' · 흡수: 흡수됨 · notes/result.md', ' · 흡수: 대기 중', ' · 흡수: 찾을 수 없음']);
      expect(timers.size).toBe(2);
      waitingDone = true;
      missingFound = true;
      await advance();
      expect(calls).toEqual([
        '/v1/intake-ledger/items/done', '/v1/intake-ledger/items/waiting', '/v1/intake-ledger/items/missing',
        '/v1/intake-ledger/items/waiting', '/v1/intake-ledger/items/missing',
      ]);
      expect(statuses()).toEqual([' · 흡수: 흡수됨 · notes/result.md', ' · 흡수: 확인됨', ' · 흡수: 버림']);
      expect(timers.size).toBe(0);
      await act(async () => { tree!.unmount(); });
      expect(timers.size).toBe(0);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('첫 조회 대기 중은 찾을 수 없음이 아니며, 실패 후 재시도해 흡수 완료를 표시한다', async () => {
    store.set('elanous.intake.recent', JSON.stringify([{ track: 'absorb', at: 't0', preview: '글', ids: ['slow'] }]));
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let sequence = 0;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const id = ++sequence;
      timers.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
    let rejectFirst!: (error: Error) => void;
    let calls = 0;
    const daemon = { ...STUB_DAEMON, client: { fetchJson: async (path: string) => {
      expect(path).toBe('/v1/intake-ledger/items/slow');
      calls++;
      if (calls === 1) return new Promise((_, reject) => { rejectFirst = reject; });
      return { id: 'slow', status: 'absorbed', outputs: [{ kind: 'note', ref: 'notes/slow.md' }] };
    } } as never };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><IntakeFrontDoor /></DaemonContext.Provider>); });
      const status = () => tree!.root.findByProps({ 'data-testid': 'intake-absorb-status' }).children.join('');
      expect(calls).toBe(1);
      expect(status()).toBe(' · 흡수: 조회 중');
      expect(timers.size).toBe(0);
      await act(async () => { rejectFirst(new Error('temporarily unavailable')); });
      expect(status()).toBe(' · 흡수: 찾을 수 없음');
      const retry = [...timers.entries()].find(([, timer]) => timer.ms === 60_000)!;
      timers.delete(retry[0]);
      await act(async () => { retry[1].fn(); });
      expect(calls).toBe(2);
      expect(status()).toBe(' · 흡수: 흡수됨 · notes/slow.md');
      expect(timers.size).toBe(0);
      await act(async () => { tree!.unmount(); });
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('화면을 떠나면 아직 미완료인 흡수 기록의 타이머를 정리한다', async () => {
    store.set('elanous.intake.recent', JSON.stringify([{ track: 'absorb', at: 't0', preview: '글', ids: ['id-1'] }]));
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map<number, () => void>();
    let sequence = 0;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      expect(ms).toBe(60_000);
      const id = ++sequence;
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
    const calls: string[] = [];
    const daemon = { ...STUB_DAEMON, client: { fetchJson: async (path: string) => {
      calls.push(path);
      return { id: 'id-1', status: 'new', outputs: [] };
    } } as never };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><IntakeFrontDoor /></DaemonContext.Provider>); });
      expect(calls).toEqual(['/v1/intake-ledger/items/id-1']);
      expect(timers.size).toBe(1);
      await act(async () => { tree!.unmount(); });
      expect(timers.size).toBe(0);
      expect(calls).toHaveLength(1);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('새 흡수 id만 즉시 조회하고 기존 미완료 id의 60초 타이머는 유지한다', async () => {
    store.set('elanous.intake.recent', JSON.stringify([{
      track: 'absorb', at: 't0', preview: '기존 글', ids: ['old'],
    }]));
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let sequence = 0;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const id = ++sequence;
      timers.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
    const calls: string[] = [];
    const daemon = { ...STUB_DAEMON, client: { fetchJson: async (path: string) => {
      calls.push(path);
      if (path === '/v1/intake-ledger/items') return { ids: ['new'], added: 1, merged: 0 };
      if (path.startsWith('/v1/intake-ledger/items/')) return { id: path.split('/').at(-1), status: 'queued', outputs: [] };
      throw new Error(`unexpected path: ${path}`);
    } } as never };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><IntakeFrontDoor /></DaemonContext.Provider>); });
      const oldTimer = [...timers.entries()].find(([, timer]) => timer.ms === 60_000)!;
      expect(calls.filter((path) => path.endsWith('/old'))).toHaveLength(1);
      await act(async () => { tree!.root.findByProps({ 'data-testid': 'intake-front-door-field' }).props.onChange({ target: { value: '새 글' } }); });
      await act(async () => { tree!.root.findByProps({ 'data-testid': 'intake-absorb' }).props.onClick(); });
      expect(calls.filter((path) => path.endsWith('/old'))).toHaveLength(1);
      expect(calls.filter((path) => path.endsWith('/new'))).toHaveLength(1);
      expect(timers.get(oldTimer[0])).toBe(oldTimer[1]);
      expect(tree!.root.findAllByProps({ 'data-testid': 'intake-absorb-status' }).map((node) => node.children.join(''))).toEqual([
        ' · 흡수: 대기 중', ' · 흡수: 대기 중',
      ]);
      timers.delete(oldTimer[0]);
      await act(async () => { oldTimer[1].fn(); });
      expect(calls.filter((path) => path.endsWith('/old'))).toHaveLength(2);
      expect(calls.filter((path) => path.endsWith('/new'))).toHaveLength(1);
      await act(async () => { tree!.unmount(); });
      expect([...timers.values()].filter((timer) => timer.ms === 60_000)).toHaveLength(0);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('«흡수» 뒤 «대기열» 문구와 항목 id', () => {
    const html = markup({
      text: '흡수할 글',
      busy: false,
      error: null,
      absorbIds: ['item-1', 'item-2'],
      acceptanceId: null,
      graph: null,
      splitOpen: false,
      splitMemo: '',
      recent: [],
    });
    expect(html).toContain('대기열에 넣었습니다(아침 정기 흡수에서 처리)');
    expect(html).toContain('대기열');
    expect(html).toContain('item-1');
    expect(html).toContain('item-2');
  });

  test('작업으로 나누기는 칸의 글을 MemoIntakePreview initialMemo 로 연다', () => {
    const html = markup({
      text: '나눌 메모',
      busy: false,
      error: null,
      absorbIds: null,
      acceptanceId: null,
      graph: null,
      splitOpen: true,
      splitMemo: '나눌 메모',
      recent: [],
    });
    expect(html).toContain('data-testid="intake-split-host"');
    expect(html).toContain('data-testid="memo-intake-preview"');
    expect(html).toContain('나눌 메모');
  });

  test('최근 목록은 앞 40자만 보이고 원문 전체를 저장하지 않는다', async () => {
    const { intakeTextPreview } = await import('@/lib/intake-front-door-api');
    const raw = `원문-${'가'.repeat(80)}`;
    const preview = intakeTextPreview(raw);
    expect(preview).toHaveLength(40);
    expect(preview).not.toBe(raw);
    const html = markup({
      text: '',
      busy: false,
      error: null,
      absorbIds: null,
      acceptanceId: null,
      graph: null,
      splitOpen: false,
      splitMemo: '',
      recent: [{ track: 'absorb', at: '2026-09-26T00:00:00.000Z', preview, ids: ['id-1'] }],
    });
    expect(html).toContain(preview);
    expect(html).not.toContain(raw);
    expect(() => {
      try { localStorage.setItem('elanous.intake.recent', raw); } catch { /* 화면은 돈다 */ }
    }).not.toThrow();
  });

  test('runIntakeAction 흡수·그래프가 기존 입구를 부르고 원문 대신 앞 40자만 기록한다', async () => {
    const { runIntakeAction } = await import('./IntakeFrontDoor');
    const calls: { path: string; body?: unknown }[] = [];
    const client = {
      fetchJson: async (path: string, init?: RequestInit) => {
        calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (path === '/v1/intake-ledger/items') return { ids: ['a', 'b'], added: 2, merged: 0, seen: 0 };
        if (path === '/v1/harness/ask') return { acceptanceId: 'acc-9', accepted: true };
        return { phase: 'accepted' };
      },
    } as never;
    const long = `보세요 https://a.example/x https://b.example/y ${'끝'.repeat(50)}`;
    const absorbed = await runIntakeAction(client, 'absorb', long);
    expect(absorbed.absorbIds).toEqual(['a', 'b']);
    expect(calls[0]!.path).toBe('/v1/intake-ledger/items');
    expect((calls[0]!.body as { items: { url: string }[] }).items).toEqual([
      { url: 'https://a.example/x' },
      { url: 'https://b.example/y' },
    ]);
    expect(absorbed.recentPreview).toHaveLength(40);
    expect(absorbed.recentPreview).not.toBe(long);
    expect(JSON.stringify(absorbed)).not.toContain(long);

    const graphed = await runIntakeAction(client, 'graph', '그래프 글');
    expect(graphed.acceptanceId).toBe('acc-9');
    expect(calls[1]!.path).toBe('/v1/harness/ask');
    expect(calls[1]!.body).toEqual({ text: '그래프 글' });
  });

  test('가짜 판정 graph 는 칩에 그래프 · 그래프 버튼만 강조 · 자동 실행 0', () => {
    const html = markup({
      text: '이 저장소 보고 구현해줘',
      busy: false,
      error: null,
      absorbIds: null,
      acceptanceId: null,
      graph: null,
      splitOpen: false,
      splitMemo: '',
      recent: [],
      route: { track: 'graph', confidence: 0.9, reason: 'imperative-implement', decidedBy: 'rule' },
    });
    expect(html).toContain('data-testid="intake-route-chip"');
    expect(html).toContain('→ 그래프');
    expect(html).toContain('그래프');
    expect(html).toContain('imperative-implement');
    expect(html).toContain('data-auto-submit="0"');
    expect(isEmphasized(html, 'intake-graph')).toBe(true);
    expect(isEmphasized(html, 'intake-absorb')).toBe(false);
    expect(isEmphasized(html, 'intake-split')).toBe(false);
    expect(isDisabled(html, 'intake-absorb')).toBe(false);
    expect(isDisabled(html, 'intake-split')).toBe(false);
    expect(isDisabled(html, 'intake-graph')).toBe(false);
    expect(html).toContain('보내면 elanous 가 이 글을 처리합니다(흡수 · 작업 분할 · 그래프 실행).');
    expect(html).not.toContain('data-testid="intake-acceptance-id"');
    expect(html).not.toContain('대기열에 넣었습니다');
  });

  test('분류기 판정 · 낮은 확신 · 실패는 칩에서 서로 다른 문구이고 자동 실행은 없다', () => {
    const base: IntakeFrontDoorState = {
      text: '어느 갈래?', busy: false, error: null, absorbIds: null, acceptanceId: null,
      graph: null, splitOpen: false, splitMemo: '', recent: [],
    };
    const normal = markup({ ...base, route: { track: 'graph', confidence: 0.83, reason: 'intent', decidedBy: 'classifier' } });
    expect(normal).toContain('분류기 판정 · 확신 83%');
    expect(normal).toContain('data-auto-submit="0"');
    expect(isEmphasized(normal, 'intake-graph')).toBe(true);
    expect(normal).not.toContain('data-testid="intake-route-classify"');
    const low = markup({ ...base, route: { track: 'ask-human', confidence: 0.42, reason: 'classifier-low-confidence:tasks', decidedBy: 'classifier' } });
    expect(low).toContain('분류기 추정: 작업 (확신 낮음)');
    expect(low).toContain('분류기 판정 · 확신 42%');
    expect(isEmphasized(low, 'intake-graph')).toBe(false);
    const failed = markup({ ...base, route: { track: 'ask-human', confidence: 0, reason: 'classifier-failed:timeout', decidedBy: 'classifier' } });
    expect(failed).toContain('분류기가 못 갈랐습니다 — 직접 골라 주세요');
    expect(failed).toContain('data-auto-submit="0"');
  });

  test('규칙 미리보기에는 classify 가 없고 rule-unknown 버튼을 누를 때만 한 번 보낸다', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map<number, () => void>();
    let sequence = 0;
    globalThis.setTimeout = ((fn: () => void) => {
      const id = ++sequence;
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    let finish!: (value: unknown) => void;
    const daemon = { ...STUB_DAEMON, client: { fetchJson: async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (body.classify === true) return new Promise((resolve) => { finish = resolve; });
      return { track: 'ask-human', confidence: 0, reason: 'rule-unknown', decidedBy: 'rule' };
    } } as never };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><IntakeFrontDoor /></DaemonContext.Provider>); });
      await act(async () => { tree!.root.findByProps({ 'data-testid': 'intake-front-door-field' }).props.onChange({ target: { value: '어느 갈래?' } }); });
      expect(calls).toHaveLength(0);
      expect(timers.size).toBe(1);
      await act(async () => { [...timers.values()][0]!(); });
      expect(calls).toEqual([{ path: '/v1/intake/route', body: { text: '어느 갈래?', consent: 'route', source: 'pwa' } }]);
      const classifyButton = () => tree!.root.findByProps({ 'data-testid': 'intake-route-classify' });
      expect(classifyButton().props.children).toBe('분류기로 가르기');
      await act(async () => { classifyButton().props.onClick(); });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.body).toEqual({ text: '어느 갈래?', consent: 'route', source: 'pwa', classify: true });
      expect(classifyButton().props.disabled).toBe(true);
      await act(async () => { classifyButton().props.onClick(); });
      expect(calls).toHaveLength(2);
      await act(async () => { finish({ track: 'graph', confidence: 0.8, reason: 'intent', decidedBy: 'classifier' }); });
      expect(tree!.root.findByProps({ 'data-testid': 'intake-route-chip-classifier' }).children.join('')).toBe('분류기 판정 · 확신 80%');
      expect(tree!.root.findByProps({ 'data-testid': 'intake-graph' }).props['data-emphasized']).toBe('true');
      expect(calls.every((call) => call.path === '/v1/intake/route')).toBe(true);
      expect(JSON.stringify(tree!.toJSON())).not.toContain('intake-graph-result');
    } finally {
      if (tree) {
        const mounted = tree;
        await act(async () => { mounted.unmount(); });
      }
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('판정이 실패하면 칩이 없고 세 버튼은 그대로', () => {
    const html = markup({
      text: '판정 실패 글',
      busy: false,
      error: null,
      absorbIds: null,
      acceptanceId: null,
      graph: null,
      splitOpen: false,
      splitMemo: '',
      recent: [],
      route: null,
    });
    expect(html).not.toContain('data-testid="intake-route-chip"');
    expect(html).not.toContain('→ 그래프');
    expect(html).not.toContain('→ 흡수');
    expect(html).not.toContain('→ 직접 고르세요');
    expect(html).toContain('>흡수<');
    expect(html).toContain('>작업으로 나누기<');
    expect(html).toContain('>그래프로 실행<');
    expect(isEmphasized(html, 'intake-graph')).toBe(false);
    expect(isDisabled(html, 'intake-absorb')).toBe(false);
    expect(isDisabled(html, 'intake-split')).toBe(false);
    expect(isDisabled(html, 'intake-graph')).toBe(false);
  });

  test('입력이 멈추고 500ms 뒤에만 routeIntake 를 묻고 보내는 호출은 0', () => {
    const asks: { at: number; text: string }[] = [];
    const submits: string[] = [];
    let now = 0;
    const pending: { at: number; fn: () => void }[] = [];
    const clock = {
      setTimeout: (fn: () => void, ms: number) => {
        const handle = { at: now + ms, fn };
        pending.push(handle);
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        const index = pending.indexOf(handle as { at: number; fn: () => void });
        if (index >= 0) pending.splice(index, 1);
      },
    };
    const flush = (until: number) => {
      now = until;
      for (const item of [...pending]) {
        if (item.at <= now) item.fn();
      }
    };
    const cancel = scheduleRoutePreview('https://youtu.be/x', (value) => {
      asks.push({ at: now, text: value });
    }, clock);
    expect(ROUTE_DEBOUNCE_MS).toBe(500);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.at).toBe(500);
    flush(499);
    expect(asks).toHaveLength(0);
    expect(submits).toHaveLength(0);
    flush(500);
    expect(asks).toEqual([{ at: 500, text: 'https://youtu.be/x' }]);
    expect(submits).toHaveLength(0);
    cancel();
  });
});
