// HERDR-REPLACE-C1: the herdr-shaped contract for a sidetab agent PTY — keys and status (read/send exist already).
import { expect, test } from 'bun:test';
import type { TerminalSession, TerminalSessionRegistry } from '../terminal/session-registry.js';
import { runNextTuiBranchRoute, type SidetabRouteHost } from '../tui/branches/sidetab/route.js';
import { SIDETAB_AGENT_KEYS, sendSidetabAgentKeys, sidetabAgentStatus } from './sidetab-agent-pty.js';

function fakeRegistry(screen: string, brand = 'codex', alive = true) {
  const written: string[] = [];
  const session = {
    id: 'a1', kind: 'coding-agent', agentBrand: brand, state: alive ? 'foreground' : 'exited',
    preview: { isAlive: alive, renderForLLM: () => screen, write: (bytes: string) => { written.push(bytes); return true; } },
  } as unknown as TerminalSession;
  const registry = { get: (id: string) => (id === 'a1' ? session : undefined) } as unknown as TerminalSessionRegistry;
  return { registry, written };
}

test('keys: known names are written in order as their sequences', () => {
  const { registry, written } = fakeRegistry('codex ready');
  expect(sendSidetabAgentKeys(registry, 'a1', ['down', 'Enter', 'ctrl-c'])).toBe(true);
  expect(written).toEqual(['\x1b[B', '\r', '\x03']);
  expect(Object.keys(SIDETAB_AGENT_KEYS).sort()).toEqual(['backspace', 'ctrl-c', 'ctrl-d', 'down', 'enter', 'esc', 'left', 'right', 'tab', 'up']);
});

test('keys: one unknown name refuses the whole list — nothing is written', () => {
  const { registry, written } = fakeRegistry('codex ready');
  expect(sendSidetabAgentKeys(registry, 'a1', ['enter', 'ctrl-z'])).toBe(false);
  expect(written).toEqual([]);
  expect(sendSidetabAgentKeys(registry, 'a1', [])).toBe(false);
});

test('keys: an inherited object name mixed into the list refuses the whole list — nothing is written (#38356 REVIEW-1)', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const { registry, written } = fakeRegistry('codex ready');
    expect(sendSidetabAgentKeys(registry, 'a1', ['enter', name])).toBe(false);
    expect(sendSidetabAgentKeys(registry, 'a1', [name])).toBe(false);
    expect(written).toEqual([]);
  }
});

test('keys: no such agent, a non-agent session, or a dead PTY → false, nothing written', () => {
  const dead = fakeRegistry('bye', 'codex', false);
  expect(sendSidetabAgentKeys(dead.registry, 'a1', ['enter'])).toBe(false);
  expect(dead.written).toEqual([]);
  expect(sendSidetabAgentKeys(fakeRegistry('x').registry, 'missing', ['enter'])).toBe(false);
  const shell = fakeRegistry('$ ', 'bash');
  expect(sendSidetabAgentKeys(shell.registry, 'a1', ['enter'])).toBe(false);
});

test('status: the screen classifier for a live agent; done for an exited one; undefined for no agent', () => {
  expect(sidetabAgentStatus(fakeRegistry('x', 'codex', false).registry, 'a1')).toBe('done');
  expect(sidetabAgentStatus(fakeRegistry('x').registry, 'missing')).toBeUndefined();
  const live = sidetabAgentStatus(fakeRegistry('codex ready').registry, 'a1');
  expect(['idle', 'working', 'blocked', 'waiting', 'done', 'unknown']).toContain(live!);
});

test('/side keys and /side status go through the host and say what happened', async () => {
  const statuses: string[] = [];
  const sent: string[][] = [];
  const host = {
    sendSelectedAgentKeys: async (names: readonly string[]) => { sent.push([...names]); return !names.includes('bogus'); },
    selectedAgentStatus: async () => 'blocked',
    setStatus: (message: string) => statuses.push(message),
  } as unknown as SidetabRouteHost;
  await runNextTuiBranchRoute('/side keys down enter', host);
  await runNextTuiBranchRoute('/side keys bogus', host);
  await runNextTuiBranchRoute('/side keys', host);
  await runNextTuiBranchRoute('/side status', host);
  expect(sent).toEqual([['down', 'enter'], ['bogus']]);
  expect(statuses).toEqual([
    'Keys sent to selected agent · down enter',
    'Keys not sent · unknown key name, or no live agent PTY selected',
    'Keys: enter esc tab up down left right backspace ctrl-c ctrl-d',
    'Selected agent · blocked',
  ]);
  const none = { selectedAgentStatus: async () => undefined, setStatus: (m: string) => statuses.push(m) } as unknown as SidetabRouteHost;
  await runNextTuiBranchRoute('/side status', none);
  expect(statuses.at(-1)).toBe('No agent PTY selected');
});
