import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphRunState } from '../../src/graph-runner/runner.js';
import { DecisionLedger } from '../../src/decisions/decision-ledger.js';
import { reserveReleaseResumeAttempt } from './resume-cap.js';
import { resumeReleaseRun } from './resume-release.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), 'release-resume-cap-')); roots.push(path); return path; };
const state = (resume = false) => ({ runId: 'run-1', input: { version: '0.2.34' }, ...(resume ? { resume: { from: 'gate', at: '2026-10-19T00:00:00Z', previousStatus: 'failed' } } : {}) }) as GraphRunState;

test('third and later release resumes keep recording attempts without a disposition card', () => {
  const ledger = root();
  const options = { now: () => new Date('2026-10-19T03:00:00Z') };
  expect(reserveReleaseResumeAttempt(state(), ledger, options).attempt).toBe(1);
  const second = reserveReleaseResumeAttempt(state(), ledger, options);
  expect(second.attempt).toBe(2);
  expect(reserveReleaseResumeAttempt(state(), ledger, options).attempt).toBe(3);
  expect(reserveReleaseResumeAttempt(state(), ledger, options).attempt).toBe(4);
  expect(JSON.parse(readFileSync(second.path, 'utf8')).attempts).toHaveLength(4);
  expect(new DecisionLedger({ stateDir: ledger }).list({ status: 'open' })).toHaveLength(0);
});

test('preflight capacity checks do not consume a resume attempt', () => {
  const ledger = root();
  expect(reserveReleaseResumeAttempt(state(), ledger, { checkOnly: true }).attempt).toBe(1);
  expect(reserveReleaseResumeAttempt(state(), ledger, { checkOnly: true }).attempt).toBe(1);
  expect(reserveReleaseResumeAttempt(state(), ledger).attempt).toBe(1);
  expect(reserveReleaseResumeAttempt(state(), ledger, { checkOnly: true }).attempt).toBe(2);
});

test('dry-run after two attempts previews the third without mutation or a card', () => {
  const ledger = root();
  reserveReleaseResumeAttempt(state(), ledger);
  reserveReleaseResumeAttempt(state(), ledger);
  expect(reserveReleaseResumeAttempt(state(), ledger, { checkOnly: true }).attempt).toBe(3);
  expect(new DecisionLedger({ stateDir: ledger }).list({ status: 'open' })).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(ledger, 'release', '0.2.34', 'resume-attempts', 'run-1.json'), 'utf8')).attempts).toHaveLength(2);
});

test('a legacy resumed run without an attempt ledger starts a new observed count', () => {
  const ledger = root();
  const first = reserveReleaseResumeAttempt(state(true), ledger);
  expect(first).toMatchObject({ attempt: 1, priorCountKnown: false });
  expect(reserveReleaseResumeAttempt(state(true), ledger)).toMatchObject({ attempt: 2, priorCountKnown: false });
  expect(JSON.parse(readFileSync(first.path, 'utf8')).priorCountKnown).toBe(false);
  expect(new DecisionLedger({ stateDir: ledger }).list({ status: 'open' })).toHaveLength(0);
});

test('invalid run ids and damaged attempt ledgers fail closed', () => {
  const ledger = root();
  expect(() => reserveReleaseResumeAttempt({ ...state(), runId: '../escape' }, ledger)).toThrow('valid saved version and run id');
  const path = join(ledger, 'release', '0.2.34', 'resume-attempts', 'run-1.json');
  mkdirSync(join(ledger, 'release', '0.2.34', 'resume-attempts'), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: '0.2.34', runId: 'run-1', attempts: ['invalid date'] }));
  expect(() => reserveReleaseResumeAttempt(state(), ledger)).toThrow('attempts ledger invalid');
  expect(readFileSync(path, 'utf8')).toContain('invalid date');
});

test('third gate waiver request reaches waiver validation without a disposition card', async () => {
  const ledger = root();
  const saved = { ...state(), graphId: 'release-loop', path: ['version-release', 'gate', 'failed'], nodes: [
    { nodeId: 'version-release', ok: true, executed: true, exit: 0 },
    { nodeId: 'gate', ok: false, executed: true, exit: null },
    { nodeId: 'failed', ok: true, executed: true, exit: 0 },
  ] } as GraphRunState;
  const statePath = join(ledger, 'graph-runs', 'release-loop', `${saved.runId}.json`);
  mkdirSync(join(ledger, 'graph-runs', 'release-loop'), { recursive: true });
  writeFileSync(statePath, JSON.stringify(saved));
  reserveReleaseResumeAttempt(saved, ledger);
  reserveReleaseResumeAttempt(saved, ledger);
  await expect(resumeReleaseRun({ runId: saved.runId, from: 'gate', waive: 'gate', reason: 'Pod gate incomplete' },
    { root: ledger })).rejects.toThrow('release waiver requires a recorded release commit');
  const cards = new DecisionLedger({ stateDir: ledger }).list({ status: 'open' });
  expect(cards).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(ledger, 'release', '0.2.34', 'resume-attempts', `${saved.runId}.json`), 'utf8')).attempts).toHaveLength(2);
});
