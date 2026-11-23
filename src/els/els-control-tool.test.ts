// ELN-ELS-NATIVE-TOOL · ElsControl 승인 리터럴 — 가짜 els 소켓 왕복(ls·new·do·close) · 소켓 없으면 도구 없음 · close 확인 없으면 0.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AllowRule, ControlAction } from './control.js';
import { requestEls } from './client.js';
import {
  ELS_CONTROL_ACTIONS,
  ELS_CONTROL_TOOL_NAME,
  buildElsControlTool,
  elsControlSocketPath,
  runElsControl,
  elsControlSeat,
} from './els-control-tool.js';

function rules(actions: readonly ControlAction[]): AllowRule[] {
  return [{ principal: '*', workspace: 'w1', pane: '*', actions }];
}

interface FakeEls {
  readonly received: unknown[];
  close(): Promise<void>;
}

async function fakeEls(socketPath: string, reply: (request: Record<string, unknown>) => { exitCode: number; message: string }): Promise<FakeEls> {
  const received: unknown[] = [];
  const server: Server = createServer((socket: Socket) => {
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handle = (line: string) => {
      const request = JSON.parse(line) as Record<string, unknown>;
      // Authentication is a transport handshake, not a control operation. Never
      // retain its credentials in the fixture's captured request list.
      if (request.op === 'auth') {
        socket.write(JSON.stringify({ exitCode: 0, message: 'auth: fixture' }) + '\n');
        return;
      }
      received.push(request);
      const outcome = reply(request);
      socket.write(JSON.stringify(outcome) + '\n');
    };
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handle(line);
        index = buffer.indexOf('\n');
      }
      if (timer) clearTimeout(timer);
      if (buffer.trim()) timer = setTimeout(() => { const line = buffer.trim(); buffer = ''; handle(line); }, 150);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(join(dirname(socketPath), 'ctl.sock'), () => resolve());
  });
  return { received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const LISTING = {
  workspaces: [{ id: 'w1', name: 'one' }, { id: 'w2', name: 'two' }],
  tabs: [{ id: 't1', workspaceId: 'w1' }, { id: 't2', workspaceId: 'w2' }],
  panes: [{ pane: 'p1', tab: 't1', kind: 'pty' }, { pane: 'p2', tab: 't2', kind: 'pty' }, { pane: 'pa', tab: 't1', kind: 'agent' }],
};

/** The fake els answers the journal lookup (op ls) itself; every other request goes to `inner`. */
function journal(inner: (request: Record<string, unknown>) => { exitCode: number; message: string } = () => ({ exitCode: 0, message: 'ok' })) {
  return (request: Record<string, unknown>) => request.op === 'ls' ? { exitCode: 0, message: JSON.stringify(LISTING) } : inner(request);
}

function sentWithoutLookup(fake: FakeEls): Record<string, unknown>[] {
  return (fake.received as Record<string, unknown>[]).filter((request) => request.op !== 'ls');
}

function allow(dir: string, actions: readonly ControlAction[]): void {
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: rules(actions) }));
}

describe('ELN-ELS-NATIVE-TOOL · 게이트 · 명세', () => {
  test('ELANOUS_ELS_SOCKET 없으면 도구가 없다', () => {
    expect(elsControlSocketPath({})).toBe('');
    expect(elsControlSocketPath({ ELANOUS_ELS_SOCKET: '   ' })).toBe('');
    expect(elsControlSocketPath({ ELANOUS_ELS_SOCKET: '/tmp/els.sock' })).toBe('/tmp/els.sock');
  });

  test('명세: 이름 ElsControl · 동작 10개 · action 필수', () => {
    const spec = buildElsControlTool();
    expect(spec.name).toBe(ELS_CONTROL_TOOL_NAME);
    const parameters = spec.parameters as { properties?: Record<string, { enum?: string[] }>; required?: string[] };
    expect(parameters.properties?.action?.enum).toEqual([...ELS_CONTROL_ACTIONS]);
    expect(parameters.required).toEqual(['action']);
  });

  test('모르는 동작은 구조 JSON 로 거부된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    const outcome = await runElsControl({ action: 'explode' }, { socketPath: join(dir, 's.sock'), stateDir: dir });
    expect(outcome.allowed).toBe(false);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain('unknown action');
  });
});

describe('ELN-ELS-NATIVE-TOOL · 가짜 els 소켓 왕복', () => {
  test('fixture acknowledges authentication separately without retaining credentials as control requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-auth-'));
    const fake = await fakeEls(join(dir, 's.sock'), journal());
    try {
      const result = await requestEls(join(dir, 'ctl.sock'), { op: 'ls' }, 10_000, 'fixture-only');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.message)).toEqual(LISTING);
      expect(fake.received).toEqual([{ op: 'ls' }]);
    } finally {
      await fake.close();
    }
  });

  test('stop requires tool do permission and sends only an interrupt to the selected agent pane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-stop-'));
    const socketPath = join(dir, 's.sock');
    const fake = await fakeEls(socketPath, journal());
    try {
      // A seated non-OP caller still needs the do rule (the 11-23 seatless default does not apply to it).
      const seat = { name: 'MK' };
      const denied = await runElsControl({ action: 'stop', pane: 'pa' }, { socketPath, stateDir: dir, seat });
      expect(denied.allowed).toBe(false);
      expect(sentWithoutLookup(fake)).toEqual([]);
      allow(dir, ['do']);
      const allowed = await runElsControl({ action: 'stop', pane: 'pa', text: 'ignored' }, { socketPath, stateDir: dir, seat });
      expect(allowed).toMatchObject({ ok: true });
      expect(sentWithoutLookup(fake)).toEqual([{ op: 'interrupt', pane: 'pa' }]);
    } finally {
      await fake.close();
    }
  });

  test('send requires tool do permission and blocks dangerous shell input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-send-'));
    const socketPath = join(dir, 's.sock');
    const fake = await fakeEls(socketPath, journal());
    try {
      allow(dir, ['do']);
      const held = await runElsControl({ action: 'send', pane: 'p1', text: 'sudo id' }, { socketPath, stateDir: dir });
      expect(held.ok).toBe(false);
      expect(sentWithoutLookup(fake)).toEqual([]);
      const sent = await runElsControl({ action: 'send', pane: 'p1', text: 'pwd' }, { socketPath, stateDir: dir });
      expect(sent.ok).toBe(true);
      expect(sentWithoutLookup(fake)).toEqual([{ op: 'input-line', pane: 'p1', text: 'pwd', from: 'ElsControl' }]);
    } finally { await fake.close(); }
  });

  test('허용목록 없음: 자리 없는 호출은 허용·감사 · 확인 없는 close 는 거부(CEO 11-23 완화)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    const fake = await fakeEls(join(dir, 's.sock'), journal());
    const outcome = await runElsControl({ action: 'ls', pane: 'p1' }, { socketPath: join(dir, 's.sock'), stateDir: dir });
    expect(outcome.allowed).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(fake.received.map((request) => (request as { op: string }).op)).toEqual(['ls', 'ls']);
    const closed = await runElsControl({ action: 'close', pane: 'p1' }, { socketPath: join(dir, 's.sock'), stateDir: dir });
    expect(closed.allowed).toBe(false);
    expect(closed.reason).toBe('close needs confirm:true (human confirmation)');
    expect(sentWithoutLookup(fake).length).toBe(0); // the statement ls and the lookup ls share an op; close never reached the socket
    const audit = readFileSync(join(dir, 'control-audit.jsonl'), 'utf8');
    expect(audit).toContain('"action":"list"');
    expect(audit).toContain('"result":"executed"');
    expect(audit).toContain('"result":"denied"');
    await fake.close();
  });

  test('ls: 문 통과 → op ls 왕복 → 결과 구조 JSON(data 로 파싱)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    allow(dir, ['list']);
    const fake = await fakeEls(join(dir, 's.sock'), journal());
    const outcome = await runElsControl({ action: 'ls', pane: 'p1' }, { socketPath: join(dir, 's.sock'), stateDir: dir });
    expect(outcome.allowed).toBe(true);
    expect(outcome.ok).toBe(true);
    // one `ls` for the journal lookup, one for the statement itself
    expect(fake.received.map((request) => (request as { op: string }).op)).toEqual(['ls', 'ls']);
    const data = outcome.data as { workspaces: { id: string }[] };
    expect(data.workspaces[0].id).toBe('w1');
    await fake.close();
  });

  test('new: 문 통과 → op new 왕복(ws·command·title)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    allow(dir, ['new']);
    const fake = await fakeEls(join(dir, 's.sock'), journal(() => ({ exitCode: 0, message: 'els new: opened' })));
    const outcome = await runElsControl(
      { action: 'new', pane: 'p1', title: 'build', text: 'bun test foo.test.ts' },
      { socketPath: join(dir, 's.sock'), stateDir: dir },
    );
    expect(outcome.allowed).toBe(true);
    const request = sentWithoutLookup(fake)[0] as { op: string; ws: string; command: string[]; title?: string };
    expect(request.op).toBe('new');
    expect(request.ws).toBe('w1');
    expect(request.command).toEqual(['bun', 'test', 'foo.test.ts']);
    expect(request.title).toBe('build');
    await fake.close();
  });

  test('do: 문 통과 → op do 왕복(pane·text·from)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    allow(dir, ['do']);
    const fake = await fakeEls(join(dir, 's.sock'), journal());
    const outcome = await runElsControl(
      { action: 'do', pane: 'p1', text: 'echo hi' },
      { socketPath: join(dir, 's.sock'), stateDir: dir },
    );
    expect(outcome.allowed).toBe(true);
    const request = sentWithoutLookup(fake)[0] as { op: string; pane: string; text: string; from: string };
    expect(request.op).toBe('do');
    expect(request.pane).toBe('p1');
    expect(request.text).toBe('echo hi');
    expect(request.from).toBe('ElsControl');
    await fake.close();
  });

  test('close: 확인 없으면 0 — 문이 막아 소켓까지 도달하지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    allow(dir, ['close']);
    const fake = await fakeEls(join(dir, 's.sock'), journal());
    const outcome = await runElsControl({ action: 'close', pane: 'p1' }, { socketPath: join(dir, 's.sock'), stateDir: dir });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe('close needs confirm:true (human confirmation)');
    expect(sentWithoutLookup(fake).length).toBe(0);
    const audit = readFileSync(join(dir, 'control-audit.jsonl'), 'utf8');
    expect(audit).toContain('close');
    await fake.close();
  });

  test('close: 사람 확인 승인 → 문 통과 → op close 왕복', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    allow(dir, ['close']);
    const fake = await fakeEls(join(dir, 's.sock'), journal(() => ({ exitCode: 0, message: 'els close: closed p1' })));
    let asked = '';
    const outcome = await runElsControl(
      { action: 'close', pane: 'p1' },
      {
        socketPath: join(dir, 's.sock'),
        stateDir: dir,
        ask: async (question) => {
          asked = question;
          return true;
        },
      },
    );
    expect(asked).toContain('p1');
    expect(outcome.allowed).toBe(true);
    const request = sentWithoutLookup(fake)[0] as { op: string; pane: string };
    expect(request.op).toBe('close');
    expect(request.pane).toBe('p1');
    await fake.close();
  });

  test('허용목록에 없는 동작은 거부되고 감사에 남는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    allow(dir, ['read']);
    const fake = await fakeEls(join(dir, 's.sock'), journal());
    // A seated non-OP caller is held to the file rules (the 11-23 seatless default does not apply to it).
    const outcome = await runElsControl(
      { action: 'do', pane: 'p1', text: 'echo hi' },
      { socketPath: join(dir, 's.sock'), stateDir: dir, seat: { name: 'MK' } },
    );
    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain('not in control-allow.json');
    expect(sentWithoutLookup(fake).length).toBe(0);
    expect(readFileSync(join(dir, 'control-audit.jsonl'), 'utf8')).toContain('"result":"denied"');
    await fake.close();
  });
});

describe('ELN-ELS-NATIVE-TOOL · 저널 조회 대상 (JUD fail must ⓒ)', () => {
  test('LLM 이 준 workspace·tab·shell 은 무시 — 문장은 저널에서 조회한 값으로 만들어진다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    allow(dir, ['do']);
    const fake = await fakeEls(join(dir, 's.sock'), journal());
    // A seated non-OP caller (MK) is held to the file rule; the 11-23 seatless default does not apply to it.
    const seat = { name: 'MK' };
    // p2 lives in w2 (rule allows w1 only); the LLM claims w1 · a safe-looking shell:false.
    const denied = await runElsControl(
      { action: 'do', pane: 'p2', workspace: 'w1', tab: 't1', shell: false, text: 'echo hi' },
      { socketPath: join(dir, 's.sock'), stateDir: dir, seat },
    );
    expect(denied.allowed).toBe(false);
    expect(denied.message).toContain('not in control-allow.json');
    expect(sentWithoutLookup(fake).length).toBe(0);
    expect(readFileSync(join(dir, 'control-audit.jsonl'), 'utf8')).toContain('"workspace":"w2"');
    // p1 is a shell pane in w1: shell:false from the LLM does not skip danger classification (no person → held).
    const held = await runElsControl(
      { action: 'do', pane: 'p1', workspace: 'w2', shell: false, text: 'rm -rf /' },
      { socketPath: join(dir, 's.sock'), stateDir: dir, seat },
    );
    expect(held.allowed).toBe(false);
    expect(held.code).toBe('held');
    expect(sentWithoutLookup(fake).length).toBe(0);
    // the true values pass: statement is built from the journal (w1) whatever the LLM claimed.
    const ok = await runElsControl(
      { action: 'do', pane: 'p1', workspace: 'w2', text: 'echo hi' },
      { socketPath: join(dir, 's.sock'), stateDir: dir, seat },
    );
    expect(ok.allowed).toBe(true);
    expect(sentWithoutLookup(fake).length).toBe(1);
    expect(readFileSync(join(dir, 'control-audit.jsonl'), 'utf8')).toContain('"workspace":"w1"');
    await fake.close();
  });

  test('모르는 pane → 구조 오류로 거부, 가짜 소켓엔 조회 외 아무것도 가지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    allow(dir, ['do', 'new', 'close']);
    const fake = await fakeEls(join(dir, 's.sock'), journal());
    for (const action of ['do', 'new', 'close', 'read']) {
      const outcome = await runElsControl({ action, pane: 'nope', workspace: 'w1', text: 'echo hi' }, { socketPath: join(dir, 's.sock'), stateDir: dir, ask: async () => true });
      expect(outcome.allowed).toBe(false);
      expect(outcome.code).toBe('unknown-pane');
    }
    const missing = await runElsControl({ action: 'do', workspace: 'w1', text: 'echo hi' }, { socketPath: join(dir, 's.sock'), stateDir: dir });
    expect(missing.code).toBe('pane-required');
    expect(sentWithoutLookup(fake).length).toBe(0);
    await fake.close();
  });

  test('조회 실패(소켓 없음)는 실행 없이 거부, 다른 space 구조 대상은 거부', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elsctl-'));
    allow(dir, ['rename']);
    const lost = await runElsControl({ action: 'rename', pane: 'p1', name: 'x' }, { socketPath: join(dir, 'none.sock'), stateDir: dir });
    expect(lost.allowed).toBe(false);
    expect(lost.code).toBe('lookup-failed');
    const fake = await fakeEls(join(dir, 's.sock'), journal());
    const cross = await runElsControl({ action: 'rename', pane: 'p1', kind: 'tab', id: 't2', name: 'x' }, { socketPath: join(dir, 's.sock'), stateDir: dir });
    expect(cross.code).toBe('out-of-space');
    expect(sentWithoutLookup(fake).length).toBe(0);
    await fake.close();
  });
});

// ELS-ORCH-PEER-IDENTITY 최소판(CEO 11-23 15:1x): the tool carries its own seat from the env els set on the seat tab.
test('elsControlSeat reads the seat and its workspace from the env', () => {
  expect(elsControlSeat({ ELANOUS_TRACK: 'OP', ELANOUS_ELS_WS: 'w8ad91a8f' })).toEqual({ name: 'OP', workspaces: ['w8ad91a8f'] });
  expect(elsControlSeat({ ELANOUS_SEAT: 'HAND-ELN-ELS-API' })).toEqual({ name: 'HAND-ELN-ELS-API' });
  expect(elsControlSeat({})).toBeUndefined();
  expect(elsControlSeat({ ELANOUS_TRACK: '  ' })).toBeUndefined();
});
