// KIT mail-route · policy — ONE window/cadence policy for every seat-turn mail fold (CEO 11-27 «중복된 내용들 정리»).
//
// S: five fold paths each ran their own 30-min window from a private constant (bus wake · coach note · folded digest ·
//    OP machine digest · TUI/repl digest), so changing «half an hour» meant five edits and the paths drifted apart.
// A: the window comes from ONE policy: code defaults ⊕ the optional policy file `<state>/msg/mail-route-policy.json`
//    `{ "windowMinutes": 30, "foldedWindowMinutes": 10 }`. P0 is never windowed (see {@link mailBypassesWindow}).
//
// 세 얼굴: 관측 = {@link readMailRoutePolicy} returns the values in force (callers log them with their fold event) ·
// 판단 근거 = the policy file (absent / invalid field = the code default) · 수복과 인계 = delete the file to go back to defaults.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';

export interface MailRoutePolicy {
  /** The digest window every seat-turn fold shares (bus wake · coach note · OP machine digest). */
  readonly windowMs: number;
  /** The saturated-receiver fold window (MAIL-ANTI-FLOOD G) — shorter: the receiver asked for less, not for later. */
  readonly foldedWindowMs: number;
}

export const MAIL_ROUTE_POLICY_DEFAULTS: MailRoutePolicy = { windowMs: 30 * 60_000, foldedWindowMs: 10 * 60_000 };

/** Parse a policy object — any missing or invalid field keeps the code default. Pure. */
export function mailRoutePolicyFrom(raw: unknown): MailRoutePolicy {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const minutes = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 24 * 60 ? v * 60_000 : d);
  return {
    windowMs: minutes(o.windowMinutes, MAIL_ROUTE_POLICY_DEFAULTS.windowMs),
    foldedWindowMs: minutes(o.foldedWindowMinutes, MAIL_ROUTE_POLICY_DEFAULTS.foldedWindowMs),
  };
}

export function mailRoutePolicyFile(root: string = join(elanousStateRoot(), 'msg')): string {
  return join(root, 'mail-route-policy.json');
}

const cache = new Map<string, { mtimeMs: number; policy: MailRoutePolicy }>();

/** The policy in force (re-read only when the file changes). Fail-open to the defaults. */
export function readMailRoutePolicy(file: string = mailRoutePolicyFile()): MailRoutePolicy {
  let mtimeMs: number;
  try { mtimeMs = statSync(file).mtimeMs; } catch { cache.delete(file); return MAIL_ROUTE_POLICY_DEFAULTS; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.policy;
  let policy = MAIL_ROUTE_POLICY_DEFAULTS;
  try { policy = mailRoutePolicyFrom(JSON.parse(readFileSync(file, 'utf8'))); } catch { /* invalid JSON = defaults */ }
  cache.set(file, { mtimeMs, policy });
  return policy;
}

/** Fields a P0 judgement reads (a mail row or a candidate). */
export interface P0Probe {
  readonly priority?: number | null;
  readonly crownDirective?: string | null;
  readonly goal?: string | null;
  readonly body?: string | null;
  readonly refs?: readonly string[] | null;
}

/** P0 never waits for a window: a crown relay · a goal · priority ≥ 1 · a 🚨 body · a `prio:P0` / `urgent` ref. Pure. */
export function mailBypassesWindow(m: P0Probe): boolean {
  if (typeof m.crownDirective === 'string' && m.crownDirective.trim()) return true;
  if (typeof m.goal === 'string' && m.goal.trim()) return true;
  if ((m.priority ?? 0) >= 1) return true;
  if ((m.body ?? '').trimStart().replace(/^\[rerouted from [^\]]*\]\s*/u, '').startsWith('🚨')) return true;
  return (m.refs ?? []).some((r) => { const u = r.trim().toUpperCase(); return u === 'PRIO:P0' || u === 'URGENT'; });
}

/** Has the window since `lastAtMs` passed? (null = never folded → due now). Pure. */
export function windowDue(lastAtMs: number | null, nowMs: number, windowMs: number): boolean {
  return lastAtMs === null || nowMs - lastAtMs >= windowMs;
}
