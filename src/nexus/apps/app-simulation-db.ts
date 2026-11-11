import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sqlNowIso } from '../../time/db-window.js';
import { nexusRootDir } from '../paths.js';
import { validateAppSimulationResult, type AppSimulationEvent, type AppSimulationReceipt, type AppSimulationSnapshot } from './app-simulation.js';
import type { SimReceipt } from '../../ux-sim/sim-receipt.js';

interface EventRow { event_json: string }
interface ReceiptRow { receipt_json: string }

export interface AppSimulationStore {
  record(value: unknown): void;
  recordWithConceptProof(value: unknown, receiptId: string, createProof: (receipt: AppSimulationReceipt) => SimReceipt): void;
  recordConceptProof(receiptId: string, proof: SimReceipt): void;
  snapshot(appId: string): AppSimulationSnapshot;
  close(): void;
}

/** Simulation-only records live separately from the operational app lifecycle ledger. */
export function createAppSimulationStore(databasePath = join(nexusRootDir(), 'app-simulation.sqlite')): AppSimulationStore {
  if (!databasePath.trim()) throw new Error('app simulation database path is required');
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(databasePath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS app_simulation_runs (
    run_id TEXT PRIMARY KEY, outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed')), created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS app_simulation_events (
    run_id TEXT NOT NULL, app_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL,
    PRIMARY KEY(run_id, app_id, sequence), FOREIGN KEY(run_id) REFERENCES app_simulation_runs(run_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS app_simulation_receipts (
    receipt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, app_id TEXT NOT NULL, receipt_json TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES app_simulation_runs(run_id)
  )`);
  const insertRun = db.query('INSERT OR IGNORE INTO app_simulation_runs(run_id, outcome, created_at) VALUES (?, ?, ?)');
  const insertEvent = db.query('INSERT OR IGNORE INTO app_simulation_events(run_id, app_id, sequence, event_json) VALUES (?, ?, ?, ?)');
  const insertReceipt = db.query('INSERT OR IGNORE INTO app_simulation_receipts(receipt_id, run_id, app_id, receipt_json) VALUES (?, ?, ?, ?)');
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error('app simulation store is closed'); };
  const record = (value: unknown, proofSpec?: { readonly receiptId: string; readonly createProof: (receipt: AppSimulationReceipt) => SimReceipt }): void => {
    assertOpen();
    const result = validateAppSimulationResult(value);
    if (proofSpec && !result.receipts.some(receipt => receipt.id === proofSpec.receiptId)) throw new Error('concept proof receipt is absent from simulation result');
    const outcomes = new Set(result.receipts.map(receipt => receipt.outcome));
    const outcome = outcomes.size === 1 && outcomes.has('passed') ? 'passed' : 'failed';
    const createdAt = (db.query(`SELECT ${sqlNowIso()} AS created_at`).get() as { created_at: string }).created_at;
    db.exec('BEGIN IMMEDIATE');
    try {
      insertRun.run(result.runId, outcome, createdAt);
      const existing = db.query('SELECT outcome FROM app_simulation_runs WHERE run_id = ?').get(result.runId) as { outcome: string } | null;
      if (!existing || existing.outcome !== outcome) throw new Error('app simulation run id conflicts with existing result');
      const eventSequences = new Map<string, number>();
      for (const event of result.events) {
        const sequence = (eventSequences.get(event.appId) ?? 0) + 1;
        eventSequences.set(event.appId, sequence);
        const stored: AppSimulationEvent = { ...event, id: `${result.runId}:${event.appId}:${sequence}` };
        insertEvent.run(result.runId, event.appId, sequence, JSON.stringify(stored));
      }
      for (const receipt of result.receipts) {
        const stored: AppSimulationReceipt = { ...receipt, createdAt };
        const proof = proofSpec?.receiptId === receipt.id ? proofSpec.createProof(stored) : undefined;
        if (proof && (proof.appSimulationReceiptId !== stored.id || proof.appSimulationRunId !== stored.runId || proof.appId !== stored.appId)) {
          throw new Error('concept proof does not match its app simulation receipt');
        }
        insertReceipt.run(receipt.id, result.runId, receipt.appId, JSON.stringify(proof ? { ...stored, conceptProof: proof } : stored));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    record(value) { record(value); },
    recordWithConceptProof(value, receiptId, createProof) { record(value, { receiptId, createProof }); },
    recordConceptProof(receiptId, proof) {
      assertOpen();
      if (!receiptId.trim() || proof.schema !== 'elanous.sim-receipt.v1'
        || !/^[a-f0-9]{64}$/.test(proof.receiptFingerprint)
        || !['passed', 'failed', 'stale', 'unmeasured'].includes(proof.verdict)) {
        throw new Error('invalid app simulation concept proof');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.query('SELECT receipt_json FROM app_simulation_receipts WHERE receipt_id = ?').get(receiptId) as ReceiptRow | null;
        if (!row) throw new Error('app simulation receipt is unavailable');
        const receipt = JSON.parse(row.receipt_json) as AppSimulationReceipt;
        if (receipt.id !== proof.appSimulationReceiptId || receipt.appId !== proof.appId || receipt.runId !== proof.appSimulationRunId) {
          throw new Error('concept proof does not match its app simulation receipt');
        }
        db.query('UPDATE app_simulation_receipts SET receipt_json = ? WHERE receipt_id = ?')
          .run(JSON.stringify({ ...receipt, conceptProof: proof }), receiptId);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    snapshot(appId) {
      assertOpen();
      const run = db.query(`SELECT run_id, outcome FROM app_simulation_runs
        WHERE run_id IN (SELECT run_id FROM app_simulation_events WHERE app_id = ?)
        ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(appId) as { run_id: string; outcome: 'passed' | 'failed' } | null;
      if (!run) return { status: 'not-created', events: [], receipts: [] };
      const events = db.query(`SELECT event_json FROM app_simulation_events
        WHERE run_id = ? AND app_id = ? ORDER BY sequence`).all(run.run_id, appId) as EventRow[];
      const receipts = db.query(`SELECT receipt_json FROM app_simulation_receipts
        WHERE run_id = ? AND app_id = ? ORDER BY rowid DESC LIMIT 5`).all(run.run_id, appId) as ReceiptRow[];
      return { status: run.outcome, runId: run.run_id,
        events: events.map(row => JSON.parse(row.event_json) as AppSimulationEvent),
        receipts: receipts.map(row => JSON.parse(row.receipt_json) as AppSimulationReceipt) };
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
