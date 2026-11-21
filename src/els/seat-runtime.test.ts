import { expect, test } from 'bun:test';
import { findSeatRuntime, matchSeatRuntime, runtimeProcessIdentity, SeatRuntimeRegistry, type RuntimeProcess } from './seat-runtime.js';

test('tool classification follows the registered runtime ancestry without requiring credentials', () => {
  const processes = new Map([proc(200, 1, 'codex'), proc(400, 200, 'els'), proc(500, 200, 'bun'), proc(600, 1, 'bun')].map(p => [p.pid, p]));
  const registry = new SeatRuntimeRegistry(pid => processes.get(pid));
  expect(registry.register(400, 501, processes.get(400), { pid: 200, start: '200:1' })).toBe(true);
  const peer = processes.get(500)!;
  expect(registry.isDescendant(500, 501, peer)).toBe(true);
  expect(registry.isDescendant(600, 501, processes.get(600))).toBe(false);
  expect(registry.isDescendant(500, 502, peer)).toBe(false);
  processes.set(500, proc(500, 200, 'bun', 'reused'));
  expect(registry.isDescendant(500, 501, peer)).toBe(false);
  processes.set(200, proc(200, 1, 'codex', 'reused'));
  expect(registry.isDescendant(500, 501, processes.get(500))).toBe(false);
});

test('pane registration rejects a runtime outside the pinned pane shell generation', () => {
  const processes = new Map([proc(100, 1, 'zsh'), proc(200, 100, 'codex'), proc(400, 200, 'els'), proc(500, 1, 'zsh')].map(p => [p.pid, p]));
  const registry = new SeatRuntimeRegistry(pid => processes.get(pid));
  const peer = processes.get(400)!;
  const claim = { pid: 200, start: '200:1' };
  expect(registry.register(400, 501, peer, claim, { pid: 500, start: '500:1' })).toBe(false);
  expect(registry.registrationToken()).toBeUndefined();
  expect(registry.register(400, 501, peer, claim, { pid: 100, start: 'stale' })).toBe(false);
  expect(registry.register(400, 501, peer, claim, { pid: 100, start: '100:1' })).toBe(true);
});

test('registration rejects a peer replaced during ancestry lookup', () => {
  const original = proc(400, 200, 'els');
  let calls = 0;
  const registry = new SeatRuntimeRegistry(pid => pid === 200 ? proc(200, 1, 'codex') : pid === 400 ? (++calls < 3 ? original : proc(400, 200, 'els', 'reused')) : undefined);
  expect(registry.register(400, 501, original, { pid: 200, start: '200:1' })).toBe(false);
});

test('registered runtime classifies only its live descendants and rejects replaced peers or runtimes', () => {
  const processes = new Map([proc(200, 1, 'codex'), proc(300, 200, 'zsh'), proc(400, 300, 'els'), proc(500, 200, 'bun'), proc(600, 1, 'bun')].map(p => [p.pid, p]));
  const registry = new SeatRuntimeRegistry(pid => processes.get(pid));
  expect(registry.register(400, 501, processes.get(400), { pid: 200, start: '200:1' })).toBe(true);
  const peer = processes.get(500)!;
  const token = registry.registrationToken();
  expect(registry.matches(500, 501, peer, token)).toBe(true);
  expect(registry.matches(600, 501, processes.get(600), token)).toBe(false);
  expect(registry.matches(500, 502, peer, token)).toBe(false);
  processes.set(500, proc(500, 200, 'bun', 'new'));
  expect(registry.matches(500, 501, peer, token)).toBe(false);
  processes.set(200, proc(200, 1, 'codex', 'new'));
  expect(registry.matches(500, 501, processes.get(500), token)).toBe(false);
});

(test.skipIf(process.platform !== 'darwin'))('reads the live process uid and generation from the OS', () => {
  const self = runtimeProcessIdentity(process.pid);
  expect(self?.pid).toBe(process.pid);
  expect(self?.uid).toBe(process.getuid!());
  expect(self?.ppid).toBe(process.ppid);
  expect(self?.start).toMatch(/^\d+:\d+$/);
  expect(self?.name).toBeTruthy();
  expect(runtimeProcessIdentity(-1)).toBeUndefined();
});

const proc = (pid: number, ppid: number, name: string, start = `${pid}:1`, uid = 501): RuntimeProcess => ({ pid, ppid, name, start, uid });

test('queued registration generation expires on replacement, PID reuse, or missing runtime', () => {
  const processes = new Map([proc(200, 1, 'codex'), proc(400, 200, 'els')].map(p => [p.pid, p]));
  const registry = new SeatRuntimeRegistry(pid => processes.get(pid));
  expect(registry.register(400, 501, processes.get(400), { pid: 200, start: '200:1' })).toBe(true);
  const first = registry.key();
  expect(registry.isLiveGeneration(first)).toBe(true);
  expect(registry.register(400, 501, processes.get(400), { pid: 200, start: '200:1' })).toBe(true);
  const second = registry.key();
  expect(second).not.toBe(first);
  expect(registry.isLiveGeneration(first)).toBe(false);
  expect(registry.isLiveGeneration(second)).toBe(true);
  processes.set(200, proc(200, 1, 'codex', 'reused'));
  expect(registry.isLiveGeneration(second)).toBe(false);
  processes.delete(200);
  expect(registry.isLiveGeneration(second)).toBe(false);
  registry.clear();
  expect(registry.isLiveGeneration(second)).toBe(false);
});

test('registration does not promote a shared terminal app as a seat runtime', () => {
  const processes = new Map([proc(100, 1, 'ghostty'), proc(300, 100, 'zsh'), proc(400, 300, 'els'), proc(500, 100, 'zsh'), proc(600, 500, 'els')].map(p => [p.pid, p]));
  const registry = new SeatRuntimeRegistry(pid => processes.get(pid));
  expect(registry.register(400, 501, processes.get(400), { pid: 100, start: '100:1' })).toBe(false);
  expect(registry.matches(600, 501, processes.get(600), registry.registrationToken())).toBe(false);
});

test('registration requires an explicitly declared live ancestor and rejects invalid or shared process claims', () => {
  const processes = new Map([proc(100, 1, 'ghostty'), proc(200, 100, 'codex'), proc(300, 200, 'zsh'), proc(400, 300, 'els'), proc(500, 100, 'codex')].map(p => [p.pid, p]));
  const registry = new SeatRuntimeRegistry(pid => processes.get(pid));
  const peer = processes.get(400)!;
  expect(registry.register(400, 501, peer, undefined)).toBe(false);
  expect(registry.register(400, 501, peer, { pid: 100, start: '100:1' })).toBe(false);
  expect(registry.register(400, 501, peer, { pid: 300, start: '300:1' })).toBe(false);
  expect(registry.register(400, 501, peer, { pid: 500, start: '500:1' })).toBe(false);
  expect(registry.register(400, 501, peer, { pid: 200, start: 'old' })).toBe(false);
  expect(registry.register(400, 501, peer, { pid: 200, start: '200:1' })).toBe(true);
});

test('registration skips shells and CLI and pins closest runtime generation', () => {
  const processes = new Map([proc(100, 1, 'launchd'), proc(200, 100, 'codex'), proc(300, 200, 'zsh'), proc(400, 300, 'els')].map(p => [p.pid, p]));
  const get = (pid: number) => processes.get(pid);
  expect(findSeatRuntime(400, 501, get)).toEqual(proc(200, 100, 'codex'));
  expect(findSeatRuntime(400, 502, get)).toBeUndefined();
  processes.set(300, proc(300, 200, 'zsh', '300:1', 502));
  expect(findSeatRuntime(400, 501, get)).toBeUndefined();
});

test('only a live same-uid descendant of the pinned runtime generation matches', () => {
  const runtime = proc(200, 1, 'codex');
  const processes = new Map([runtime, proc(300, 200, 'zsh'), proc(400, 300, 'bun'), proc(500, 1, 'bun')].map(p => [p.pid, p]));
  const get = (pid: number) => processes.get(pid);
  expect(matchSeatRuntime(400, 501, runtime, get)).toBe(true);
  expect(matchSeatRuntime(500, 501, runtime, get)).toBe(false);
  expect(matchSeatRuntime(400, 502, runtime, get)).toBe(false);
  processes.set(200, proc(200, 1, 'codex', 'reused'));
  expect(matchSeatRuntime(400, 501, runtime, get)).toBe(false);
  processes.delete(200);
  expect(matchSeatRuntime(400, 501, runtime, get)).toBe(false);
});

test('unknown, cyclic, or UID-changing ancestry cannot register or match', () => {
  const runtime = proc(200, 1, 'codex');
  const processes = new Map([runtime, proc(300, 400, 'zsh'), proc(400, 300, 'els')].map(p => [p.pid, p]));
  const get = (pid: number) => processes.get(pid);
  expect(findSeatRuntime(400, 501, get)).toBeUndefined();
  expect(matchSeatRuntime(400, 501, runtime, get)).toBe(false);
  processes.set(300, proc(300, 200, 'zsh', '300:1', 502));
  expect(matchSeatRuntime(400, 501, runtime, get)).toBe(false);
});
