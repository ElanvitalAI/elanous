// kit/kpi rollup — a READ of other loop agents' own KPI (LOOP-AGENTS-AS-PLUGINS P1 · 대표 11-28 15:3x «감독자들이 다 도는지 ·
// 기존 것 통합 및 플러그인화»).
//
// S: «감독의 감독» had four copies — watchers-check restart · the guardian 맥박 supervisor-dead · the 순찰대/우체국 peer-silent
//    and the `peer-watch` executor kind (#40639) — each re-deciding «this peer stopped → wake it once → card its owner».
// C: that decision already has ONE owner: the trigger registry (src/loops/trigger-registry.ts) fires every registered agent,
//    checks its goal file by the goal deadline, retries with backoff and posts ONE exception card to the trigger's owner.
//    A second waker only races it (two wakes, two cards) and cannot help when the registry tick itself is down (it is
//    fired by that same tick) — that case is the outside clock's (src/loops/trigger-clock.ts).
// A: what stays of peer-watch is this pure read: the peers' own tick files ⊕ the registry rows → one KPI line naming who
//    owns each breach now (the peer acting · the peer's own L0 card · the registry's exception card). No wake, no ledger,
//    no card. An instance is YAML (a guardian sub's `kpi_rollup:`); every reader fails open into «?» (never a false 0).
//
// 세 얼굴: 관측 = peer tick files (last-tick.json · a declared state file) ⊕ case ledgers ⊕ registry rows / 판단 근거 = the
//          instance YAML (targets · probes · silent_min · stale_min) / 수복과 인계 = none here — the peer's own ladder and the registry's
//          exception card own every breach; this line says which of them has it.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { readCases, unresolvedCases } from '../case-ledger/index.js';

export interface RollupTarget { readonly id: string; readonly trigger: string; readonly label: string | null; readonly show: 'count' | 'verdict' | 'none'; readonly tick: string | null }
export type RollupProbe =
  | { readonly kind: 'cases'; readonly domain: string; readonly label: string }
  | { readonly kind: 'plan-targets'; readonly of: string; readonly action: string; readonly label: string }
  | { readonly kind: 'install-fresh'; readonly target: string; readonly label: string };
export interface RollupSpec {
  readonly targets: readonly RollupTarget[]; readonly probes: readonly RollupProbe[];
  /** a peer whose own last tick is older than this (or errored) counts as «응답 없는 서브» — read only: the registry refires it */
  readonly silentMin: number;
  /** an install the rail watcher has not smoked for this long counts as a miss (the watcher's own trigger wakes it) */
  readonly staleMin: number;
}

/** Parse one `kpi_rollup:` block (numbers resolved by the caller's `$policies` resolver). Errors are returned, never thrown. */
export function parseKpiRollup(raw: unknown, num: (v: unknown, at: string) => number | null, at: string): { spec: RollupSpec | null; errors: string[] } {
  const errors: string[] = [];
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!o) return { spec: null, errors: [`${at} must be a mapping`] };
  const ID = /^[a-z][a-z0-9-]{0,62}$/u;
  const targets: RollupTarget[] = (Array.isArray(o.targets) ? o.targets : []).flatMap((t: unknown, i: number): RollupTarget[] => {
    const r = t && typeof t === 'object' ? t as Record<string, unknown> : {};
    const id = typeof r.id === 'string' ? r.id : ''; const trigger = typeof r.trigger === 'string' ? r.trigger : '';
    if (!ID.test(id) || !ID.test(trigger)) { errors.push(`${at}.targets[${i}] needs id and trigger`); return []; }
    const show = r.show === undefined ? 'count' : r.show;
    if (show !== 'count' && show !== 'verdict' && show !== 'none') { errors.push(`${at}.targets[${i}].show must be count | verdict | none`); return []; }
    const tick = typeof r.tick === 'string' ? r.tick : null;
    if (tick && (tick.startsWith('/') || tick.split('/').includes('..'))) { errors.push(`${at}.targets[${i}].tick must be a state-root relative path`); return []; }
    return [{ id, trigger, label: typeof r.label === 'string' ? r.label : null, show: show as RollupTarget['show'], tick }];
  });
  if (!targets.length) errors.push(`${at}.targets needs at least one peer`);
  const ids = new Set(targets.map(t => t.id));
  const probes: RollupProbe[] = (Array.isArray(o.probes) ? o.probes : []).flatMap((p: unknown, i: number): RollupProbe[] => {
    const r = p && typeof p === 'object' ? p as Record<string, unknown> : {};
    const label = typeof r.label === 'string' ? r.label : '';
    const ref = (k: string) => { const v = typeof r[k] === 'string' ? r[k] as string : ''; if (!ids.has(v)) errors.push(`${at}.probes[${i}].${k} ${v || '—'} is not a target`); return v; };
    if (!label) { errors.push(`${at}.probes[${i}].label is required`); return []; }
    if (r.route !== undefined) errors.push(`${at}.probes[${i}].route is gone — the peer's own trigger routes its cases`);
    if (r.kind === 'cases' && typeof r.domain === 'string') return [{ kind: 'cases', domain: r.domain, label }];
    if (r.kind === 'plan-targets' && typeof r.action === 'string') return [{ kind: 'plan-targets', of: ref('of'), action: r.action, label }];
    if (r.kind === 'install-fresh') return [{ kind: 'install-fresh', target: ref('target'), label }];
    errors.push(`${at}.probes[${i}].kind must be cases {domain} | plan-targets {of · action} | install-fresh {target}`); return [];
  });
  const silentMin = num(o.silent_min, `${at}.silent_min`); const staleMin = num(o.stale_min, `${at}.stale_min`);
  if (silentMin === null) errors.push(`${at}.silent_min ($policies.<name>) is required`);
  if (staleMin === null) errors.push(`${at}.stale_min ($policies.<name>) is required`);
  return errors.length ? { spec: null, errors } : { spec: { targets, probes, silentMin: silentMin!, staleMin: staleMin! }, errors };
}

// ── reading a peer ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface PeerTick {
  readonly at: string; readonly kpi: number | null; readonly kpiOk: boolean | null; readonly kpiLine: string;
  readonly acted: readonly string[]; readonly refused: readonly string[]; readonly error?: string;
  readonly plan?: { readonly lines?: ReadonlyArray<{ readonly action: string; readonly target: string }> };
  readonly sha?: string | null; readonly smoke?: Record<string, boolean>; readonly carded?: readonly string[];
}
/** A registry row as the guardian world sees it (kind supervisor · id = trigger graph id · status ok|dead|broken|bad). */
export interface PeerRow { readonly kind: string; readonly id: string; readonly owner: string | null; readonly status: string }
export interface PeerView {
  readonly target: RollupTarget; readonly registered: boolean; readonly triggerStatus: string | null; readonly owner: string | null;
  readonly tick: PeerTick | null; readonly ageMin: number | null; readonly escalatedRef: string | null;
}
// 출처: one minute in ms (a time unit, not a tuning bound)
const MIN = 60_000;
const readJson = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; } };

/** The last `kind: escalate` row at/after `since` in a peer's memory cases (tail only — the file grows forever). */
function peerEscalation(stateRoot: string, id: string, since: string | null): string | null {
  if (!since) return null;
  const p = join(stateRoot, 'loop-agents', id, 'cases.jsonl');
  if (!existsSync(p)) return null;
  let text = '';
  try {
    const fd = openSync(p, 'r');
    try { const size = fstatSync(fd).size; const n = Math.min(size, 256 * 1024); const buf = Buffer.alloc(n); readSync(fd, buf, 0, n, size - n); text = buf.toString('utf8'); }
    finally { closeSync(fd); }
  } catch { return null; }
  const sinceMs = Date.parse(since); let ref: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"escalate"')) continue;
    try { const r = JSON.parse(line) as { at?: string; kind?: string; refs?: string[] }; if (r.kind === 'escalate' && r.at && Date.parse(r.at) >= sinceMs) ref = r.refs?.[0] ?? 'escalated'; }
    catch { /* a torn first line of the tail window */ }
  }
  return ref;
}

export function readPeer(stateRoot: string, t: RollupTarget, rows: readonly PeerRow[], now: Date): PeerView {
  const row = rows.find(e => e.kind === 'supervisor' && e.id === t.trigger) ?? null;
  const raw = readJson<Partial<PeerTick> & { at?: string }>(join(stateRoot, t.tick ?? join('loop-agents', t.id, 'last-tick.json')));
  const at = typeof raw?.at === 'string' && Number.isFinite(Date.parse(raw.at)) ? raw.at : null;
  const tick: PeerTick | null = raw && at ? { at, kpi: typeof raw.kpi === 'number' ? raw.kpi : null, kpiOk: typeof raw.kpiOk === 'boolean' ? raw.kpiOk : null,
    kpiLine: typeof raw.kpiLine === 'string' ? raw.kpiLine : '', acted: raw.acted ?? [], refused: raw.refused ?? [], ...(raw.error ? { error: raw.error } : {}),
    ...(raw.plan ? { plan: raw.plan } : {}), ...(raw.sha !== undefined ? { sha: raw.sha } : {}), ...(raw.smoke ? { smoke: raw.smoke } : {}), ...(raw.carded ? { carded: raw.carded } : {}) } : null;
  const st = readJson<{ breachSince?: string | null }>(join(stateRoot, 'loop-agents', t.id, 'state.json'));
  const breachSince = typeof st?.breachSince === 'string' ? st.breachSince : null;
  return { target: t, registered: !!row, triggerStatus: row?.status ?? null, owner: row?.owner ?? null, tick,
    ageMin: at ? (now.getTime() - Date.parse(at)) / MIN : null, escalatedRef: tick?.kpiOk === false ? peerEscalation(stateRoot, t.id, breachSince) : null };
}

function owning(v: PeerView): string {
  const id = v.target.id;
  if (!v.tick) return '틱 없음';
  if (v.tick.kpiOk !== false) return '충족';
  if (v.escalatedRef) return `${id} 가 L0 에 올림 ${v.escalatedRef}`;
  if (v.tick.acted.length) return `${id} 사다리 진행(${v.tick.acted.slice(0, 2).join(' · ')})`;
  if (v.tick.refused.length) return `${id} 행동 거절 ${v.tick.refused.length} · L0 올림 대기`;
  return `${id} 올림 대기`;
}

export interface RollupPorts { readonly stateRoot: string; readonly now: Date; readonly rows: readonly PeerRow[]; installedSha(): string | null }
export interface RollupKpi { readonly value: string; readonly ok: boolean | null }

/** One read: the peers' own KPI → one line · ok = every peer and probe fine · null = something unreadable. */
export function runKpiRollup(spec: RollupSpec, p: RollupPorts): RollupKpi {
  const views = spec.targets.map(t => readPeer(p.stateRoot, t, p.rows, p.now));
  const view = (id: string) => views.find(v => v.target.id === id)!;
  const parts: string[] = []; let bad = false; let known = true;
  for (const v of views) {
    if (v.target.show === 'none') continue;
    const label = v.target.label ?? v.target.id;
    if (v.target.show === 'count') {
      const n = v.tick?.kpi ?? null; if (n === null) known = false; if ((n ?? 0) > 0) bad = true;
      parts.push(`${label} ${n ?? '?'}${n ? ` (${owning(v)})` : ''}`);
    } else {
      if (v.tick?.kpiOk === false) bad = true;
      parts.push(`${label} ${v.tick ? (v.tick.kpiOk === false ? `위반 (${owning(v)})` : v.tick.kpiLine.split(' (')[0] || '충족') : '?'}`);
    }
  }
  for (const pr of spec.probes) {
    if (pr.kind === 'cases') {
      let n: number | null = null; try { n = unresolvedCases(readCases(p.stateRoot, pr.domain)).length; } catch { n = null; }
      if (n === null) known = false; if ((n ?? 0) > 0) bad = true;
      parts.push(`${pr.label} ${n ?? '?'}`);
    } else if (pr.kind === 'plan-targets') {
      const v = view(pr.of);
      const list = [...new Set((v.tick?.plan?.lines ?? []).filter(l => l.action === pr.action).map(l => l.target))].sort();
      if (list.length) bad = true;
      parts.push(`${pr.label} ${v.tick ? list.length : '?'}${list.length ? ` (${list.slice(0, 4).join(',')}${list.length > 4 ? ` 외 ${list.length - 4}` : ''})` : ''}`);
    } else {
      const v = view(pr.target);
      let installed: string | null = null; try { installed = p.installedSha(); } catch { installed = null; }
      const checked = typeof v.tick?.sha === 'string' ? v.tick.sha : null;
      const unchecked = !!installed && checked !== installed;
      const failing = Object.entries(v.tick?.smoke ?? {}).filter(([, ok]) => ok === false).map(([k]) => k).sort();
      const carded = !!checked && (v.tick?.carded ?? []).some(k => typeof k === 'string' && k.startsWith(`${checked.slice(0, 12)}:`));
      const regressed = !unchecked && failing.length > 0 && carded;
      // a known break is not a regression (the peer cards only pass → fail) · an unchecked install inside stale_min is fine
      if (regressed || (unchecked && (v.ageMin ?? Infinity) >= spec.staleMin)) bad = true;
      if (!installed) known = false;
      parts.push(!installed ? `${pr.label} ?` : unchecked ? `${pr.label} ${installed.slice(0, 8)} 스모크 전` : failing.length
        ? `${pr.label} ${installed.slice(0, 8)} 스모크 실패 ${failing.join(',')}${regressed ? ` (회귀 · ${pr.target} 카드 보냄)` : ' (알려진 고장 · 직전 레일부터)'}` : `${pr.label} ${installed.slice(0, 8)} 스모크 통과`);
    }
  }
  // a registered peer not running its ladder (own tick older than silent_min · errored · registry row dead/broken) — read only:
  // the trigger registry refires it every window and cards its owner when the goal is missed (no second wake from here)
  const registered = views.filter(v => v.registered);
  const down = registered.filter(v => v.ageMin === null || v.ageMin > spec.silentMin || !!v.tick?.error || v.triggerStatus === 'dead' || v.triggerStatus === 'broken').map(v => v.target.id);
  if (down.length) bad = true;
  parts.push(`응답 없는 서브 ${down.length}/${registered.length}${down.length ? ` (${down.join(',')} · 레지스트리 몫)` : ''}`);
  return { value: parts.join(' · '), ok: bad ? false : known ? true : null };
}
