import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlInboxPath, drainControlInbox, encodeControlMemoFrame } from './control-inbox.js';
import { parsePodReadWait, sendPodControl } from './pod-control-send.js';
import { defaultKubectl, type Kubectl } from '../task-orchestrator/surfaces/self-implement-pod.js';

const record = { spaceId: 'fragment', context: 'cluster-a', namespace: 'elanous-test', job: 'si-fragment', inboxDir: '/tmp/elanous-control.inbox' };

describe('Pod control send', () => {
  test('read wait rejects malformed input and kubectl timeout covers the bounded wait plus grace', () => {
    expect(() => parsePodReadWait('NaN')).toThrow('--read-wait');
    expect(() => parsePodReadWait('-1')).toThrow('--read-wait');
    expect(() => parsePodReadWait('')).toThrow('--read-wait');
    expect(() => parsePodReadWait('300')).toThrow('0~60');
    let timeout = 0;
    let bounded = '';
    sendPodControl(record, { memo: { version: 1, kind: 'supervisor', urgency: 'normal', body: 'budget' } },
      (args, _input, timeoutMs) => {
        bounded = args.at(-1) ?? '';
        timeout = timeoutMs ?? 0;
        return { status: 0, stdout: '', stderr: '' };
      }, 60);
    expect(bounded).toBe('60');
    expect(timeout).toBeGreaterThanOrEqual(60_000 + 30_000);
  });
  test('defaultKubectl enforces the third-argument timeout on a real child process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-kubectl-timeout-'));
    const oldPath = process.env.PATH;
    try {
      const binary = join(dir, 'kubectl');
      writeFileSync(binary, '#!/bin/sh\nexec sleep 2\n');
      chmodSync(binary, 0o755);
      process.env.PATH = `${dir}:${oldPath ?? ''}`;
      const started = Date.now();
      const result = defaultKubectl(['version'], undefined, 100);
      expect(result.status).toBeNull();
      expect(result.stderr).toContain('ETIMEDOUT');
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('memo uses the existing frame via exec stdin in the recorded context and namespace', () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const kubectl: Kubectl = (args, input) => { calls.push({ args, input }); return { status: 0, stdout: '', stderr: '' }; };
    const memo = { version: 1 as const, kind: 'supervisor', urgency: 'normal' as const, body: 'hello' };
    sendPodControl(record, { memo }, kubectl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 9)).toEqual(['--context', 'cluster-a', '-n', 'elanous-test', 'exec', '-i', 'job/si-fragment', '-c', 'child']);
    expect(calls[0]!.args).toContain('/tmp/elanous-control.inbox');
    expect(calls[0]!.args).toContain('memo');
    expect(calls[0]!.input).toBe(`${encodeControlMemoFrame(memo)}\n`);
    expect(calls[0]!.args.join(' ')).toContain('memo:%s');
    expect(calls[0]!.args.join(' ')).toContain('.ack-request');
    expect(calls[0]!.args.join(' ')).toContain('ELANOUS_POD_MEMO_READ');
  });
  test('stop publishes the existing latch and durable marker inside the Pod', () => {
    let args: readonly string[] = [];
    let input: string | undefined;
    sendPodControl(record, { stop: true }, (a, i) => { args = a; input = i; return { status: 0, stdout: '', stderr: '' }; });
    expect(input).toBe('stop\n');
    expect(args).toContain('stop');
    expect(args.join(' ')).toContain('stop-requested.json');
    expect(args.join(' ')).toContain('.ready/stop');
  });
  test('kubectl failure is not reported as delivery', () => {
    expect(() => sendPodControl(record, { stop: true }, () => ({ status: 1, stdout: '', stderr: 'pod gone' }))).toThrow('Pod si-fragment control send 실패: pod gone');
  });
  test('F6: Pod memo receipt distinguishes published from claimed record id', () => {
    const memo = { version: 1 as const, kind: 'supervisor', urgency: 'normal' as const, body: 'narrow the F6 test' };
    const id = 'record-0000000000000001-00000000-0000-0000-0000-000000000001';
    const result = sendPodControl(record, { memo }, (args) => {
      expect(args.at(-1)).toBe('10');
      return { status: 0, stdout: `ELANOUS_POD_MEMO_PUBLISHED ${id}\nELANOUS_POD_MEMO_READ ${id}\n`, stderr: '' };
    }, 10);
    expect(result).toEqual({ memoRecord: id, read: true });
    expect(sendPodControl(record, { memo }, () => ({ status: 0,
      stdout: `ELANOUS_POD_MEMO_PUBLISHED ${id}\nELANOUS_POD_MEMO_UNREAD ${id}\n`, stderr: '' }), 0))
      .toEqual({ memoRecord: id, read: false });
    expect(sendPodControl(record, { memo }, () => ({ status: 0, stdout: '', stderr: '' }), 0)).toEqual({});
  });
  test('F6: the actual Pod publish shell writes one record and reports unverified without a consumer', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-control-shell-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'cat'), '#!/bin/sh\nif [ "$1" = /proc/sys/kernel/random/uuid ]; then printf "00000000-0000-0000-0000-000000000001\\n"; else exec /bin/cat "$@"; fi\n', { mode: 0o755 });
      writeFileSync(join(bin, 'date'), '#!/bin/sh\nprintf "1000\\n"\n', { mode: 0o755 });
      let script = '';
      const memo = { version: 1 as const, kind: 'supervisor', urgency: 'normal' as const, body: 'F6 unique memo' };
      sendPodControl({ ...record, inboxDir: join(root, 'control.inbox') }, { memo }, (args) => {
        script = args[args.indexOf('sh') + 2]!;
        return { status: 0, stdout: '', stderr: '' };
      });
      const result = spawnSync('/bin/sh', ['-c', script, 'pod-control', join(root, 'control.inbox'), 'memo', '0'], {
        input: `${encodeControlMemoFrame(memo)}\n`, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.status).toBe(0);
      const id = 'record-00000000000003e8-00000000-0000-0000-0000-000000000001';
      expect(result.stdout).toContain(`ELANOUS_POD_MEMO_PUBLISHED ${id}`);
      expect(result.stdout).toContain(`ELANOUS_POD_MEMO_UNVERIFIED ${id}`);
      expect(readFileSync(join(root, 'control.inbox.ready', id), 'utf8')).toBe(`memo:${encodeControlMemoFrame(memo)}\n`);
      expect(existsSync(join(root, 'control.inbox.ready', `${id}.ack-request`))).toBe(false);
      expect(readdirSync(join(root, 'control.inbox.ready'))).toEqual([id]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('F6: publisher receipt follows the exact record drained by the real consumer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-control-consumer-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'cat'), '#!/bin/sh\nif [ "$1" = /proc/sys/kernel/random/uuid ]; then printf "00000000-0000-0000-0000-000000000002\\n"; else exec /bin/cat "$@"; fi\n', { mode: 0o755 });
      writeFileSync(join(bin, 'date'), '#!/bin/sh\nprintf "1001\\n"\n', { mode: 0o755 });
      const env = { ...process.env, ELANOUS_STATE_DIR: root };
      const inbox = controlInboxPath('pod-f6', env);
      const memo = { version: 1 as const, kind: 'supervisor', urgency: 'normal' as const, body: 'F6 consumed memo' };
      let script = '';
      sendPodControl({ ...record, inboxDir: inbox }, { memo }, (args) => {
        script = args[args.indexOf('sh') + 2]!;
        return { status: 0, stdout: '', stderr: '' };
      });
      child = spawn('/bin/sh', ['-c', script, 'pod-control', inbox, 'memo', '5'], {
        env: { ...env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exit = new Promise<number | null>((resolve) => child!.once('exit', resolve));
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stdin.end(`${encodeControlMemoFrame(memo)}\n`);
      const id = 'record-00000000000003e9-00000000-0000-0000-0000-000000000002';
      const path = join(`${inbox}.ready`, id);
      for (let attempt = 0; attempt < 200 && !existsSync(path); attempt += 1) await Bun.sleep(10);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.ack-request`)).toBe(true);
      const drained = drainControlInbox('pod-f6', { env });
      expect(drained.structuredMemos).toEqual([memo]);
      const status = await exit;
      expect(status).toBe(0);
      expect(output).toContain(`ELANOUS_POD_MEMO_PUBLISHED ${id}`);
      expect(output).toContain(`ELANOUS_POD_MEMO_READ ${id}`);
      expect(readdirSync(`${inbox}.ready`)).toEqual([]);
    } finally { child?.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
  });
  test('interrupted publisher leaves its published memo but cleans its ack markers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-control-interrupted-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'cat'), '#!/bin/sh\nif [ "$1" = /proc/sys/kernel/random/uuid ]; then printf "00000000-0000-0000-0000-000000000003\\n"; else exec /bin/cat "$@"; fi\n', { mode: 0o755 });
      writeFileSync(join(bin, 'date'), '#!/bin/sh\nprintf "1002\\n"\n', { mode: 0o755 });
      const inbox = join(root, 'control.inbox');
      const memo = { version: 1 as const, kind: 'supervisor', urgency: 'normal' as const, body: 'survive interruption' };
      let script = '';
      sendPodControl({ ...record, inboxDir: inbox }, { memo }, (args) => {
        script = args[args.indexOf('sh') + 2]!;
        return { status: 0, stdout: '', stderr: '' };
      });
      child = spawn('/bin/sh', ['-c', script, 'pod-control', inbox, 'memo', '30'], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exit = new Promise<number | null>((resolve) => child!.once('exit', resolve));
      child.stdin.end(`${encodeControlMemoFrame(memo)}\n`);
      const id = 'record-00000000000003ea-00000000-0000-0000-0000-000000000003';
      const path = join(`${inbox}.ready`, id);
      for (let attempt = 0; attempt < 200 && !existsSync(path); attempt += 1) await Bun.sleep(10);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.ack-request`)).toBe(true);
      child.kill('SIGTERM');
      expect(await exit).not.toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.ack-request`)).toBe(false);
      expect(existsSync(`${path}.ack`)).toBe(false);
    } finally { child?.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
  });
});
