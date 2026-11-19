import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeConfirmChannel, mcpHitlAsk } from './mcp-hitl.js';
import { createControlledBackend } from './mcp-serve.js';
import type { HitlRequest } from './control.js';

// 출처: #38860 risk-HITL 시험 — 가짜 confirm 채널은 즉답하므로 50ms 는 즉응·타임아웃 경계 확인용 상한(사람 승인 대기 상한 아님)
const HITL_TEST_TIMEOUT_MS = 50;

const request: HitlRequest = {
  principal: { id: 'mcp-stdio:test', kind: 'mcp-stdio' },
  from: 'test',
  action: 'do',
  target: { workspace: 'w', pane: 'p', shell: true },
  text: 'rm -rf /tmp/x',
  reason: 'dangerous shell syntax',
};

describe('mcpHitlAsk', () => {
  test('a channel answering yes → approve', async () => {
    const ask = mcpHitlAsk({ channels: [fakeConfirmChannel(true)], timeoutMs: HITL_TEST_TIMEOUT_MS });
    expect(await ask(request)).toBe('approve');
  });

  test('a channel answering no → deny', async () => {
    const ask = mcpHitlAsk({ channels: [fakeConfirmChannel(false)], timeoutMs: HITL_TEST_TIMEOUT_MS });
    expect(await ask(request)).toBe('deny');
  });

  test('silence until the timeout → timeout (fail-closed)', async () => {
    const ask = mcpHitlAsk({ channels: [fakeConfirmChannel('timeout')], timeoutMs: HITL_TEST_TIMEOUT_MS });
    expect(await ask(request)).toBe('timeout');
  });

  test('zero wired channels → deny immediately (no unapproved send)', async () => {
    const ask = mcpHitlAsk({ channels: [], timeoutMs: HITL_TEST_TIMEOUT_MS });
    expect(await ask(request)).toBe('deny');
  });

  test('the prompt carries the person-facing question', async () => {
    let seen = '';
    const channel = { name: 'spy', request: async (req: { prompt: string }) => { seen = req.prompt; return true; }, cancel: () => {} };
    await mcpHitlAsk({ channels: [channel], timeoutMs: HITL_TEST_TIMEOUT_MS })(request);
    expect(seen).toContain('els do: dangerous shell syntax');
    expect(seen).toContain('rm -rf /tmp/x');
  });
});

// ── the door fixture pattern (mcp-serve.test.ts): an isolated state dir with its own allow list ────────────
// The allow list authorizes this principal, so the only variable left is the person's answer.
describe('dangerous els_do through the controlled backend with mcpHitlAsk', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  const door = (hitl?: ReturnType<typeof mcpHitlAsk>) => {
    const dir = mkdtempSync('/tmp/els-mcp-hitl-');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({
      rules: [{ principal: 'mcp-stdio:elanous-agent', workspace: 'w', pane: '*', actions: ['read', 'do'] }],
    }));
    const backend = createControlledBackend({
      stateDir: dir,
      ...(hitl ? { hitl } : {}),
      lookup: async () => ({ workspace: 'w', pane: 'p', shell: true }),
      inner: {
        do: async () => ({ exitCode: 0, message: 'sent' }),
        ls: async () => ({ exitCode: 0, message: '[]' }),
        status: async () => ({ exitCode: 0, message: 'ok' }),
        screen: async () => ({ exitCode: 0, message: '' }),
        events: async () => ({ exitCode: 0, message: '[]' }),
      } as never,
    });
    return { backend, dir };
  };

  const audit = (dir: string) =>
    readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((raw) => JSON.parse(raw) as { result: string; text?: string });

  const principal = { id: 'mcp-stdio:elanous-agent', kind: 'mcp-stdio' } as const;

  test('approved by a person → the line is sent', async () => {
    const { backend, dir } = door(mcpHitlAsk({ channels: [fakeConfirmChannel(true)], timeoutMs: HITL_TEST_TIMEOUT_MS }));
    const result = await backend.do(principal, 'p', 'rm -rf /tmp/x');
    expect(result.exitCode).toBe(0);
    expect(result.message).toBe('sent');
    expect(audit(dir).map((row) => row.result)).toEqual(['executing', 'executed']);
  });

  test('denied by a person → rejected, not sent', async () => {
    const { backend, dir } = door(mcpHitlAsk({ channels: [fakeConfirmChannel(false)], timeoutMs: HITL_TEST_TIMEOUT_MS }));
    const result = await backend.do(principal, 'p', 'rm -rf /tmp/x');
    expect(result.exitCode).toBe(1);
    // the danger reason here is the door's own classification of 'rm -rf /tmp/x' (classifyShellArgv)
    expect(result.message).toContain('els do: deny, not sent (recursive rm)');
    expect(result.message).toContain('[rejected: recursive rm]');
    expect(audit(dir).map((row) => row.result)).toEqual(['rejected']);
    expect(audit(dir).every((row) => row.text === undefined)).toBe(true);
  });

  test('silence until the timeout → timeout, not sent (fail-closed)', async () => {
    const { backend } = door(mcpHitlAsk({ channels: [fakeConfirmChannel('timeout')], timeoutMs: HITL_TEST_TIMEOUT_MS }));
    const result = await backend.do(principal, 'p', 'rm -rf /tmp/x');
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('els do: timeout, not sent (recursive rm)');
  });

  test('nobody to ask (hitl absent) → held, not sent', async () => {
    const { backend } = door();
    const result = await backend.do(principal, 'p', 'rm -rf /tmp/x');
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('els do: held, not sent (recursive rm; nobody to approve)');
  });
});
