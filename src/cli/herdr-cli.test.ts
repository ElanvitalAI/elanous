import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';

import { createFakeHerdr } from '../ux-sim/fake-herdr.js';
import { registerHerdrCommands } from './herdr-cli.js';

afterEach(() => { process.exitCode = 0; });

async function runCli(argv: string[], run: ReturnType<typeof createFakeHerdr>['run']): Promise<{ out: string[]; exitCode: number | undefined }> {
  const program = new Command().exitOverride();
  registerHerdrCommands(program, { run, log: () => {} });
  const out: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  try {
    await program.parseAsync(['node', 'elanous', ...argv]);
  } finally {
    spy.mockRestore();
  }
  return { out, exitCode: process.exitCode === undefined ? undefined : Number(process.exitCode) };
}

describe('eln herdr prompt', () => {
  test('--wait 성공은 결과 JSON 한 줄 · rc0', async () => {
    const h = createFakeHerdr({
      panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }],
      onRun: (s, herdr) => { setTimeout(() => herdr.setStatus(s.paneId, 'working'), 5); setTimeout(() => herdr.setStatus(s.paneId, 'idle'), 20); },
    });
    const r = await runCli(['herdr', 'prompt', 'w1:p1', '깨어나라', '--wait', '--timeout', '2000'], h.run);
    expect(r.out).toHaveLength(1);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ ok: true, accepted: true, reason: 'settled', status: 'idle' });
    expect(r.exitCode ?? 0).toBe(0);
    expect(h.submissions()).toEqual([{ paneId: 'w1:p1', text: '깨어나라' }]);
  });

  test('거부는 rc1 ⊕ 이유 JSON', async () => {
    const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'blocked' }] });
    const r = await runCli(['herdr', 'prompt', 'w1:p1', 'x'], h.run);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ ok: false, accepted: false, reason: 'agent_blocked' });
    expect(r.exitCode).toBe(1);
  });

  test('잘못된 --timeout 은 herdr 를 부르기 전에 거부', async () => {
    const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }] });
    await expect(runCli(['herdr', 'prompt', 'w1:p1', 'x', '--timeout', '0'], h.run)).rejects.toThrow('잘못된 --timeout');
    expect(h.calls()).toEqual([]);
  });
});
