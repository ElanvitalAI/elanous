// CREDIT-PACE-METERING sim (seeds 1–5) — the REAL pulse body drives the 연료관 phase pass: with every codex subscription at
// 100 % and the default credit balance falling, the guardian writes llm-state (levels · phase · the day's spend), the YAML
// daily budget binds (credit level L2 → safety credits_deny), and the credit-pace ledger the rotation reads moves.
// Live 11-27 19:40: «no guardian state yet (all L0 · normal)» and credit-pace todaySpent 0 while ~1000 credit calls ran.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resetLlmAccountPackCache } from '../kit/resource-facts/llm-accounts.js';
import { latestState, llmAccountDecision, readLlmPolicyEvents, resetAppliedBeats, resetLlmDecisionCache } from '../kit/resource-facts/llm-decide.js';
import { creditPaceStatus } from '../budget/codex-credit-pace.js';
import { defaultLlmPolicy } from '../policy/llm-policy.js';
import { fileMemory } from '../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SUPERVISOR, type GuardianPorts, type GuardianView } from './body.js';
import { livePulseDeps, runResidentPulse, type PulseDeps } from './pulse.js';
import type { FuelPhasePorts } from './fuel-phase-run.js';

const REPO_PACK = resolve(import.meta.dir, '../../graphs/policies/llm-accounts.yaml');
const ENV = ['LLM_ACCOUNT_POLICY_PACK', 'LLM_ACCOUNT_POLICY_OVERLAY', 'RESOURCE_FACTS_LEDGER', 'ELANOUS_STATE_DIR'] as const;
const saved: Record<string, string | undefined> = {};
let dir = '';

function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'fuel-pulse-metering-'));
  copyFileSync(REPO_PACK, join(dir, 'pack.yaml'));
  process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'pack.yaml');
  process.env.LLM_ACCOUNT_POLICY_OVERLAY = join(dir, 'overlay.yaml');
  process.env.RESOURCE_FACTS_LEDGER = join(dir, 'events.jsonl');
  process.env.ELANOUS_STATE_DIR = join(dir, 'state');
  mkdirSync(join(dir, 'state'), { recursive: true });
  resetLlmAccountPackCache(); resetLlmDecisionCache(); resetAppliedBeats();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetLlmAccountPackCache(); resetLlmDecisionCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('the live pulse wires the 연료관 phase pass', () => {
  test('livePulseDeps hands the fuel sub-agent its phase ports (the line the #40510 merge lost)', () => {
    const d = livePulseDeps(new Date());
    try { expect(typeof d.fuelPhase).toBe('function'); } finally { d.close(); }
  });
});

describe('falling credit balance through the REAL pulse → llm-state · daily budget binds · pace ledger moves', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, () => {
      const r = rng(seed);
      const root = join(dir, 'state');
      const memory = fileMemory(root, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });
      // KST 12:00 — the KST day of the pace ledger and the guardian's day stay one day across the ~30 min of pulses.
      const t0 = Date.parse('2026-11-27T03:00:00Z');
      let balance = 30_000;
      const view: GuardianView = { now: new Date(t0), probes: [{ host: 'minim5', reachable: true, load1: 1, ncpu: 18 }], procs: new Map(), registry: new Map(), ready: { total: 0, p0: 0 }, hands: [] };
      const ports: GuardianPorts = { memory, kill: () => ({ killed: [], skipped: [] }), writeRoute: () => {}, post: () => 1, audit: () => {} };
      const pulse = (now: Date) => {
        const deps: PulseDeps = {
          stateRoot: root, now, memory,
          probes: () => [...view.probes],
          fuelSnapshot: () => ({ ts: now.getTime(), accounts: ['default', 'team', 'third'].map(account => ({ provider: 'codex', account, usedPercent: 100, status: 'ok' as const })) }),
          refreshFuel: () => {}, credentials: () => [], scanSecrets: () => [], supervisors: () => [],
          restart: () => {}, post: () => 1, heavy: () => ({ view, ports, close: () => {} }), beat: () => {},
          fuelPhase: (sent, mark): FuelPhasePorts => ({
            now, day: new Date(t0).toISOString().slice(0, 10), sent, mark,
            usage: () => ['default', 'team', 'third'].map(account => ({ provider: 'codex', account, usedPercent: 100, status: 'ok' as const })),
            credits: () => ({ 'openai-codex:default': balance }),
            maintenance: () => false, raise: () => null, decided: () => null, journal: () => {}, paceStateDir: root,
          }),
        };
        runResidentPulse(deps);
        resetLlmDecisionCache();
      };
      // The calls burn credits between pulses (the pulse ticks every ≤ 2 min; the 연료관 re-spawns on a change ≥ 2 min).
      for (let i = 0; balance > 0 && i < 40; i++) {
        pulse(new Date(t0 + i * 3 * 60_000));
        const st = latestState(readLlmPolicyEvents().events);
        const spent = st?.credits?.['openai-codex:default:credits']?.spent ?? 0;
        if (spent >= 30_000) break;
        balance = Math.max(0, balance - (1_500 + Math.floor(r() * 3_000)));
      }
      const st = latestState(readLlmPolicyEvents().events)!;
      expect(st).not.toBeNull();
      expect(st.levels['openai-codex:default']!.level).toBe('L3');
      expect(st.credits!['openai-codex:default:credits']!.spent).toBeGreaterThanOrEqual(30_000 - 4_500);
      // The budget binds once the day's spend reaches 30 000 (or the floor 2 000 is crossed first).
      const d = llmAccountDecision();
      const def = d.accounts.find(a => a.account === 'default')!;
      expect(['L2', 'L3']).toContain(def.creditLevel);
      expect([def.credits.value, def.credits.winner!.layer]).toEqual([false, 'safety']);
      // The rotation's credit-pace ledger moved with the same balances (todaySpent > 0 — was always 0 live).
      const pace = creditPaceStatus({ policy: defaultLlmPolicy(), balances: { default: balance }, now: new Date(t0 + 30 * 60_000), stateDir: root });
      expect(pace.todaySpent).toBe(30_000 - balance);
    });
  }
});
