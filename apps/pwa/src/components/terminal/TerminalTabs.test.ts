import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  loadTabIds, nextDefaultId, resolveNewTabId, saveTabIds, shouldReacquireAcp,
  spawnNewTerminal, summarizeTabs, tabCountLabel, tabsCleanableAsUnknown, parseTerminalListResponse,
} from './TerminalTabs';
import { originChipText, originTooltipText, terminalOriginLabel } from './terminal-origin-label';

interface FakeWindowEnv {
  store: Map<string, string>;
  restore: () => void;
}

function withFakeWindow(): FakeWindowEnv {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage };
  return {
    store,
    restore: () => {
      (globalThis as { window?: unknown }).window = originalWindow;
    },
  };
}

const STORAGE_KEY = 'elanous.webterm.tabs';

describe('TerminalTabs storage helpers', () => {
  let env: FakeWindowEnv;

  beforeEach(() => { env = withFakeWindow(); });
  afterEach(() => { env.restore(); });

  test('persists ids under the established key and selects the smallest unused preview id', () => {
    saveTabIds(['preview-1', 'preview-3']);

    expect(env.store.get(STORAGE_KEY)).toBe('["preview-1","preview-3"]');
    expect(loadTabIds()).toEqual(['preview-1', 'preview-3']);
    expect(nextDefaultId(loadTabIds())).toBe('preview-2');
  });

  test('returns an empty list without throwing for malformed or non-array storage values', () => {
    env.store.set(STORAGE_KEY, 'not json');
    expect(() => loadTabIds()).not.toThrow();
    expect(loadTabIds()).toEqual([]);

    env.store.set(STORAGE_KEY, JSON.stringify({ id: 'preview-1' }));
    expect(() => loadTabIds()).not.toThrow();
    expect(loadTabIds()).toEqual([]);
  });
});

describe('TerminalTabs storage helpers outside the browser', () => {
  test('reads an empty list and skips writes during server rendering', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    try {
      delete (globalThis as { window?: unknown }).window;
      expect(loadTabIds()).toEqual([]);
      expect(() => saveTabIds(['preview-1'])).not.toThrow();
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });
});

describe('a failed list must not read as "the daemon knows zero terminals"', () => {
  // 🩸 이 계약이 없던 판에서, 응답 없음이 빈 목록이 되어 «모든 탭»이 정리 대상이 됐다.
  //    조회 실패가 탭 전멸로 이어지는 경로였다. 리뷰 must-fix.
  test('an empty list the daemon really sent is a success — zero is a real answer here', () => {
    expect(parseTerminalListResponse({ sessionId: 's', terminals: [] }))
      .toEqual({ ok: true, entries: [] });
  });

  test('a missing response is not zero terminals', () => {
    expect(parseTerminalListResponse(undefined)).toEqual({ ok: false, reason: 'no-response' });
    expect(parseTerminalListResponse(null)).toEqual({ ok: false, reason: 'no-response' });
  });

  test('a response without a terminals array is not zero terminals either', () => {
    expect(parseTerminalListResponse({ sessionId: 's' })).toEqual({ ok: false, reason: 'malformed' });
    expect(parseTerminalListResponse({ terminals: 'nope' })).toEqual({ ok: false, reason: 'malformed' });
    expect(parseTerminalListResponse('surprise')).toEqual({ ok: false, reason: 'malformed' });
  });

  test('carries the entries through when they are real', () => {
    const r = parseTerminalListResponse({ terminals: [{ terminalId: 'a', isAlive: true }] });
    expect(r).toEqual({ ok: true, entries: [{ terminalId: 'a', isAlive: true }] });
  });

  test('preserves a recognized ownerRunUsage for the explicit termination confirmation', () => {
    expect(parseTerminalListResponse({ terminals: [{ terminalId: 'a', isAlive: true, ownerRunUsage: 'running' }] }))
      .toEqual({ ok: true, entries: [{ terminalId: 'a', isAlive: true, ownerRunUsage: 'running' }] });
  });
});

describe('the header stops hiding the tabs the daemon does not know', () => {
  // 실측 배치: 데몬 재시작 뒤 로컬 13 · 살아있음 1 · 나머지 12 는 데몬이 모른다.
  const live = new Map<string, boolean>([['a', true], ['b', false]]);
  const isAlive = (id: string) => live.get(id);

  test('splits the tabs three ways instead of collapsing the remainder into silence', () => {
    expect(summarizeTabs(['a', 'b', 'ghost1', 'ghost2'], isAlive))
      .toEqual({ total: 4, alive: 1, daemonKnownDead: 1, daemonUnknown: 2 });
  });

  test('names the unknown ones in the label — the old text said only "N terminals · M alive"', () => {
    expect(tabCountLabel(summarizeTabs(['a', 'b', 'ghost1', 'ghost2'], isAlive), true))
      .toBe('4 terminals · 1 alive · 1 종료 · 2 데몬이 모름');
  });

  test('says "미확인" rather than "0 unknown" before any successful daemon list', () => {
    // ⛔ 아직 못 물어본 것을 「데몬이 모른다 0」으로 내면 그것이 «그럴듯한 0» 이다.
    expect(tabCountLabel(summarizeTabs(['a'], () => undefined), false))
      .toBe('1 terminal · 데몬 상태 미확인');
  });

  test('stays quiet when every tab is alive — no noise to read past', () => {
    expect(tabCountLabel(summarizeTabs(['a'], isAlive), true)).toBe('1 terminal · 1 alive');
  });
});

describe('cleanup removes only what the daemon does not know, and never the active tab', () => {
  const live = new Map<string, boolean>([['a', true], ['b', false]]);
  const isAlive = (id: string) => live.get(id);

  test('offers the daemon-unknown tabs', () => {
    expect(tabsCleanableAsUnknown(['a', 'b', 'ghost1', 'ghost2'], isAlive, 'a'))
      .toEqual(['ghost1', 'ghost2']);
  });

  test('keeps the active tab even when the daemon does not know it — it may be queued for spawn', () => {
    expect(tabsCleanableAsUnknown(['ghost1', 'ghost2'], isAlive, 'ghost1')).toEqual(['ghost2']);
  });

  test('keeps a tab the daemon knows to be dead — that is a real terminal that exited, not a ghost', () => {
    expect(tabsCleanableAsUnknown(['b'], isAlive, 'a')).toEqual([]);
  });
});

describe('a dead ACP connection is reacquired instead of polled forever', () => {
  test('reacquires when the socket died — this is the state the daemon restart leaves behind', () => {
    expect(shouldReacquireAcp('FAILED')).toBe(true);
    expect(shouldReacquireAcp('CLOSED')).toBe(true);
  });

  test('reacquires when nothing is held yet, so the first poll does not silently return', () => {
    expect(shouldReacquireAcp(null)).toBe(true);
  });

  test('keeps a live connection so a healthy poll does not churn the transport', () => {
    expect(shouldReacquireAcp('OPEN')).toBe(false);
  });

  test('keeps a still-handshaking connection — discarding it would rebuild on every poll and self-storm', () => {
    expect(shouldReacquireAcp('CONNECTING')).toBe(false);
  });
});

describe('new-terminal spawn observability', () => {
  test('records entry then a distinct skip reason when no ACP connection exists', async () => {
    const logs: Array<[string, unknown]> = [];
    // ⛔ 「사유 없는 undefined」가 아니라 «사유를 실은» 값이어야 한다 — 예외와 응답 없음이 같은
    //    칸에 들어가면 화면·관측이 사실과 다른 사유를 말한다(무인 리뷰 must-fix · 2026-08-18).
    await expect(spawnNewTerminal(null, 's1', (category, snapshot) => logs.push([category, snapshot])))
      .resolves.toEqual({ spawnFailure: 'no-acp' });

    expect(logs).toEqual([
      ['webterm.tabs.add.start', { hasAcp: false, hasSessionId: true }],
      ['webterm.tabs.add.skip', { reason: 'no-acp' }],
    ]);
  });

  test('records entry then a distinct skip reason when no session exists', async () => {
    const logs: Array<[string, unknown]> = [];
    const acp = { send: () => Promise.resolve({ terminalId: 'never-used' }) };
    await expect(spawnNewTerminal(acp, null, (category, snapshot) => logs.push([category, snapshot])))
      .resolves.toEqual({ spawnFailure: 'no-session' });

    expect(logs).toEqual([
      ['webterm.tabs.add.start', { hasAcp: true, hasSessionId: false }],
      ['webterm.tabs.add.skip', { reason: 'no-session' }],
    ]);
  });

  test('records pending before a successful daemon response', async () => {
    const logs: Array<[string, unknown]> = [];
    const response = { terminalId: 'webterm-m7k2x1' };
    const acp = { send: (method: string, params: { sessionId: string }) => {
      expect(method).toBe('terminal/spawn');
      expect(params).toEqual({ sessionId: 's1' });
      return Promise.resolve(response);
    } };

    await expect(spawnNewTerminal(acp, 's1', (category, snapshot) => logs.push([category, snapshot])))
      .resolves.toBe(response);
    expect(logs).toEqual([
      ['webterm.tabs.add.start', { hasAcp: true, hasSessionId: true }],
      ['webterm.tabs.add.spawn-pending', { sessionId: 's1' }],
    ]);
  });

  test('records pending synchronously while the daemon response remains unresolved', async () => {
    const logs: Array<[string, unknown]> = [];
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>((done) => { resolve = done; });
    const acp = { send: () => pending };
    const request = spawnNewTerminal(acp, 's1', (category, snapshot) => logs.push([category, snapshot]));

    expect(logs).toEqual([
      ['webterm.tabs.add.start', { hasAcp: true, hasSessionId: true }],
      ['webterm.tabs.add.spawn-pending', { sessionId: 's1' }],
    ]);
    resolve({ terminalId: 'webterm-m7k2x1' });
    await expect(request).resolves.toEqual({ terminalId: 'webterm-m7k2x1' });
  });

  test('preserves the established spawn-error observation after a rejected request', async () => {
    const logs: Array<[string, unknown]> = [];
    const acp = { send: () => Promise.reject(new Error('offline')) };
    // ⭐ 예외 문면을 «보존»한다 — `no-response` 로 뭉개면 사람이 원인을 못 좁힌다.
    await expect(spawnNewTerminal(acp, 's1', (category, snapshot) => logs.push([category, snapshot])))
      .resolves.toEqual({ spawnFailure: 'spawn-error', detail: 'Error: offline' });

    expect(logs).toEqual([
      ['webterm.tabs.add.start', { hasAcp: true, hasSessionId: true }],
      ['webterm.tabs.add.spawn-pending', { sessionId: 's1' }],
      ['webterm.tabs.add.spawn-error', { reason: 'Error: offline' }],
    ]);
  });
});

describe('WT-B4 — new tab ids come from the daemon', () => {
  test('uses the terminal id the daemon issued instead of inventing a local name', () => {
    expect(resolveNewTabId({ sessionId: 's', terminalId: 'webterm-m7k2x1', status: 'spawned' }, ['preview-1']))
      .toEqual({ id: 'webterm-m7k2x1', issuedBy: 'daemon' });
  });

  test('an already-known daemon id is reported as daemon-issued so the caller can dedupe rather than rename', () => {
    expect(resolveNewTabId({ terminalId: 'preview-1' }, ['preview-1']))
      .toEqual({ id: 'preview-1', issuedBy: 'daemon' });
  });

  test('falls back to a local name and says why when the daemon never answered', () => {
    expect(resolveNewTabId(undefined, ['preview-1']))
      .toEqual({ id: 'preview-2', issuedBy: 'local', fallbackReason: 'no-response' });
  });

  test('separates "no answer" from "answered without an id" so a zero daemon-issued count is readable', () => {
    expect(resolveNewTabId({ sessionId: 's', status: 'spawned' }, ['preview-1', 'preview-2']))
      .toEqual({ id: 'preview-3', issuedBy: 'local', fallbackReason: 'response-without-terminal-id' });
  });

  test('rejects an empty, whitespace-only or non-string terminal id rather than naming a tab after it', () => {
    // 공백만 있는 id 는 탭 라벨로 «보이지 않아» 사람이 그 탭을 가리킬 수 없다.
    expect(resolveNewTabId({ terminalId: '' }, [])).toMatchObject({ id: 'preview-1', issuedBy: 'local' });
    expect(resolveNewTabId({ terminalId: '   ' }, [])).toMatchObject({ id: 'preview-1', issuedBy: 'local' });
    expect(resolveNewTabId({ terminalId: '\t\n' }, [])).toMatchObject({ id: 'preview-1', issuedBy: 'local' });
    expect(resolveNewTabId({ terminalId: 42 }, [])).toMatchObject({ id: 'preview-1', issuedBy: 'local' });
    expect(resolveNewTabId(null, [])).toMatchObject({ id: 'preview-1', issuedBy: 'local', fallbackReason: 'no-response' });
  });

  test('keeps a daemon id that merely has surrounding whitespace-free content, without trimming it', () => {
    // trim 은 «판정»에만 쓴다 — 데몬이 준 문자열을 우리가 고쳐 쓰면
    // 그 id 로 오는 terminalOutput 봉투와 짝이 어긋난다.
    expect(resolveNewTabId({ terminalId: ' webterm-m7k2x1 ' }, []))
      .toEqual({ id: ' webterm-m7k2x1 ', issuedBy: 'daemon' });
  });
});

describe('a malformed list entry is not "the daemon knows this terminal"', () => {
  // 🩸 배열이라는 것만 믿고 t.terminalId 를 읽던 판에서는 [null] 하나가 폴 루프를 던졌다.
  test('rejects a null entry instead of throwing later', () => {
    expect(parseTerminalListResponse({ terminals: [null] })).toEqual({ ok: false, reason: 'malformed' });
  });

  test('rejects an entry without a usable terminalId — whitespace included, matching resolveNewTabId in this same file', () => {
    expect(parseTerminalListResponse({ terminals: [{ isAlive: true }] })).toEqual({ ok: false, reason: 'malformed' });
    expect(parseTerminalListResponse({ terminals: [{ terminalId: '', isAlive: true }] })).toEqual({ ok: false, reason: 'malformed' });
    expect(parseTerminalListResponse({ terminals: [{ terminalId: '   ', isAlive: true }] })).toEqual({ ok: false, reason: 'malformed' });
    expect(parseTerminalListResponse({ terminals: [{ terminalId: '\t\n', isAlive: true }] })).toEqual({ ok: false, reason: 'malformed' });
  });

  test('drops optional fields whose runtime type is wrong instead of letting the type lie', () => {
    expect(parseTerminalListResponse({ terminals: [{ terminalId: 'a', isAlive: true, pid: 'nope', cols: NaN, lastOutputAt: 5 }] }))
      .toEqual({ ok: true, entries: [{ terminalId: 'a', isAlive: true, lastOutputAt: 5 }] });
  });

  test('rejects an entry whose isAlive is not a boolean — that field decides the whole three-way split', () => {
    expect(parseTerminalListResponse({ terminals: [{ terminalId: 'a' }] })).toEqual({ ok: false, reason: 'malformed' });
    expect(parseTerminalListResponse({ terminals: [{ terminalId: 'a', isAlive: 'yes' }] })).toEqual({ ok: false, reason: 'malformed' });
  });

  test('accepts a well-formed entry', () => {
    expect(parseTerminalListResponse({ terminals: [{ terminalId: 'a', isAlive: true }] }))
      .toEqual({ ok: true, entries: [{ terminalId: 'a', isAlive: true }] });
  });
});

describe('TerminalTabs terminal provenance parsing', () => {
  test('preserves all optional provenance and controller metadata from a current daemon', () => {
    expect(parseTerminalListResponse({ terminals: [{
      terminalId: 'external', isAlive: true, terminalOriginCategory: 'external-tool',
      terminalOriginReason: 'launched by integration', externalToolName: 'codex', controller: 'codex-agent',
    }] })).toEqual({ ok: true, entries: [{
      terminalId: 'external', isAlive: true, terminalOriginCategory: 'external-tool',
      terminalOriginReason: 'launched by integration', externalToolName: 'codex', controller: 'codex-agent',
    }] });
  });

  test('drops malformed optional provenance metadata and keeps legacy entries parseable', () => {
    expect(parseTerminalListResponse({ terminals: [{ terminalId: 'legacy', isAlive: true, terminalOriginCategory: 'human', terminalOriginReason: 4, externalToolName: false, controller: null }] }))
      .toEqual({ ok: true, entries: [{ terminalId: 'legacy', isAlive: true }] });
  });

  test('uses moved origin labels for parsed daemon entries', () => {
    const result = parseTerminalListResponse({ terminals: [
      { terminalId: 'human', isAlive: true, terminalOriginCategory: 'direct-human' },
      { terminalId: 'legacy', isAlive: true },
    ] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(originChipText(result.entries[0])).toBe('사람');
    expect(terminalOriginLabel(result.entries[0])).toBe('사람');
    expect(originChipText(result.entries[1])).toBe('');
    expect(originTooltipText(result.entries[1])).toBe('출처: 이 행에서는 알 수 없음');
  });
});
