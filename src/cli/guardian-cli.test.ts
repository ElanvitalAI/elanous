import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { parse } from 'yaml';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { buildUserConfig, saveUserConfig } from '../user-config.js';
import { openSchedulesDb } from '../domains/schedule-registry.js';
import { recordScheduleRun } from '../domains/schedule-runs.js';
import { appendRunLedgerEntry, loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';

const cli = new URL('../../bin/elanous.mjs', import.meta.url).pathname;
const cwd = new URL('../../', import.meta.url).pathname;
const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe('guardian Commander production entry', () => {
  test('manual graph resolves a real shadow-only command and config parses guardian.mode', () => {
    const yaml = readFileSync('graphs/ops/guardian.yaml', 'utf8');
    const graph = parse(yaml);
    const parsedGraph = parseGraphTemplateYaml(yaml, 'graphs/ops/guardian.yaml');
    expect(parsedGraph.errors).toEqual([]);
    expect(parsedGraph.template).toBeDefined();
    const recipes = parse(readFileSync('graphs/ops/recipes.yaml', 'utf8'));
    expect(graph.loop.trigger.events).toEqual(['manual']);
    expect(graph.nodes.find((node: { node_id: string }) => node.node_id === graph.entry_node).recipe).toBe('cmd:guardian-shadow');
    expect(recipes['guardian-shadow'].command).toContain('guardian tick');
    const root = mkdtempSync(join(tmpdir(), 'guardian-config-'));
    try {
      const path = join(root, 'config.json');
      writeFileSync(path, JSON.stringify({ guardian: { mode: 'live' } }));
      const config = buildUserConfig(path);
      expect(config.guardian).toEqual({ mode: 'live' });
      saveUserConfig(config, path);
      expect(buildUserConfig(path).guardian).toEqual({ mode: 'live' });
      writeFileSync(path, JSON.stringify({ guardian: { mode: 'invalid' } }));
      expect(buildUserConfig(path).guardian).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('tick is reachable from index and never executes the registered command', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-cli-'));
    try {
      const db = openSchedulesDb(join(root, 'schedules.db'));
      db.run(`INSERT INTO schedule_registry (id, name, source, cron, command, category, enabled, run_via)
        VALUES ('unsafe', 'unsafe', 'crontab', '* * * * *', 'exit 123', 'maintenance', 1, 'crontab')`);
      db.close();
      const result = Bun.spawnSync({
        cmd: [process.execPath, cli, `--test=${root}`, 'guardian', 'tick'], cwd,
        env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(result.exitCode, decode(result.stderr)).toBe(0);
      const tick = JSON.parse(decode(result.stdout)) as { credentialAlert?: unknown };
      expect(tick).toMatchObject({ mode: 'shadow', wouldRun: ['unsafe'], executed: 0 });
      if ('credentialAlert' in tick) {
        expect(typeof tick.credentialAlert).toBe('string');
        expect(tick.credentialAlert).toContain('Grok 자격 만료 경보');
      }
      const observed = new Database(join(root, 'schedules.db'));
      try { expect(observed.query('SELECT COUNT(*) AS n FROM schedule_runs').get()).toEqual({ n: 0 }); }
      finally { observed.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  test('production tick records knowhow pack IDs from an isolated run ledger without dispatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-doctor-cli-'));
    const runId = 'run-0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';
    const ledgerDir = runLedgerDir(root);
    try {
      appendRunLedgerEntry({ timestamp: '2026-10-25T00:00:00.000Z', runId, event: 'run-start', data: {} }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-10-25T00:00:01.000Z', runId, event: 'knowhow-pack', data: { ids: ['K-TC-777'], injected: true } }, ledgerDir);
      appendRunLedgerEntry({ timestamp: '2026-10-25T00:00:02.000Z', runId, event: 'doctor-visit', data: { from: 'supervisor', symptom: 'admit-starved', evidence: 'admission queue stalled' } }, ledgerDir);
      for (let i = 0; i < 2; i++) {
        const result = Bun.spawnSync({
          cmd: [process.execPath, cli, `--test=${root}`, 'guardian', 'tick'], cwd,
          env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'pipe', stderr: 'pipe',
        });
        expect(result.exitCode, decode(result.stderr)).toBe(0);
        expect(JSON.parse(decode(result.stdout)).executed).toBe(0);
      }
      const prescriptions = loadRunLedger(runId, ledgerDir)!.filter(row => row.event === 'doctor-rx');
      expect(prescriptions).toHaveLength(1);
      expect(prescriptions[0]!.data).toMatchObject({ knowhowPackSliceIds: ['K-TC-777'], execution: 'none' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  test('configured live refuses the CLI before any execution or schedule run record', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-live-refusal-'));
    try {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ guardian: { mode: 'live' } }));
      const db = openSchedulesDb(join(root, 'schedules.db'));
      db.run(`INSERT INTO schedule_registry (id, name, source, cron, command, category, enabled, run_via)
        VALUES ('unsafe', 'unsafe', 'crontab', '* * * * *', 'exit 123', 'maintenance', 1, 'crontab')`);
      db.close();
      const result = Bun.spawnSync({
        cmd: [process.execPath, cli, `--test=${root}`, '--config-dir', root, 'guardian', 'tick'], cwd,
        env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(result.exitCode).not.toBe(0);
      expect(decode(result.stderr)).toContain('outside GUARD-ONE-a');
      const observed = new Database(join(root, 'schedules.db'));
      try { expect(observed.query('SELECT COUNT(*) AS n FROM schedule_runs').get()).toEqual({ n: 0 }); }
      finally { observed.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  test('compare --day --json reaches guardianShadowDay through index and reads actual schedule_runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-compare-cli-'));
    try {
      const db = openSchedulesDb(join(root, 'schedules.db'));
      db.run(`INSERT INTO schedule_registry (id, name, source, cron, command, category, enabled, run_via)
        VALUES ('once', 'once', 'crontab', '0 4 * * *', 'exit 123', 'maintenance', 1, 'crontab')`);
      recordScheduleRun(db, 'once', { at: '2026-10-06T19:00:00.000Z', status: 'ok', via: 'crontab' });
      db.close();
      const result = Bun.spawnSync({
        cmd: [process.execPath, cli, `--test=${root}`, 'guardian', 'compare', '--day', '2026-10-07', '--json'], cwd,
        env: { ...process.env, ELANOUS_STATE_DIR: root, TZ: 'Asia/Seoul' }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(result.exitCode, decode(result.stderr)).toBe(0);
      expect(JSON.parse(decode(result.stdout))).toMatchObject({ same: true,
        jobs: [{ job: 'once', would: 1, actual: 1, alertsActual: null }], diff: [] });
      const invalid = Bun.spawnSync({
        cmd: [process.execPath, cli, `--test=${root}`, 'guardian', 'compare', '--day', '2026-02-30', '--json'], cwd,
        env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(invalid.exitCode).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
});
