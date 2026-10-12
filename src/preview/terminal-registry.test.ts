// P0b-2 — PreviewTerminal 의 registry-backed 모드(useRegistry:true) 테스트. dup-fd 대신 공유
//   registry 버스(startPty/onPtyEvent)로 spawn·출력수신·write/resize/stop 위임되는지 DI 로 검증.
//   (mock.module 은 프로세스 전역 오염 → 주입 seam 사용. 기본 dup-fd 경로는 라이브라 여기서 미검증.)
import { readFileSync } from 'node:fs';
import { test, expect, describe } from 'bun:test';
import { PreviewTerminal, type PreviewRegistryDeps } from './terminal.js';

function stub() {
  const listeners: Array<(ev: unknown) => void> = [];
  const handle = {
    id: 'preview_abc',
    writes: [] as string[],
    resizes: [] as Array<[number, number]>,
    kills: [] as Array<string | undefined>,
    write(s: string) { this.writes.push(s); },
    resize(cols: number, rows: number) { this.resizes.push([cols, rows]); },
    kill(sig?: NodeJS.Signals) { this.kills.push(sig); },
  };
  let startOpts: Record<string, unknown> = {};
  const unregistered: string[] = [];
  const deps = {
    startPty: (o: unknown) => { startOpts = o as Record<string, unknown>; return handle; },
    onPtyEvent: (cb: (ev: unknown) => void) => { listeners.push(cb); return () => {}; },
    unregisterPty: (id: string) => { unregistered.push(id); return true; },
  } as unknown as PreviewRegistryDeps;
  const emit = (ev: unknown) => { for (const l of listeners) l(ev); };
  return { deps, handle, emit, unregistered, getStartOpts: () => startOpts };
}

describe('PreviewTerminal useRegistry (P0b-2 · 공유 버스 흡수)', () => {
  test('start → startPty(kind=preview·accessMode=write)·dup-fd 미사용', () => {
    const s = stub();
    const raw: string[] = [];
    const pt = new PreviewTerminal(
      { cols: 80, rows: 24, cwd: '/tmp', env: {}, useRegistry: true, onRawOutput: (c) => raw.push(c) },
      undefined, s.deps,
    );
    pt.start();
    const o = s.getStartOpts();
    expect(o.kind).toBe('preview');
    expect(o.accessMode).toBe('write');
    expect(o.workdir).toBe('/tmp');
    expect(pt.isAlive).toBe(true);
    pt.stop();
  });

  test('onPtyEvent output → 매칭 id 만 에뮬레이터/raw 탭에 도달', () => {
    const s = stub();
    const raw: string[] = [];
    const pt = new PreviewTerminal(
      { cols: 80, rows: 24, cwd: '/tmp', env: {}, useRegistry: true, onRawOutput: (c) => raw.push(c) },
      undefined, s.deps,
    );
    pt.start();
    s.emit({ type: 'output', id: 'preview_abc', chunk: 'hello' }); // 통과
    s.emit({ type: 'output', id: 'other', chunk: 'nope' });        // 다른 id
    expect(raw).toEqual(['hello']);
    pt.stop();
  });

  test('write/resize 는 registry handle 로 위임', () => {
    const s = stub();
    const pt = new PreviewTerminal({ cols: 80, rows: 24, cwd: '/tmp', env: {}, useRegistry: true }, undefined, s.deps);
    pt.start();
    pt.write('ls\n');
    pt.resize(100, 30);
    expect(s.handle.writes).toEqual(['ls\n']);
    expect(s.handle.resizes).toEqual([[100, 30]]); // PreviewTerminal.resize(cols,rows)=PtyHandle.resize(cols,rows) 동순
    pt.stop();
  });

  test('output exit → onExit 콜백·alive false', () => {
    const s = stub();
    const exits: Array<number | null> = [];
    const pt = new PreviewTerminal(
      { cols: 80, rows: 24, cwd: '/tmp', env: {}, useRegistry: true, onExit: (c) => exits.push(c) },
      undefined, s.deps,
    );
    pt.start();
    s.emit({ type: 'exit', id: 'preview_abc', exitCode: 0 });
    expect(exits).toEqual([0]);
    expect(pt.isAlive).toBe(false);
    pt.stop();
  });

  test('stop → handle kill + registry 등록해제(척추에서 제거)', () => {
    const s = stub();
    const pt = new PreviewTerminal({ cols: 80, rows: 24, cwd: '/tmp', env: {}, useRegistry: true }, undefined, s.deps);
    pt.start();
    pt.stop();
    expect(s.handle.kills).toEqual(['SIGHUP']);
    expect(s.unregistered).toEqual(['preview_abc']);
  });
});

// LINUX-SELF-UPDATE-NODEPTY — PWA `next build` 가 이 파일을 타입 검사하므로, node-pty(optionalDependency)가 빠진
//   리눅스 설치에서 빌드가 죽지 않으려면 «정적» import 가 하나도 없어야 한다(런타임은 require 로 늦게 싣는다).
test('terminal.ts 는 node-pty 를 정적으로 import 하지 않는다(import type 포함)', () => {
  const src = readFileSync(new URL('./terminal.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/^\s*import\b[^;]*['"]node-pty(\/[^'"]*)?['"]/m);
  expect(src).not.toMatch(/\bimport\(\s*['"]node-pty/);
});
