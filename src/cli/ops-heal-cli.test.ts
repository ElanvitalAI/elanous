import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';

const root = mkdtempSync(join(tmpdir(), 'ops-heal-cli-'));
const ops = join(root, 'seat-state', 'OPS');
mkdirSync(join(ops, 'tb'), { recursive: true });
mkdirSync(join(ops, 'tb', 'evidence'), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function card(signal: string, body: string): void {
  writeFileSync(join(ops, 'tb', `${signal}.yaml`), body);
}
const run = (signal: string) => simCli(['ops', 'heal', signal], {
  mode: 'spawn', stateRoot: root, allowPaths: [['ops', 'heal']], timeoutMs: 30_000,
});

describe('registered ops heal CLI with three synthetic signal cards', () => {
  test('rail exit1 and lost tab diagnose real evidence and stop at risky HITL', async () => {
    for (const signal of ['rail-catchup-exit1', 'tab-session-gone']) {
      writeFileSync(join(ops, 'tb', 'evidence', `${signal}.log`), `${signal}: synthetic observed failure\n`);
      card(signal, readFileSync(join(import.meta.dir, "../ux-sim/fixtures/ops-heal", signal + ".yaml"), "utf8"));
      const result = await run(signal);
      expect(result.exitCode).toBe(2);
      const output = JSON.parse(result.stdout.trim());
      expect(output).toMatchObject({ signal, outcome: 'hitl', repair: [], verify: [] });
      expect(output.diagnose[0].detail).toContain('synthetic observed failure');
    }
  }, 60_000);

  test('pregate load card executes bounded safe repair and verifies, then third hit opens one improvement', async () => {
    const signal = 'pregate-load-over';
    card(signal, readFileSync(join(import.meta.dir, "../ux-sim/fixtures/ops-heal", signal + ".yaml"), "utf8"));
    const outputs = [];
    for (let i = 0; i < 3; i++) {
      const result = await run(signal);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      expect(result.exitCode).toBe(0);
      outputs.push(JSON.parse(result.stdout.trim()));
    }
    expect(outputs.map((output) => output.improvementOpened)).toEqual([false, false, true]);
    expect(outputs[2]).toMatchObject({ outcome: 'ready', diagnose: [{ action: 'host.load.read', ok: true }], repair: [{ action: 'host.load.wait', ok: true }], verify: [{ action: 'host.load.verify', ok: true }] });
    const ledger = readFileSync(join(ops, 'heal-events.jsonl'), 'utf8').trim().split('\n');
    expect(ledger).toHaveLength(5);
    const checklist = await simCli(['release', 'checklist', 'status', '--version', '0.3.33', '--json'], {
      mode: 'spawn', stateRoot: root, allowPaths: [['release', 'checklist', 'status']], timeoutMs: 30_000,
    });
    expect(checklist.exitCode).toBe(0);
    expect(checklist.stdout).toContain('HEAL-CARD-IMPROVE-PREGATE-LOAD-OVER');
  }, 90_000);

  test('unregistered action is rejected before ledger or repair', async () => {
    card('unsafe-card', `signal: unsafe-card\nowner: RES\ndiagnose:\n  - action: shell.exec\nrepair:\n  - action: hitl.request\n    risk: hitl\nverify:\n  - action: host.load.read\nescalate: {after: 1, message: operator}\n`);
    const before = readFileSync(join(ops, 'heal-events.jsonl'), 'utf8');
    const result = await run('unsafe-card');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsupported diagnose action');
    expect(readFileSync(join(ops, 'heal-events.jsonl'), 'utf8')).toBe(before);
  }, 30_000);

  test('reading a historical evidence file cannot manufacture READY', async () => {
    const before = readFileSync(join(ops, 'heal-events.jsonl'), 'utf8');
    card('false-ready', readFileSync(join(import.meta.dir, '../ux-sim/fixtures/ops-heal/false-ready.yaml'), 'utf8'));
    const result = await run('false-ready');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('safe READY requires the pregate load verifier');
    expect(readFileSync(join(ops, 'heal-events.jsonl'), 'utf8')).toBe(before);
  }, 30_000);

  test('card cannot read an OP file outside the evidence directory', async () => {
    const before = readFileSync(join(ops, 'heal-events.jsonl'), 'utf8');
    card('outside-evidence', `signal: outside-evidence\nowner: RES\ndiagnose:\n  - action: evidence.read\n    args: {path: OP/private.json}\nrepair:\n  - action: hitl.request\n    risk: hitl\nverify:\n  - action: evidence.read\n    args: {path: OP/private.json}\nescalate: {after: 1, message: operator}\n`);
    const result = await run('outside-evidence');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid path');
    expect(readFileSync(join(ops, 'heal-events.jsonl'), 'utf8')).toBe(before);
  }, 30_000);

  test('linked card is rejected; linked evidence becomes explicit HITL diagnosis failure', async () => {
    const before = readFileSync(join(ops, 'heal-events.jsonl'), 'utf8');
    symlinkSync(join(ops, 'tb', 'pregate-load-over.yaml'), join(ops, 'tb', 'linked-card.yaml'));
    const linkedCard = await run('linked-card');
    expect(linkedCard.exitCode).toBe(1);
    expect(readFileSync(join(ops, 'heal-events.jsonl'), 'utf8')).toBe(before);

    symlinkSync(join(ops, 'tb', 'evidence', 'rail-catchup-exit1.log'), join(ops, 'tb', 'evidence', 'linked-evidence.log'));
    card('linked-evidence', `signal: linked-evidence\nowner: RES\ndiagnose:\n  - action: evidence.read\n    args: {path: OPS/tb/evidence/linked-evidence.log}\nrepair:\n  - action: hitl.request\n    risk: hitl\nverify:\n  - action: host.load.read\nescalate: {after: 1, message: linked evidence needs operator}\n`);
    const linkedEvidence = await run('linked-evidence');
    expect(linkedEvidence.exitCode).toBe(2);
    expect(JSON.parse(linkedEvidence.stdout.trim())).toMatchObject({ outcome: 'hitl', diagnose: [{ ok: false }] });
  }, 60_000);
});
