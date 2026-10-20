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

test('release resumes reserve exactly two attempts and third request opens one defer-or-next-version decision', () => {
  const ledger = root(), cards: string[] = [];
  const options = { now: () => new Date('2026-10-19T03:00:00Z'), openCard: (_version: string, _runId: string, reason: string) => {
    cards.push(reason); return 'D-20261019-01';
  } };
  expect(reserveReleaseResumeAttempt(state(), ledger, options).attempt).toBe(1);
  const second = reserveReleaseResumeAttempt(state(), ledger, options);
  expect(second.attempt).toBe(2);
  expect(() => reserveReleaseResumeAttempt(state(), ledger, options)).toThrow('decision D-20261019-01');
  expect(cards).toEqual(['2 resumes already recorded']);
  expect(JSON.parse(readFileSync(second.path, 'utf8')).attempts).toHaveLength(2);
});

test('preflight capacity checks do not consume a resume attempt', () => {
  const ledger = root();
  expect(reserveReleaseResumeAttempt(state(), ledger, { checkOnly: true }).attempt).toBe(1);
  expect(reserveReleaseResumeAttempt(state(), ledger, { checkOnly: true }).attempt).toBe(1);
  expect(reserveReleaseResumeAttempt(state(), ledger).attempt).toBe(1);
  expect(reserveReleaseResumeAttempt(state(), ledger, { checkOnly: true }).attempt).toBe(2);
});

test('dry-run cap refusal does not create a decision card', () => {
  const ledger = root();
  reserveReleaseResumeAttempt(state(), ledger);
  reserveReleaseResumeAttempt(state(), ledger);
  expect(() => reserveReleaseResumeAttempt(state(), ledger, { checkOnly: true, noDecision: true }))
    .toThrow('release resume limit reached: 2 resumes already recorded');
  expect(new DecisionLedger({ stateDir: ledger }).list({ status: 'open' })).toHaveLength(0);
});

test('no-decision is restricted to read-only capacity checks', () => {
  const ledger = root();
  expect(() => reserveReleaseResumeAttempt(state(), ledger, { noDecision: true })).toThrow('noDecision requires checkOnly');
});

test('a legacy resumed run without an attempt ledger fails closed with a decision card', () => {
  const ledger = root();
  expect(() => reserveReleaseResumeAttempt(state(true), ledger, { openCard: () => 'D-20261019-02' })).toThrow('prior count is unknown');
});

test('the default third-attempt card is durable and has valid decision choices', () => {
  const ledger = root();
  reserveReleaseResumeAttempt(state(), ledger);
  reserveReleaseResumeAttempt(state(), ledger);
  expect(() => reserveReleaseResumeAttempt(state(), ledger)).toThrow('release resume limit reached');
  const cards = new DecisionLedger({ stateDir: ledger }).list({ status: 'open' });
  expect(cards).toHaveLength(1);
  expect(cards[0]?.options.map(option => option.key)).toEqual(['a', 'b']);
  expect(() => reserveReleaseResumeAttempt(state(), ledger)).toThrow(`decision ${cards[0]!.id}`);
});

test('third gate waiver request opens disposition before gate waiver validation', async () => {
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
    { root: ledger })).rejects.toThrow('release resume limit reached');
  const cards = new DecisionLedger({ stateDir: ledger }).list({ status: 'open' });
  expect(cards).toHaveLength(1);
  expect(cards[0]?.title).toContain('release resume limit');
  expect(JSON.parse(readFileSync(join(ledger, 'release', '0.2.34', 'resume-attempts', `${saved.runId}.json`), 'utf8')).attempts).toHaveLength(2);
});
