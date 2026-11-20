import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControl, defaultDecision, CONFIRM_REQUIRED_ACTIONS, type Principal, type ControlAction, type ControlTarget } from './control.js';

// ELS-OP-ALLOW-RULE(ELS-OP-SMALLWINS ⑦) — coded default door rules:
// OP seat commands every pane; hand seats only their own bound workspaces;
// close/move need a human confirmation marker; anything else denies with audit.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'els-allow-rule-')); dirs.push(dir); return dir; };

const opSeat: Principal = { id: 'op-door', kind: 'eln', seat: 'OP' };
const handSeat: Principal = { id: 'HAND-ELN-ELS-MCP', kind: 'eln', seat: 'HAND-ELN-ELS-MCP', workspaces: ['els-mcp'] };
const target = (workspace: string): ControlTarget => ({ workspace, pane: 'p1', shell: false });

describe('defaultDecision(순수 함수)', () => {
  test('OP 좌석은 남의 workspace do를 허용', () => {
    expect(defaultDecision(opSeat, target('HQ'), 'do', false))
      .toEqual({ allow: true, reason: 'default rules: OP seat commands all panes' });
  });
  test('손 좌석은 자기 공간만 허용 — 남의 공간 거부', () => {
    expect(defaultDecision(handSeat, target('els-mcp'), 'do', false)?.allow).toBe(true);
    const other = defaultDecision(handSeat, target('HQ'), 'do', false);
    expect(other?.allow).toBe(false);
    expect(other?.reason).toContain('may control only its own workspaces');
  });
  test('close/move는 확인 표시 없으면 거부 — OP 좌석도', () => {
    expect(defaultDecision(opSeat, target('HQ'), 'close' as ControlAction, false))
      .toEqual({ allow: false, reason: 'close needs confirm:true (human confirmation)' });
    expect(defaultDecision(opSeat, target('HQ'), 'move' as ControlAction, false)?.allow).toBe(false);
    expect(defaultDecision(opSeat, target('HQ'), 'move' as ControlAction, true)?.allow).toBe(true);
    expect(CONFIRM_REQUIRED_ACTIONS.has('close')).toBe(true);
    expect(CONFIRM_REQUIRED_ACTIONS.has('do')).toBe(false);
  });
  test('좌석 없는 principal은 기본값 규칙 밖 — null', () => {
    expect(defaultDecision({ id: 'local:501', kind: 'cli' }, target('HQ'), 'do', false)).toBe(null);
  });
});

describe('제어 문 run() 통합', () => {
  const door = (dir: string) => {
    const ran: string[] = [];
    const control = createControl({
      stateDir: dir,
      execute: async (input) => { ran.push(input.text ?? ''); return { exitCode: 0, message: 'delivered' }; },
      now: () => 1_700_000_000_000,
    });
    return { control, ran };
  };
  const auditRows = (dir: string) =>
    readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { result: string; reason?: string });

  test('OP 좌석 신원 → 남의 pane do 허용', async () => {
    const dir = stateDir();
    const { control, ran } = door(dir);
    const out = await control.run({ principal: opSeat, action: 'do', target: target('HQ'), text: 'ls' });
    expect(out.ok).toBe(true);
    expect(ran).toEqual(['ls']);
  });

  test('손 좌석 신원 → 남의 공간 do 거부 + 감사', async () => {
    const dir = stateDir();
    const { control, ran } = door(dir);
    const out = await control.run({ principal: handSeat, action: 'do', target: target('HQ'), text: 'ls' });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('denied');
      expect(out.reason).toContain('may control only its own workspaces');
      expect(out.message).toContain('HAND-ELN-ELS-MCP');
    }
    expect(ran).toEqual([]); // 실행 없음
    const rows = auditRows(dir);
    expect(rows.at(-1)?.result).toBe('denied');
    expect(rows.at(-1)?.reason).toContain('default rules');
  });

  test('손 좌석은 자기 공간 do 허용', async () => {
    const dir = stateDir();
    const { control, ran } = door(dir);
    const out = await control.run({ principal: handSeat, action: 'do', target: target('els-mcp'), text: 'ls' });
    expect(out.ok).toBe(true);
    expect(ran).toEqual(['ls']);
  });

  test('좌석 없는 principal은 종전대로 파일 규칙 거부', async () => {
    const dir = stateDir();
    const { control, ran } = door(dir);
    const out = await control.run({ principal: { id: 'local:501', kind: 'cli' }, action: 'do', target: target('HQ'), text: 'ls' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('not in control-allow.json');
    expect(ran).toEqual([]);
  });
});
