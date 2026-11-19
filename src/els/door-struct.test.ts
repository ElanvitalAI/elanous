import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize, createControl, type AllowRule, type ControlAction } from './control.js';

const principal = { id: 'local:501', kind: 'cli' as const };
const target = { workspace: 'w1', tab: 't1', pane: 'p1', shell: false };

function rules(actions: readonly ControlAction[]): AllowRule[] {
  return [{ principal: '*', workspace: 'w1', pane: '*', actions }];
}

describe('ELS-DOOR-STRUCT-OPS · authorize', () => {
  test('tab 규칙은 대상 탭이 일치할 때만 통과', () => {
    const scoped = [{ ...rules(['close'])[0], tab: 't1' }];
    expect(authorize(scoped, principal, { ...target, tab: 't1' }, 'close')).toBe(true);
    expect(authorize(scoped, principal, { ...target, tab: 't9' }, 'close')).toBe(false);
  });
  test('tab 없는 요청에 tab 규칙은 통과하지 않는다', () => {
    expect(authorize([{ ...rules(['close'])[0], tab: 't1' }], principal, { workspace: 'w1', tab: '', pane: 'p1', shell: false }, 'close')).toBe(false);
  });
});

describe('ELS-DOOR-STRUCT-OPS · close 사람 확인 표시', () => {
  test('confirm 없는 close는 문이 거부한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'door-struct-'));
    writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: rules(['close', 'rename', 'move']) }));
    const auditLines: string[] = [];
    const control = createControl({ stateDir: dir, appendAudit: (_p, line) => { auditLines.push(line); }, execute: async (input) => ({ exitCode: 0, message: 'ok' }) });
    const outcome = await control.run({ principal, from: 'OP', action: 'close', target, struct: { kind: 'tab', id: 't1' } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('denied');
    if (!outcome.ok) expect(outcome.reason).toBe('close needs confirm:true (human confirmation)');
    expect(auditLines.join('')).toContain('"result":"denied"');
  });
  test('confirm:true close는 허용 규칙 아래 실행된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'door-struct-'));
    writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: rules(['close']) }));
    const calls: string[] = [];
    const control = createControl({ stateDir: dir, execute: async (input) => { calls.push(input.action); return { exitCode: 0, message: 'ok' }; } });
    const outcome = await control.run({ principal, from: 'OP', action: 'close', target, struct: { kind: 'tab', id: 't1' }, confirm: true });
    expect(calls).toEqual(['close']);
    expect(outcome.ok).toBe(true);
  });
});

describe('ELS-DOOR-STRUCT-OPS · 허용 밖 동작 거부', () => {
  test('rename은 rename을 허용하지 않는 규칙 아래 거부된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'door-struct-'));
    writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: rules(['read']) }));
    const auditLines: string[] = [];
    const control = createControl({ stateDir: dir, appendAudit: (_p, line) => { auditLines.push(line); }, execute: async () => ({ exitCode: 0, message: 'ok' }) });
    const outcome = await control.run({ principal, from: 'OP', action: 'rename', target, struct: { kind: 'workspace', id: 'w1', name: 'n' } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('denied');
    expect(auditLines.join('')).toContain('"result":"denied"');
  });
});
