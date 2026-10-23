import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../../bin/elanous.mjs', import.meta.url).pathname;
const cwd = new URL('../../', import.meta.url).pathname;
const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe('guardian doctor shadow production entry', () => {
  test('doctor-shadow consumes each pending admission visit once', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-doctor-shadow-'));
    const runId = 'run-1a2b3c4d-0000-4000-8000-000000000003';
    try {
      const dir = join(root, 'run-ledger');
      mkdirSync(dir);
      const path = join(dir, `${runId}.jsonl`);
      writeFileSync(path, [
        { timestamp: '2026-10-22T00:00:00.000Z', runId, event: 'start', data: {} },
        { timestamp: '2026-10-22T00:01:00.000Z', runId, event: 'doctor-visit', data: { from: 'supervisor', symptom: 'admit-starved', evidence: 'first wait' } },
        { timestamp: '2026-10-22T00:02:00.000Z', runId, event: 'doctor-visit', data: { from: 'parent', symptom: 'admit-starved', evidence: 'second wait' } },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const invoke = () => Bun.spawnSync({
        cmd: [process.execPath, cli, `--test=${root}`, 'guardian', 'doctor-shadow', '--run', runId, '--json'], cwd,
        env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(JSON.parse(decode(invoke().stdout))).toMatchObject({ status: 'recorded', visitIndex: 1 });
      expect(JSON.parse(decode(invoke().stdout))).toMatchObject({ status: 'recorded', visitIndex: 2 });
      expect(JSON.parse(decode(invoke().stdout))).toEqual({ status: 'already-recorded', visitIndex: 2 });
      const entries = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(entries.filter((entry) => entry.event === 'doctor-rx').map((entry) => entry.data.visitIndex)).toEqual([1, 2]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  test('doctor-shadow records one evidence-linked admission reevaluation and never executes it', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-doctor-shadow-'));
    const runId = 'run-1a2b3c4d-0000-4000-8000-000000000001';
    try {
      const dir = join(root, 'run-ledger');
      mkdirSync(dir);
      const path = join(dir, `${runId}.jsonl`);
      writeFileSync(path, [
        { timestamp: '2026-10-22T00:00:00.000Z', runId, event: 'start', data: {} },
        { timestamp: '2026-10-22T00:01:00.000Z', runId, event: 'doctor-visit', data: { from: 'supervisor', symptom: 'admit-starved', evidence: 'slot wait 90s on node-c' } },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const invoke = () => Bun.spawnSync({
        cmd: [process.execPath, cli, `--test=${root}`, 'guardian', 'doctor-shadow', '--run', runId, '--json'], cwd,
        env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'pipe', stderr: 'pipe',
      });
      const first = invoke();
      expect(first.exitCode, decode(first.stderr)).toBe(0);
      expect(JSON.parse(decode(first.stdout))).toEqual({ status: 'recorded', rx: 're-evaluate-member', outcome: 'shadow-recorded', visitIndex: 1 });
      const second = invoke();
      expect(second.exitCode, decode(second.stderr)).toBe(0);
      expect(JSON.parse(decode(second.stdout))).toEqual({ status: 'already-recorded', visitIndex: 1 });
      const entries = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(entries.map((entry) => entry.event)).toEqual(['start', 'doctor-visit', 'doctor-rx']);
      expect(entries[2].data).toMatchObject({
        shadow: true, visitIndex: 1, diagnosis: 'admit-starved-reported', rx: 're-evaluate-member',
        outcome: 'shadow-recorded', execution: 'none', cost: { estimatedTokens: 0, usedTokens: 0 },
        visit: { evidence: 'slot wait 90s on node-c', symptom: 'admit-starved' },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  test('doctor-shadow hands missing admission evidence back without a prescription', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-doctor-shadow-'));
    const runId = 'run-1a2b3c4d-0000-4000-8000-000000000002';
    try {
      const dir = join(root, 'run-ledger');
      mkdirSync(dir);
      const path = join(dir, `${runId}.jsonl`);
      writeFileSync(path, [
        { timestamp: '2026-10-22T00:00:00.000Z', runId, event: 'start', data: {} },
        { timestamp: '2026-10-22T00:01:00.000Z', runId, event: 'doctor-visit', data: { from: 'seat', symptom: 'admit-starved' } },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const result = Bun.spawnSync({
        cmd: [process.execPath, cli, `--test=${root}`, 'guardian', 'doctor-shadow', '--run', runId, '--json'], cwd,
        env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(result.exitCode, decode(result.stderr)).toBe(0);
      expect(JSON.parse(decode(result.stdout))).toEqual({ status: 'recorded', outcome: 'needs-evidence', visitIndex: 1 });
      const rx = JSON.parse(readFileSync(path, 'utf8').trim().split('\n')[2]!);
      expect(rx.data).toMatchObject({ rx: null, execution: 'none', handoff: 'visit-owner-provide-admission-evidence' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
});
