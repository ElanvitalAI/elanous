import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { planNotify, registerNotifyCommand, type NotifyCliDeps } from './notify-cli.js';

async function invoke(args: string[], deps: NotifyCliDeps = {}) {
  const sent: Array<[string, string]> = [];
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const program = new Command();
  program.exitOverride();
  registerNotifyCommand(program, {
    send: (text, kind) => { sent.push([text, kind]); return deps.send?.(text, kind) ?? true; },
    quiet: deps.quiet ?? (() => false),
    readStdin: deps.readStdin,
    output: (line) => out.push(line),
    error: (line) => err.push(line),
    setExitCode: (code) => codes.push(code),
  });
  await program.parseAsync(['node', 'elanous', 'notify', ...args]);
  return { sent, out, err, code: codes.at(-1) };
}

describe('elanous notify', () => {
  test('(a) 기본 kind op-report 로 sendOutbound seam 을 호출한다', async () => {
    expect(planNotify({ text: '판 보고' })).toEqual({ ok: true, kind: 'op-report' });
    expect(await invoke(['판', '보고'])).toEqual({ sent: [['판 보고', 'op-report']], out: ['보냄(op-report) · 4자'], err: [], code: 0 });
  });

  test('(b) 매매 kind 는 exit 2 이며 발송하지 않는다', async () => {
    for (const kind of ['report', 'alert', 'digest']) {
      const result = await invoke(['판 보고', '--kind', kind]);
      expect(result.code).toBe(2);
      expect(result.sent).toEqual([]);
      expect(result.err).toHaveLength(1);
      expect(result.err[0]).toContain('op-report 또는 ops-alert');
    }
  });

  test('(c) send false 는 exit 1 과 stderr 안내 한 줄', async () => {
    const result = await invoke(['보고'], { send: () => false });
    expect(result).toEqual({ sent: [['보고', 'op-report']], out: [], err: ['못 보냄(op-report) — elanous logs --category outbound.send 로 확인'], code: 1 });
  });

  test('(d) 빈 본문은 exit 2 이며 발송하지 않는다', async () => {
    const result = await invoke([]);
    expect(result.code).toBe(2);
    expect(result.err).toHaveLength(1);
    expect(result.sent).toEqual([]);
  });

  test('(e) --json 은 단일 결과 객체로 내고 --stdin 본문을 받는다', async () => {
    const result = await invoke(['--stdin', '--json', '--kind', 'ops-alert'], { readStdin: async () => '밤 보고', quiet: () => true });
    expect(result).toEqual({ sent: [['밤 보고', 'ops-alert']], out: ['{"ok":true,"kind":"ops-alert","chars":4,"deferred":true}'], err: [], code: 0 });
    const failed = await invoke(['--json', '보고'], { send: () => false });
    expect(failed).toEqual({ sent: [['보고', 'op-report']], out: ['{"ok":false,"kind":"op-report","chars":2,"deferred":false}'], err: [], code: 1 });
    const humanDeferred = await invoke(['보고'], { quiet: () => true });
    expect(humanDeferred.out).toEqual(['보류됨(op-report) · 2자']);
    const refused = await invoke(['--json', '--kind', 'report', '보고']);
    expect(refused).toEqual({ sent: [], out: ['{"ok":false,"kind":"report","chars":2,"deferred":false}'], err: [], code: 2 });
  });
});
