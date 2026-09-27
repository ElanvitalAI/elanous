/**
 * preview-tap-registry 계약 테스트 (PWA 파리티 P4 · 2026-07-12).
 *
 * terminal/list 가 반환하는 lastOutputAt(마지막 PTY 출력 시각) 계약 검증 —
 * 등록 시각으로 초기화되고 output tap 이 흐를 때마다 갱신된다. PreviewTerminal
 * 은 실제 PTY 를 물기 때문에 fake(탭 콜백만 노출)로 대체 — PaneFactory 미초기화
 * 경로는 registry 가 자체 fail-soft 처리한다.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  registerPreviewTerminalForWebTap,
  unregisterPreviewTerminalForWebTap,
  listAllPreviewTerminals,
  listPreviewTerminals,
  lookupPreviewTerminal,
  getRegisteredPreviewTerminalCount,
  __resetPreviewTapRegistry,
} from './preview-tap-registry.js';
import type { PreviewTerminal } from '../preview/terminal.js';
import type { AcpServerHandle } from '../acp/server.js';

function makeFakePt(): { pt: PreviewTerminal; emit: (chunk: string) => void } {
  const taps = new Set<(chunk: string) => void>();
  const pt = {
    pid: 12345,
    cols: 80,
    rows: 24,
    isAlive: true,
    addRawOutputTap(cb: (chunk: string) => void) {
      taps.add(cb);
      return () => { taps.delete(cb); };
    },
  } as unknown as PreviewTerminal;
  return { pt, emit: (chunk) => { for (const tap of taps) tap(chunk); } };
}

const fakeHandle = {
  terminalOutput: async () => { /* broadcast noop */ },
} as unknown as AcpServerHandle;

afterEach(() => { __resetPreviewTapRegistry(); });

describe('listPreviewTerminals — lastOutputAt (P4)', () => {
  it('등록 직후엔 등록 시각으로 초기화된다', () => {
    const { pt } = makeFakePt();
    const before = Date.now();
    registerPreviewTerminalForWebTap(pt, 'sid-1', 'term-1', fakeHandle);
    const [entry] = listPreviewTerminals('sid-1');
    expect(entry).toBeDefined();
    expect(entry!.terminalId).toBe('term-1');
    expect(entry!.isAlive).toBe(true);
    expect(entry!.firstRegisteredAt).toBeGreaterThanOrEqual(before);
    expect(entry!.firstRegisteredAt).toBeLessThanOrEqual(Date.now());
    expect(entry!.lastOutputAt).toBe(entry!.firstRegisteredAt);
  });

  it('output tap 이 흐르면 lastOutputAt 이 전진한다', async () => {
    const { pt, emit } = makeFakePt();
    registerPreviewTerminalForWebTap(pt, 'sid-1', 'term-1', fakeHandle);
    const t0 = listPreviewTerminals('sid-1')[0]!.lastOutputAt;
    await new Promise((r) => setTimeout(r, 5));
    emit('$ echo hi\r\n');
    const t1 = listPreviewTerminals('sid-1')[0]!.lastOutputAt;
    expect(t1).toBeGreaterThan(t0);
  });

  it('다른 sessionId 목록엔 나타나지 않는다 (세션 스코프 유지)', () => {
    const { pt } = makeFakePt();
    registerPreviewTerminalForWebTap(pt, 'sid-1', 'term-1', fakeHandle);
    expect(listPreviewTerminals('sid-other')).toEqual([]);
  });

  it('전역 열거는 같은 이름의 다른 세션 터미널을 각각 소속 세션과 함께 반환한다', () => {
    const { pt: first } = makeFakePt();
    const { pt: second } = makeFakePt();
    registerPreviewTerminalForWebTap(first, 'sid-1', 'preview', fakeHandle);
    registerPreviewTerminalForWebTap(second, 'sid-2', 'preview', fakeHandle);

    expect(listAllPreviewTerminals())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: 'sid-1', terminalId: 'preview' }),
        expect.objectContaining({ sessionId: 'sid-2', terminalId: 'preview' }),
      ]));
    expect(listAllPreviewTerminals()).toHaveLength(2);
    expect(listPreviewTerminals('sid-1')).toEqual([
      expect.objectContaining({ sessionId: 'sid-1', terminalId: 'preview' }),
    ]);
  });

  it('재등록은 출력 후에도 최초 시각을 보존하고 새 터미널 상태를 반영한다', async () => {
    const { pt, emit } = makeFakePt();
    registerPreviewTerminalForWebTap(pt, 'sid-1', 'term-1', fakeHandle);
    const firstRegisteredAt = listPreviewTerminals('sid-1')[0]!.firstRegisteredAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    emit('$ echo hi\r\n');
    const afterOutput = listPreviewTerminals('sid-1')[0]!;
    expect(afterOutput.lastOutputAt).toBeGreaterThan(firstRegisteredAt);
    expect(afterOutput.firstRegisteredAt).toBe(firstRegisteredAt);
    (pt as unknown as { cols: number; rows: number; isAlive: boolean }).cols = 120;
    (pt as unknown as { cols: number; rows: number; isAlive: boolean }).rows = 40;
    (pt as unknown as { cols: number; rows: number; isAlive: boolean }).isAlive = false;

    registerPreviewTerminalForWebTap(pt, 'sid-1', 'term-2', fakeHandle);

    expect(listPreviewTerminals('sid-1')).toEqual([
      expect.objectContaining({
        sessionId: 'sid-1',
        terminalId: 'term-2',
        cols: 120,
        rows: 40,
        isAlive: false,
        firstRegisteredAt,
        lastOutputAt: firstRegisteredAt,
      }),
    ]);
  });

  it('one shell can serve two sessions; detaching one retains the other tap and lookup', () => {
    const { pt, emit } = makeFakePt();
    const sent: Array<[string, string, string]> = [];
    const handle = {
      terminalOutput: async (sid: string, tid: string, chunk: string) => {
        sent.push([sid, tid, chunk]);
        return true;
      },
    } as unknown as AcpServerHandle;
    const detachA = registerPreviewTerminalForWebTap(pt, 'sid-a', 'term-x', handle);
    const detachB = registerPreviewTerminalForWebTap(pt, 'sid-b', 'term-x', handle);
    expect(getRegisteredPreviewTerminalCount()).toBe(1);
    expect(listAllPreviewTerminals()).toHaveLength(1);
    expect(listPreviewTerminals('sid-a')).toEqual([expect.objectContaining({ sessionId: 'sid-a', terminalId: 'term-x' })]);
    expect(listPreviewTerminals('sid-b')).toEqual([expect.objectContaining({ sessionId: 'sid-b', terminalId: 'term-x' })]);
    expect(lookupPreviewTerminal('sid-b', 'term-x')).toBe(pt);
    emit('before');
    expect(sent).toEqual([['sid-a', 'term-x', 'before'], ['sid-b', 'term-x', 'before']]);

    detachA();
    expect(lookupPreviewTerminal('sid-a', 'term-x')).toBeNull();
    expect(lookupPreviewTerminal('sid-b', 'term-x')).toBe(pt);
    expect(listPreviewTerminals('sid-a')).toEqual([]);
    expect(listAllPreviewTerminals()).toHaveLength(1);
    emit('after');
    expect(sent.at(-1)).toEqual(['sid-b', 'term-x', 'after']);
    detachB();
    expect(listAllPreviewTerminals()).toEqual([]);
  });

  it('replacing a session tap leaves the other session attached and does not duplicate output', () => {
    const { pt, emit } = makeFakePt();
    const sent: string[] = [];
    const handle = { terminalOutput: async (sid: string) => { sent.push(sid); return true; } } as unknown as AcpServerHandle;
    const staleDetach = registerPreviewTerminalForWebTap(pt, 'sid-a', 'term-x', handle);
    registerPreviewTerminalForWebTap(pt, 'sid-b', 'term-x', handle);
    registerPreviewTerminalForWebTap(pt, 'sid-a', 'term-x', handle);
    staleDetach();
    emit('once');
    expect(sent.sort()).toEqual(['sid-a', 'sid-b']);
    expect(listAllPreviewTerminals()).toHaveLength(1);
  });

  it('해제한 터미널은 전역 열거에서 제거된다', () => {
    const { pt } = makeFakePt();
    registerPreviewTerminalForWebTap(pt, 'sid-1', 'term-1', fakeHandle);
    unregisterPreviewTerminalForWebTap(pt);
    expect(listAllPreviewTerminals()).toEqual([]);
  });
});
