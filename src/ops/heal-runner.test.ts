import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHealCard, type HealCard, type HealActionResult } from './heal-runner.js';

const card = (signal: string, repairRisk: 'safe' | 'hitl'): HealCard => ({
  signal, owner: 'RES-INFRA',
  diagnose: [{ action: `${signal}.diagnose` }],
  repair: [{ action: `${signal}.repair`, risk: repairRisk, rollback: 'restore prior state' }],
  verify: [{ action: `${signal}.verify` }],
  escalate: { after: 1, message: 'operator must inspect the diagnosis' },
});

describe('OPS heal synthetic signal device', () => {
  for (const [signal, risk, expected] of [
    ['rail-catchup-exit1', 'hitl', 'hitl'],
    ['pregate-load-over', 'safe', 'ready'],
    ['tab-session-gone', 'hitl', 'hitl'],
  ] as const) {
    test(`${signal}: diagnose → allowed repair/HITL → verify → one ledger row`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'heal-device-'));
      try {
        const calls: string[] = [];
        const execute = async (action: string): Promise<HealActionResult> => {
          calls.push(action);
          return { ok: true, detail: `observed ${action}` };
        };
        const result = await runHealCard(card(signal, risk), { ledgerDir: root, execute });
        expect(result.outcome).toBe(expected);
        expect(calls).toEqual(expected === 'ready'
          ? [`${signal}.diagnose`, `${signal}.repair`, `${signal}.verify`]
          : [`${signal}.diagnose`]);
        const rows = readFileSync(join(root, 'heal-events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ signal, outcome: expected, diagnose: [{ ok: true }] });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test('same signal third occurrence opens exactly one improvement cell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heal-device-'));
    try {
      const opened: string[] = [];
      const execute = async (): Promise<HealActionResult> => ({ ok: true, detail: 'observed' });
      for (let i = 0; i < 4; i++) await runHealCard(card('pregate-load-over', 'safe'), {
        ledgerDir: root, execute, openImprovement: (signal) => { opened.push(signal); },
      });
      expect(opened).toEqual(['pregate-load-over']);
      expect(readFileSync(join(root, 'heal-events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('failed diagnosis stops repair and verify, then records HITL with the failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heal-device-'));
    try {
      const calls: string[] = [];
      const result = await runHealCard(card('pregate-load-over', 'safe'), {
        ledgerDir: root,
        execute: async (action) => {
          calls.push(action);
          return { ok: false, detail: 'probe exit 2' };
        },
      });
      expect(result.outcome).toBe('hitl');
      expect(calls).toEqual(['pregate-load-over.diagnose']);
      expect(readFileSync(join(root, 'heal-events.jsonl'), 'utf8')).toContain('probe exit 2');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('ledger symlink is rejected without writing its target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heal-device-'));
    try {
      const outside = join(root, 'outside');
      const ledger = join(root, 'ledger');
      symlinkSync(outside, ledger);
      await expect(runHealCard(card('pregate-load-over', 'safe'), {
        ledgerDir: ledger, execute: async () => ({ ok: true, detail: 'observed' }),
      })).rejects.toThrow('ledger directory');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
