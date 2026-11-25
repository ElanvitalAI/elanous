import { describe, expect, test } from 'bun:test';
import { routeElsSend } from './els-cli.js';

function deps() {
  const calls: string[] = [];
  return { calls, d: {
    localHost: 'mshq', from: 'OP',
    remoteDo: async (pane: string, text: string, from: string) => { calls.push(`do ${pane} ${text} ${from}`); return { exitCode: 0, message: 'delivered' }; },
    local: async (request: { op: string }) => { calls.push(`local ${request.op}`); return { exitCode: 0, message: 'ok' }; },
  } };
}

describe('els send routing', () => {
  test('remote host address goes through the do path', async () => {
    const { calls, d } = deps();
    const r = await routeElsSend('node-b:w1/t1/p1', 'hello', true, d as never);
    expect(r.exitCode).toBe(0);
    expect(calls).toEqual(['do node-b:w1/t1/p1 hello OP']);
  });
  test('remote --no-enter is refused without sending', async () => {
    const { calls, d } = deps();
    const r = await routeElsSend('node-b:w1/t1/p1', 'hello', false, d as never);
    expect(r.exitCode).toBe(2);
    expect(r.message).toContain('remote panes take whole lines only');
    expect(calls).toEqual([]);
  });
  test('local pane keeps the local verified send', async () => {
    const { calls, d } = deps();
    await routeElsSend('w1/t1/p1', 'hi', true, d as never);
    await routeElsSend('mshq:w1/t1/p1', 'hi', false, d as never);
    expect(calls).toEqual(['local send-verified', 'local send']);
  });
});
