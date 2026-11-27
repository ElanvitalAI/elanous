import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { tickAgent, voiceAgent, type AgentPorts, type VoiceLlm, type VoiceMessage } from '../runtime.js';
import { createBody, diagnoseRed, type DiagnosisRow, type FailedRun, type RedGate, type RetryRow, type RunDoctorDeps } from './run-doctor.js';

function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const T0 = Date.parse('2026-11-27T10:00:00Z');

// Seeded world: REDs settled 2h before T0 — at least 60% infra (timeouts / install), the rest content; one failed TA run.
function world(seed: number, opts: { allContent?: boolean } = {}) {
  const r = rng(seed);
  const n = 4 + Math.floor(r() * 4);
  const nContent = opts.allContent ? n : Math.floor(n * 0.4);
  const reds: RedGate[] = [];
  for (let i = 0; i < n; i++) {
    const content = i < nContent;
    const head = (0x7c64f4 * (seed + 1) + i).toString(16).padStart(12, '0').slice(0, 12) + '0'.repeat(28);
    const host = r() < 0.5 ? 'minim5' : 'node-b';
    reds.push({ id: `${41000 + i}-${head.slice(0, 12)}-${host}`, pr: 41000 + i, head, host, at: T0 - 120 * 60_000,
      stage: content ? (r() < 0.5 ? 'interference-ratchet' : 'rules-and-ratchets') : (r() < 0.5 ? 'changed-tsc' : 'frozen-install'),
      exit: content ? 1 : 124, failure: content ? 'interference-ratchet_RED' : 'changed-tsc_RED', mode: 'light', focused: ['src/a.test.ts'] });
  }
  const greens = new Map<number, number>();
  const runs: FailedRun[] = [{ runId: `run-${seed}`, graphId: 'ta-sprint', at: new Date(T0 - 30 * 60_000).toISOString(), cls: 'pod-died', stage: 'implement' }];
  const diag: DiagnosisRow[] = []; const retries: RetryRow[] = []; const spawned: Array<{ pr: number | null; host: string }> = []; const visits: string[] = [];
  let clock = T0;
  const deps: RunDoctorDeps = {
    redGates: () => reds.map(g => ({ ...g })),
    greens: () => new Map(greens),
    failedRuns: () => runs.map(x => ({ ...x })),
    hosts: () => ['node-b', 'minim5', 'mbp'],
    inflight: () => false,
    diagnoses: () => diag.map(d => ({ ...d })),
    writeDiagnosis: row => { diag.push(row); },
    recordRunVisit: run => { visits.push(run.runId); },
    retries: () => retries.map(x => ({ ...x })),
    // the other host is healthy: the retried head comes back GREEN
    retry: (g, host) => { spawned.push({ pr: g.pr, host }); if (g.pr !== null) greens.set(g.pr, clock + 60_000); return { ok: true, pid: 8000 + spawned.length, line: `pregate ${g.pr} --host ${host}` }; },
    recordRetry: row => { retries.push(row); },
  };
  return { reds, greens, runs, diag, retries, spawned, visits, deps, nContent, n, setClock: (ms: number) => { clock = ms; } };
}

function harness(seed: number, opts: { allContent?: boolean; llm?: VoiceLlm } = {}) {
  const root = mkdtempSync(join(tmpdir(), `rd-${seed}-`));
  const card = loadCard('run-doctor');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const posts: Array<{ key: string; to: string; body: string }> = [];
  const ports: AgentPorts = {
    memory, post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 800 + posts.length; },
    beat: () => {}, speak: () => {}, llm: opts.llm ?? null,
  };
  const w = world(seed, opts);
  return { root, card, memory, posts, ports, body: createBody({ stateRoot: root, card }, w.deps), ...w };
}

describe('run-doctor card · knowhow · diagnosis table', () => {
  test('card loads with L0 TC and a ratio KPI', () => {
    const c = loadCard('run-doctor');
    expect(c).toMatchObject({ id: 'run-doctor', address: 'RUN-DOCTOR', supervisor: 'TC', kpi: { name: 're_success_ratio', target: 0.5, dir: 'at_least' } });
    expect(c.rights.actions).toEqual(['diagnose', 'retry-other-host', 'retry-loop', 'card-loop-owner']);
  });
  test('knowhow seed parses', () => {
    const t = readFileSync(resolve(import.meta.dir, '../../../graphs/loop-agents/run-doctor/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(t, 'RUN-DOCTOR').length).toBeGreaterThanOrEqual(3);
  });
  test('diagnosis: timeout and pre-test stages are infra · baseline is not a blocker · ratchets go to the author', () => {
    expect(diagnoseRed({ stage: 'changed-tsc', exit: 124, failure: 'changed-tsc_RED', host: 'minim5' })).toMatchObject({ cls: 'changed-tsc-timeout@minim5', kind: 'infra' });
    expect(diagnoseRed({ stage: 'fetch-head', exit: 128, failure: null, host: 'node-b' })).toMatchObject({ cls: 'infra-fetch-head@node-b', kind: 'infra' });
    expect(diagnoseRed({ stage: 'baseline-focused', exit: 1, failure: null, host: 'node-b' }).kind).toBe('baseline');
    expect(diagnoseRed({ stage: 'baseline-focused', exit: 1, failure: 'FOCUSED_NEW_FAILURE', host: 'node-b' }).cls).toBe('focused-new-failure');
    expect(diagnoseRed({ stage: 'interference-ratchet', exit: 1, failure: null, host: 'mbp' })).toMatchObject({ cls: 'interference-ratchet', kind: 'content' });
    expect(diagnoseRed({ stage: 'changed-tsc', exit: 1, failure: null, host: 'mbp' }).cls).toBe('tsc-error');
  });
});

describe('sim: RED → wake → diagnose ⊕ one retry on another host → ratio ≥ 0.5 (seeds)', () => {
  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}`, async () => {
      const h = harness(seed);
      let t = T0;
      h.setClock(t);
      const r1 = await tickAgent(h.card, h.body, h.ports, new Date(t));
      expect(r1.kpi).toBe(0);
      expect(r1.kpiOk).toBe(false);
      expect(r1.acted.some(a => a.startsWith('retry-other-host:'))).toBe(true);
      let r = r1;
      for (let i = 0; i < 6 && !(r.kpiOk === true && h.diag.length >= h.n + 1); i++) { t += 10 * 60_000; h.setClock(t); r = await tickAgent(h.card, h.body, h.ports, new Date(t)); }
      expect(r.kpiOk).toBe(true);
      expect(r.kpi!).toBeGreaterThanOrEqual(0.5);
      expect(r.kpi).toBe(Math.round(((h.n - h.nContent) / h.n) * 100) / 100);
      // one retry per infra head, always on a different host; content REDs never retried
      expect(h.spawned.length).toBe(h.n - h.nContent);
      for (const s of h.spawned) expect(s.host).not.toBe(h.reds.find(g => g.pr === s.pr)!.host);
      expect(new Set(h.retries.map(x => x.key)).size).toBe(h.retries.length);
      // every failure has a card; the failed run is mirrored as a doctor visit
      expect(h.diag.length).toBe(h.n + 1);
      expect(h.visits).toEqual([`run-${seed}`]);
      expect(h.posts.filter(p => p.key.startsWith('kpi-breach')).length).toBe(0);
    });
  }
  test('content-only REDs cannot be closed by the doctor → exactly one L0 card to TC after escalate_after_min', async () => {
    const h = harness(5, { allContent: true });
    let t = T0;
    for (let i = 0; i < 8; i++) { h.setClock(t); await tickAgent(h.card, h.body, h.ports, new Date(t)); t += 31 * 60_000; }
    expect(h.spawned).toEqual([]);
    const l0 = h.posts.filter(p => p.key.startsWith('kpi-breach'));
    expect(l0.length).toBe(1);
    expect(l0[0]!.to).toBe('TC');
    expect(h.diag.filter(d => d.kind === 'content').length).toBe(h.n);
  });
});

function fakeLlm(): VoiceLlm {
  return {
    async complete(_system, user) {
      const said = user.slice(user.lastIndexOf('## 받은 말'));
      const infra = /\b(red:\d+-[0-9a-f]{12}-[a-z0-9]+)\([^)]*red-infra/u.exec(user)?.[1];
      if (/재실행/u.test(said) && infra) return { model: 'fake', text: JSON.stringify({ reply: `${infra} 를 다른 호스트로 한 번 돌린다.`, actions: [{ cmd: 'act', action: 'retry-other-host', target: infra }] }) };
      if (/고쳐/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '작성자 코드는 고치지 않는다.', actions: [{ cmd: 'edit-pr', pr: 41000 }] }) };
      const kpi = /re_success_ratio ([\d.]+)/u.exec(user)?.[1];
      const fact = /사실: ([^\n]*)/u.exec(user)?.[1]?.slice(0, 80) ?? '';
      return { model: 'fake', text: JSON.stringify({ reply: `재성공 비율 ${kpi ?? '?'} — ${fact}`, actions: [] }) };
    },
  };
}
const msg = (id: number, from: string, body: string): VoiceMessage => ({ id, from, body, at: '2026-11-27T10:00:00Z', channel: 'els:ws:supervisors', thread: 'els:ws:supervisors' });

describe('voice round-trip (fake LLM)', () => {
  test('answers why the KPI dropped from facts · retries inside rights · refuses editing a PR and escalates to TC', async () => {
    const h = harness(21, { llm: fakeLlm() });
    const deps = { card: h.card, body: h.body, ports: h.ports, now: new Date(T0) };
    const r1 = await voiceAgent(deps, msg(1, 'OP', '왜 KPI 가 떨어졌어?'));
    expect(r1.folded).toBe(false);
    expect(r1.reply).toMatch(/재성공 비율 0 — RED \d+\(PR \d+\)/u);
    const r2 = await voiceAgent(deps, msg(2, 'OP', '기반 RED 하나 재실행해'));
    expect(r2.actions.some(a => a.startsWith('act:retry-other-host:'))).toBe(true);
    expect(h.spawned.length).toBe(1);
    const r3 = await voiceAgent(deps, msg(3, 'OPC', '그 PR 직접 고쳐'));
    expect(r3.escalated).toBe(true);
    expect(h.posts.some(p => p.to === 'TC' && p.key.startsWith('voice-esc:'))).toBe(true);
  });
});
