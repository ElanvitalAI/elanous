// LOOP-AGENT v3 executor kind `canary.check` — measure a build swap and roll it back when it regressed (RAIL-CANARY-AUTO-ROLLBACK ·
// 0.3.40 P0 · 대표 11-29 02:3x «등록이 아니라 당장 바로 시작»).
//
// S: three 11-28 night regressions (#40735 hands seat=null · GH mirror insteadOf origin · a seat's GitHub budget 300/300) rode
//    the 2-hourly rail into operations and stopped work 1–4 h each. Nothing measured the swap; the broken build stayed installed.
// C: a new supervisor is a plugin — an agent.yaml instance on a shared kind, no agent-specific TS (대표 11-28 08:4x). Any agent.yaml
//    whose body entry node is this kind gets this body (src/loop-agent/registry.ts registerKindBody); its probe pack is
//    graphs/policies/<agent.yaml canary.pack | id>.yaml and its numbers are its policies:.
// A: observe = the installed build (install.json) folded into <home>/canary.json ⊕ every probe of the pack read once (a candidate
//    regression inside the watch window is re-read confirm_reads times, confirm_gap_sec apart) · KPI = the age of an open confirmed
//    regression (canary_fail_to_rollback_minutes) · plan = kit decide → `rollback` (authority: executed · undo restore-build ·
//    1 per build sha · respect HOLD) or one hand-over `card` (limit · no-target · false-rollback) · actions = the doors:
//    `rollback` (the existing door `eln self-update --rollback` ⊕ the restart doors ⊕ one OP card with prev..new suspects) ·
//    `card` · `restore-build` (the undo — a person / the L0 asks for it, the plan never picks it).
//
// 세 얼굴: 관측 = <home>/canary.json (readings per probe per build · episodes · rollbacks · KPI) ⊕ the tick report / 판단 근거 = the
//          pack's fail_if per probe vs the previous build's reading (kit/canary judgeReading · isRegression) inside watch_window_min
//          / 수복과 인계 = rollback once per sha (journal row with its undo) → verify on the rolled-back build (verify_min) → a
//          probe that still fails = false rollback card; the same sha regressing again, an unknown rollback target and a refused
//          door are one card each to the L0 — never a second automatic move.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, Observation, PlannedAction, Subject } from '../runtime.js';
import { agentHome } from '../memory.js';
import { pn } from '../policy-context.js';
import {
  buildOf, canaryPolicy, decide, expand, expandArgv, extractValue, handoverCard, isRegression, judgeReading, kpiOf, noteBuild, noteRollback, parseCanaryPack,
  readCanaryState, rollbackCard, writeCanaryState, inWindow,
  type BuildInfo, type CanaryPack, type CanaryPolicy, type CanaryState, type Decision, type ProbeSpec, type RawRead, type Reading, type SuspectRow, type TemplateVars,
} from '../../kit/canary/index.js';

export const CANARY_KIND = 'canary.check';
const REPO = resolve(import.meta.dir, '../../..');

export interface RunResult { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }
export interface CanaryDeps {
  /** The probe pack (throws when unreadable or refused — the runtime records observe-error, subject-lost after 3). */
  pack(): CanaryPack;
  /** install.json as parsed JSON · null = unreadable. */
  installRecord(path: string): unknown;
  run(argv: readonly string[], timeoutSec: number): RunResult;
  readFile(path: string): { text: string; mtimeMs: number } | null;
  sensor(name: string, args: Readonly<Record<string, string>>, now: Date): number | null;
  sleep(ms: number): Promise<void>;
  /** Squash PRs on main in (from, to] (git log --first-parent) · null = unreadable. */
  suspects(repo: string, from: string, to: string): SuspectRow[] | null;
  post(key: string, to: string, body: string, kind: string): number | string | null | false;
  readonly vars: TemplateVars;
}

const tail = (r: RunResult): string => `${r.stderr}\n${r.stdout}`.trim().split('\n').filter(Boolean).slice(-2).join(' ⏎ ').slice(0, 160);
/** A door argv as a person types it (`{eln}` → eln). */
export const shownArgv = (argv: readonly string[]): string => argv.map(a => (a === '{eln}' ? 'eln' : a)).join(' ');
const exitLine = (r: RunResult, sec: number): string => (r.timedOut ? `timeout ${sec}s` : r.code === null ? 'no exit' : `exit ${r.code}`);

/** One read of one probe through the doors (no judgment). */
export function readProbe(p: ProbeSpec, deps: CanaryDeps, now: Date): RawRead {
  const r = p.read;
  if (r.kind === 'sensor') {
    let v: number | null;
    try { v = deps.sensor(r.sensor, r.args, now); } catch (e) { return { value: null, error: `sensor ${r.sensor}: ${e instanceof Error ? e.message : String(e)}` }; }
    return { value: v };
  }
  if (r.kind === 'file') {
    const path = expand(r.path, deps.vars, now);
    const f = deps.readFile(path);
    if (!f) return { value: null, error: `${path} unreadable` };
    const stale = r.maxAgeMin !== null && now.getTime() - f.mtimeMs > r.maxAgeMin * 60_000;
    let j: unknown;
    try { j = JSON.parse(f.text) as unknown; } catch { return { value: null, error: `${path} not JSON` }; }
    return { value: extractValue(j, r.json, now.getTime()), ...(stale ? { stale: true } : {}) };
  }
  const argv = expandArgv(r.argv, deps.vars, now);
  const out = deps.run(argv, r.timeoutSec);
  if (out.code !== 0) return { value: null, error: `${argv.slice(0, 4).join(' ')}: ${exitLine(out, r.timeoutSec)} · ${tail(out)}` };
  if (!r.json) return { value: 1, text: out.stdout };
  let j: unknown;
  try { j = JSON.parse(out.stdout) as unknown; } catch { return { value: null, error: `${argv.slice(0, 4).join(' ')}: stdout not JSON` }; }
  return { value: extractValue(j, r.json, now.getTime()) };
}

/** The pack name of an agent on this kind: agent.yaml `canary.pack`, else its id. */
export function packNameOf(id: string, defsRoot = join(REPO, 'graphs', 'loop-agents')): string {
  try {
    const doc = (require('yaml') as typeof import('yaml')).parse(readFileSync(join(defsRoot, id, 'agent.yaml'), 'utf8')) as { canary?: { pack?: unknown } } | null;
    const n = doc?.canary?.pack;
    return typeof n === 'string' && /^[a-z][a-z0-9-]{0,62}$/u.test(n) ? n : id;
  } catch { return id; }
}

export function createCanaryBody(env: BodyEnv, deps: CanaryDeps = liveCanaryDeps(env)): AgentBody {
  const home = agentHome(env.stateRoot, env.card.id);
  let pack: CanaryPack | null = null; let policy: CanaryPolicy | null = null;
  let st: CanaryState = readCanaryState(home); let build: BuildInfo | null = null;
  let decision: Decision = { kind: 'none', why: 'not observed' }; let readingsNow: Record<string, Reading> = {};
  const holdHint = 'eln hold add --cells RAIL --owner OP --reason "<why>"';
  const undoLine = () => (pack ? shownArgv(pack.undo) : 'eln self-update --rollback');
  const kpiNow = (now: Date) => (policy ? kpiOf(st, policy, now) : { canary_fail_to_rollback_minutes: 0, false_rollbacks: 0 });
  const save = (now: Date) => writeCanaryState(home, st, kpiNow(now));

  const observe = async (ctx: { now: Date }): Promise<Observation> => {
    const now = ctx.now; const nowIso = now.toISOString();
    pack = deps.pack(); policy = canaryPolicy(pn);
    st = readCanaryState(home);
    build = buildOf(deps.installRecord(expand(pack.build.file, deps.vars, now)), pack.build);
    if (!build) { decision = { kind: 'none', why: 'install.json unreadable' }; return { kpi: null, subjects: [], facts: [`설치 빌드 모름 — ${expand(pack.build.file, deps.vars, now)} 를 못 읽었다`] }; }
    const swap = noteBuild(st, build, now);
    const watching = inWindow(st, policy, now);
    const base = (st.prevSha ? st.readings[st.prevSha] : undefined) ?? {};
    readingsNow = {};
    const regressed: string[] = [];
    for (const p of pack.probes) {
      let r = judgeReading(p, readProbe(p, deps, now), base[p.id], nowIso);
      // a candidate regression inside the window is confirmed by re-reads (a flap that recovers within confirm_gap_sec is not one)
      for (let i = 1; watching && isRegression(r, base[p.id]) && i < policy.confirmReads; i++) {
        await deps.sleep(policy.confirmGapSec * 1000);
        r = judgeReading(p, readProbe(p, deps, now), base[p.id], nowIso);
      }
      readingsNow[p.id] = r;
      if (watching && isRegression(r, base[p.id])) regressed.push(p.id);
    }
    st.readings[st.sha!] = { ...(st.readings[st.sha!] ?? {}), ...readingsNow };
    decision = decide(st, build, regressed, readingsNow, policy, now);
    save(now);
    const k = kpiNow(now);
    const subjects: Subject[] = (decision.kind === 'none' ? [] : decision.probes)
      .map(id => ({ id, kind: decision.kind, summary: `${id}: 이전 ${base[id]?.detail ?? '?'} → 지금 ${readingsNow[id]?.detail ?? '?'}`.slice(0, 240) }));
    const unknown = pack.probes.filter(p => readingsNow[p.id]?.ok === null).map(p => p.id);
    const facts = [
      `빌드 ${st.sha}${st.prevSha ? ` (이전 ${st.prevSha})` : ''} · ${swap === 'swap' ? '방금 교체' : st.origin} · 감시 창 ${watching ? '안' : '밖'} · 판정 ${decision.kind}${decision.kind === 'none' ? ` (${decision.why})` : ''}`,
      `탐침 ${pack.probes.map(p => `${p.id} ${readingsNow[p.id]?.ok === true ? 'ok' : readingsNow[p.id]?.ok === false ? `✗ ${readingsNow[p.id]!.detail}` : '?'}`).join(' · ')}`.slice(0, 400),
      `되돌림 ${st.rollbacks.length} · 거짓 되돌림 ${k.false_rollbacks} · 마지막 실패→되돌림 ${st.lastFailToRollbackMin ?? '—'}분${unknown.length ? ` · 모름 ${unknown.join(',')}` : ''}`,
    ];
    // no outcome patterns: one decision per episode (limit · verdict) is the memory — a per-tick lesson candidate would be L0 noise
    return { kpi: k.canary_fail_to_rollback_minutes, subjects, facts };
  };

  const plan: AgentBody['plan'] = (): PlannedAction[] => {
    const d = decision;
    if (d.kind === 'rollback') return [{ action: 'rollback', target: `RAIL@${d.from}`, why: `${d.probes.join(', ')} 회귀 (교체 후 감시 창 · 이전 빌드 ${d.to} 에선 통과)` }];
    if (d.kind === 'none') return [];
    const sha = d.kind === 'false-rollback' ? d.row.from : d.sha;
    const key = `${d.kind}:${sha}`;
    return st.carded.includes(key) ? [] : [{ action: 'card', target: key, why: d.kind === 'false-rollback' ? '되돌림 뒤에도 같은 탐침 실패' : d.why }];
  };

  const run = (argv: readonly string[], now: Date): RunResult => deps.run(expandArgv(argv, deps.vars, now), policy?.stepTimeoutSec ?? 120);

  const actions: AgentBody['actions'] = {
    rollback: {
      describe: '회귀한 설치 빌드를 이전 빌드로 되돌린다 — 기존 문 `eln self-update --rollback`(current ↔ previous) ⊕ 재기동 문(els · nexus) ⊕ OP 카드(prev..new 용의자) · 빌드당 1회 · HOLD 존중 · 되돌리기 = restore-build',
      async run(target, ctx): Promise<ActionResult> {
        const d = decision; const now = ctx.now;
        if (d.kind !== 'rollback' || target !== `RAIL@${d.from}` || !pack || !policy) return { ok: false, line: `${target}: 방금 판정의 되돌림 대상이 아니다` };
        // the door toggles current ↔ previous: run it only while the regressed build is still the one installed (a second tick
        // or a person that already moved it must not flip it back)
        const before = buildOf(deps.installRecord(expand(pack.build.file, deps.vars, now)), pack.build);
        if (before?.sha !== d.from || before.previousSha !== d.to) return { ok: false, line: `${target}: 설치 빌드가 이미 바뀌었다(${before?.sha ?? '?'} · previous ${before?.previousSha ?? '?'}) — 되돌림 문을 부르지 않는다` };
        const out = run(pack.rollback, now);
        const after = buildOf(deps.installRecord(expand(pack.build.file, deps.vars, now)), pack.build);
        if (out.code !== 0 || after?.sha !== d.to) {
          const line = `되돌림 실패 — ${exitLine(out, policy.stepTimeoutSec)} · 설치 빌드 ${after?.sha ?? '?'} (원한 것 ${d.to}) · ${tail(out)}`;
          const key = `refused:${d.from}`;
          if (!st.carded.includes(key)) {
            const id = deps.post(`rail-canary:${key}`, env.card.supervisor, `[${env.card.name} → OP · 되돌림 문 실패] 빌드 ${d.from} 회귀(${d.probes.join(', ')}) — ${line}\n  손으로: eln self-update --rollback · 상태: eln loop agent ${env.card.id} status`, 'request');
            if (id !== false) { st.carded.push(key); save(now); }
          }
          return { ok: false, line };
        }
        const failed = d.probes.map(id => ({ id, base: st.readings[d.to]?.[id], now: readingsNow[id] }));
        const swapAt = st.swapAt;
        const row = noteRollback(st, d, now);
        save(now);
        const restarts = pack.restart.map(s => { const r = run(s.argv, now); return `${s.id} ${r.code === 0 ? 'ok' : `${s.optional ? '건너뜀' : '실패'}(${exitLine(r, policy!.stepTimeoutSec)})`}`; });
        const sus = deps.suspects(expand(pack.suspectsRepo, deps.vars, now), d.to, d.from);
        const body = rollbackCard({ name: env.card.name, row, swapAt, failed, restarts, suspects: sus, suspectsMax: policy.suspectsMax, undo: undoLine(), holdHint });
        const id = deps.post(`rail-canary:rollback:${d.from}`, env.card.supervisor, body, 'request');
        return { ok: true, line: `${d.from} → ${d.to} 되돌림 · 재기동 ${restarts.join(' · ')} · OP 카드 ${id === false ? '실패' : id === null ? '이미' : `#${id}`}`,
          ...(typeof id === 'number' ? { ref: `msg:${id}` } : {}), undo: `${undoLine()} (새 빌드 ${d.from} 다시 설치)`, before: `installed ${d.from}`, after: `installed ${d.to}` };
      },
    },
    card: {
      describe: '자동으로 못 하는 경우 OP 에 카드 한 장 — 같은 빌드 두 번째 회귀(한도) · 이전 빌드가 지켜본 건강한 빌드가 아님 · 되돌림 뒤에도 같은 실패(거짓 되돌림) — 되돌릴 것 없음(카드)',
      async run(target, ctx): Promise<ActionResult> {
        const d = decision;
        if (d.kind === 'none' || d.kind === 'rollback' || target !== `${d.kind}:${d.kind === 'false-rollback' ? d.row.from : d.sha}` || !policy) return { ok: false, line: `${target}: 방금 판정의 카드가 아니다` };
        const sus = d.kind === 'false-rollback' || !st.prevSha || !pack ? null : deps.suspects(expand(pack.suspectsRepo, deps.vars, ctx.now), st.prevSha, d.sha);
        const body = handoverCard({ name: env.card.name, d, readings: readingsNow, undo: undoLine(), suspects: sus, prev: d.kind === 'false-rollback' ? null : st.prevSha, suspectsMax: policy.suspectsMax });
        const id = deps.post(`rail-canary:${target}`, env.card.supervisor, body, 'request');
        if (id === false) return { ok: false, line: `${env.card.supervisor} 우편 실패` };
        st.carded.push(target); save(ctx.now);
        return { ok: true, line: `${env.card.supervisor} 카드 ${id === null ? '이미 있음' : `#${id}`}`, ...(typeof id === 'number' ? { ref: `msg:${id}` } : {}), undo: '없음 — 카드 한 장' };
      },
    },
    'restore-build': {
      describe: '되돌림 취소 — 되돌리기 전 새 빌드를 다시 설치한다(같은 문: current ↔ previous). 사람·L0 가 부탁할 때만 · 계획은 고르지 않는다',
      async run(_target, ctx): Promise<ActionResult> {
        if (!pack) pack = deps.pack();
        const last = st.rollbacks[st.rollbacks.length - 1];
        if (!last || st.sha !== last.to) return { ok: false, line: '지금 설치본이 마지막 되돌림의 결과가 아니다 — 취소할 되돌림 없음' };
        const out = run(pack.undo, ctx.now);
        const after = buildOf(deps.installRecord(expand(pack.build.file, deps.vars, ctx.now)), pack.build);
        if (out.code !== 0 || after?.sha !== last.from) return { ok: false, line: `다시 설치 실패 — ${tail(out)} · 설치 빌드 ${after?.sha ?? '?'}` };
        return { ok: true, line: `${last.to} → ${last.from} 다시 설치 (되돌림 취소 · 같은 빌드 자동 되돌림은 한도로 막힘)`, undo: shownArgv(pack.rollback) };
      },
    },
  };
  return { observe, plan, actions };
}

// ── live doors (the existing ones) ──────────────────────────────────────────────────────────────────────────────────
export function liveCanaryDeps(env: BodyEnv): CanaryDeps {
  const { defaultInstallRoot } = require('../../cli/self-update.js') as typeof import('../../cli/self-update.js');
  const { defaultHqRoot } = require('../../op-world/op-world.js') as typeof import('../../op-world/op-world.js');
  const vars: TemplateVars = {
    stateRoot: env.stateRoot, installRoot: defaultInstallRoot(), hqRepo: join(defaultHqRoot(), 'repo.git'),
    uid: String(typeof process.getuid === 'function' ? process.getuid() : 501),
    // this build's own CLI (the package the trigger runs): `{eln}` in an argv
    eln: [process.execPath, join(REPO, 'bin', 'elanous.mjs')],
  };
  const run = (argv: readonly string[], timeoutSec: number): RunResult => {
    const [cmd, ...args] = argv;
    const out = spawnSync(cmd!, args, { encoding: 'utf8', timeout: timeoutSec * 1000, env: { ...process.env, NO_COLOR: '1' } });
    return { code: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? (out.error ? String(out.error.message) : ''), timedOut: (out.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' };
  };
  return {
    pack() {
      const name = packNameOf(env.card.id);
      const p = join(REPO, 'graphs', 'policies', `${name}.yaml`);
      const r = parseCanaryPack(readFileSync(p, 'utf8'));
      if (!r.pack) throw new Error(`probe pack ${name} refused: ${r.errors.slice(0, 3).join(' · ')}`);
      return r.pack;
    },
    installRecord(path) { try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch { return null; } },
    run,
    readFile(path) { try { return existsSync(path) ? { text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs } : null; } catch { return null; } },
    sensor(name, args, now) {
      if (name !== 'gh-graphql-used-pct') throw new Error(`unknown sensor ${name}`);
      const gov = require('../../kit/gh-governor/index.js') as typeof import('../../kit/gh-governor/index.js');
      const policy = gov.liveGhGovernorPolicy(); if (!policy) return null;
      const seat = (args.seat ?? 'OP').toUpperCase();
      const used = gov.graphqlUsedLastHour({ stateRoot: env.stateRoot, now: () => now.getTime() }, seat);
      const budget = gov.seatBudget(policy, seat);
      return budget > 0 ? Math.round((used / budget) * 100) : null;
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    suspects(repo, from, to) {
      if (!existsSync(repo)) return null;
      run(['git', '-C', repo, 'fetch', '-q', 'origin', 'main'], 60); // Source: one fetch so both builds' commits are known (rail-watch does the same).
      const out = run(['git', '-C', repo, 'log', '--first-parent', '--format=%H%x09%s', `${from}..${to}`], 30);
      if (out.code !== 0) return null;
      return (require('../../land-graph/rail-watch.js') as typeof import('../../land-graph/rail-watch.js')).parseSuspects(out.stdout);
    },
    post: (key, to, body, kind) => (require('../live.js') as typeof import('../live.js')).livePostResult(env.stateRoot, env.card, env.card.id)(key, to, body, kind),
    vars,
  };
}
