// 🧭 세션 시작 결정 — «인자 없음 = 깨끗한 새 세션», 이어하기는 명시 인자일 때만 (TUI-H8-SESSION-NEW-DEFAULT · 대표 10-16 #73).
//
// S: `elanous chat` · `agent` · `repl` 은 인자 없이 뜨면 «활성 세션»(~/.local/state/elanous/active)을 조용히 이어받았다.
//    그래서 앞 프로세스가 도구 호출 도중 죽은 기록(호출·결과 짝이 깨진 꼬리)까지 이어받아 첫 턴이 400 으로 죽었다(#69).
// C: 다른 에이전트(codex·claude·grok)는 인자 없음 = 새 세션 · 이어하기 = `--resume`/`--continue` 다.
// A: 시작 결정을 이 함수 하나로 모으고, 결정마다 `session`/`start` 한 줄을 남긴다(관측).
//    ⛔ 자리 맥락은 세션이 아니라 자리 문서(AGENTS.local.md · `.AGENTS.local.last-session.md` · 부트 카드)가 매 턴 싣는다 —
//       새 세션이어도 맥락은 그대로다(`turn-preamble.ts` · `universal-preamble.ts`).

import { debug } from '../debug/log.js';

export type SessionStartOrigin = 'new' | 'resume';
export type SessionStartReason =
  | 'default-new'
  | 'force-new'
  | 'explicit-session'
  | 'continue-active'
  | 'continue-latest'
  | 'continue-no-active';

export interface SessionStartDecision {
  origin: SessionStartOrigin;
  reason: SessionStartReason;
  /** 이어받을 세션 id(명시 id 는 호출부가 이미 풀어서 넘긴다). 새 세션이면 undefined. */
  sessionIdHint?: string;
}

/** 단일 결정 — 명시 id > `--new` > `--continue`/`--resume`(활성 세션 ⊕ 표지가 낡았으면 최신 세션) > 기본 새 세션.
 *  `sessionExists`·`latestSessionId` 를 주면 활성 표지가 «사라진 세션»을 가리킬 때 최신 세션으로 넘어간다
 *  (TUI-H8-FOLLOW ① · #28509 리뷰 should-fix). 안 주면 옛 동작(표지를 그대로 믿는다). */
export function decideSessionStart(input: {
  explicitSessionId?: string;
  continueActive: boolean;
  forceNew: boolean;
  activeSessionId: () => string | null;
  sessionExists?: (id: string) => boolean;
  latestSessionId?: () => string | null;
}): SessionStartDecision {
  if (input.explicitSessionId) {
    return { origin: 'resume', reason: 'explicit-session', sessionIdHint: input.explicitSessionId };
  }
  if (input.forceNew) return { origin: 'new', reason: 'force-new' };
  if (input.continueActive) {
    const picked = pickContinueSession(input);
    if (!picked) return { origin: 'new', reason: 'continue-no-active' };
    return {
      origin: 'resume',
      reason: picked.from === 'active' ? 'continue-active' : 'continue-latest',
      sessionIdHint: picked.id,
    };
  }
  return { origin: 'new', reason: 'default-new' };
}

/** 존재 확인 — 확인 자체가 실패하면 «있다»고 보지 않는다(이어받을 수 없는 세션을 고르지 않는다). */
function sessionAlive(exists: ((id: string) => boolean) | undefined, id: string): boolean {
  if (!exists) return true;
  try { return exists(id); } catch { return false; }
}

/** «이어하기» 대상 — 활성 표지 ⊕ (표지가 없거나 사라진 세션이면) 최신 세션. 낡은 표지는 `session`/`active-marker-stale` 로 남긴다. */
function pickContinueSession(deps: {
  activeSessionId: () => string | null;
  sessionExists?: (id: string) => boolean;
  latestSessionId?: () => string | null;
}): { id: string; from: 'active' | 'latest' } | null {
  let active: string | null = null;
  try { active = deps.activeSessionId(); } catch { /* 활성 표지 읽기 실패 — 최신 세션으로 넘어간다 */ }
  if (active && sessionAlive(deps.sessionExists, active)) return { id: active, from: 'active' };
  const picked = pickLatest(deps, active);
  if (active) {
    // 관측은 «실제로 고른 결과»로 남긴다(r1 should-fix — 최신이 없어 새 세션이면 fallback:'none').
    try {
      debug.log('session', 'active-marker-stale', { activeSessionId: active, fallback: picked ? 'latest' : 'none' });
    } catch { /* 관측 실패가 시작을 막지 않는다 */ }
  }
  return picked;
}

function pickLatest(deps: {
  sessionExists?: (id: string) => boolean;
  latestSessionId?: () => string | null;
}, staleActive: string | null): { id: string; from: 'latest' } | null {
  if (!deps.latestSessionId) return null;
  let latest: string | null = null;
  try { latest = deps.latestSessionId(); } catch { return null; }
  if (!latest || latest === staleActive || !sessionAlive(deps.sessionExists, latest)) return null;
  return { id: latest, from: 'latest' };
}

/** `elanous --resume`/`--continue` 처럼 id 없이 «이어하기»만 받은 표면이 이어받을 세션 — 활성 표지 ⊕ 없거나 사라졌으면 최신. */
export function resolveLatestSessionId(deps: {
  activeSessionId: () => string | null;
  latestSessionId: () => string | null;
  sessionExists?: (id: string) => boolean;
}): string | null {
  return pickContinueSession(deps)?.id ?? null;
}

/** 세션 id 꼴인가 — 세션 id 는 uuid v4(`randomUUID` · 8-4-4-4-12 hex)이고 «고유 접두»도 받는다.
 *  uuid 의 «접두»(하이픈은 9·14·19·24번째 자리에만) 4~36자 ⊕ 숫자 하나 이상(«face»·«deadbeef» 같은 낱말을 id 로 먹지 않게).
 *  숫자 없는 hex 접두를 id 로 쓰려면 `--session <id>` 를 쓴다. */
export function looksLikeSessionId(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.length < 4 || v.length > 36 || !/[0-9]/.test(v)) return false;
  for (let i = 0; i < v.length; i += 1) {
    const c = v[i]!;
    const hyphenSlot = i === 8 || i === 13 || i === 18 || i === 23;
    if (hyphenSlot ? c !== '-' : !/[0-9a-f]/.test(c)) return false;
  }
  return true;
}

/** `--resume [id]` 뒤 위치 인자 — Commander 는 값 선택형 옵션 뒤 첫 낱말을 값으로 먹는다.
 *  그 값이 세션 id 꼴이 아니면 «id 없는 --resume ⊕ 프롬프트 낱말»로 되돌린다(TUI-H8-FOLLOW ②).
 *  `argv` 를 주면 되돌린 낱말을 입력 «순서 그대로» 끼운다(`chat hello --resume world` → `hello world`);
 *  안 주면 맨 앞에 놓는다. */
export function splitResumeArgument(
  resume: string | boolean | undefined,
  parts: readonly string[],
  surface: 'chat' | 'agent',
  argv?: readonly string[],
): { resume: string | boolean | undefined; parts: string[] } {
  if (typeof resume !== 'string' || looksLikeSessionId(resume)) return { resume, parts: [...parts] };
  const at = argv ? resumeInsertIndex(argv, parts, resume, surface) : 0;
  try {
    debug.log('session', 'resume-value-as-prompt', { surface, words: resume.split(/\s+/).filter(Boolean).length, at });
  } catch { /* 관측 실패가 시작을 막지 않는다 */ }
  return { resume: true, parts: [...parts.slice(0, at), resume, ...parts.slice(at)] };
}

/** chat·agent argv 를 «한 번» 토큰화한 결과 — 위치 인자(순서대로) ⊕ `--resume` 값이 몇 번째 위치 인자 «앞»에 왔나.
 *  (r3 TF 결정: 한 지점 땜질 대신 토큰화로 일반화 — 리뷰 진동을 끊는다.)
 *  규칙(Commander 와 같은 읽기):
 *   - 명령 낱말(`chat`/`agent`) «뒤»부터 본다(앞은 루트 옵션).
 *   - `--` 뒤는 전부 위치 인자.
 *   - `--resume=X` → X 가 resume 값. `--resume X` → X 가 `-` 로 시작하지 않으면 resume 값(값 선택형).
 *   - 값을 받는 옵션(`--session`)은 `--session X`·`--session=X` 모두 값을 건너뛴다.
 *   - 그 밖의 `-` 로 시작하는 토큰은 값 없는 플래그(`--continue` 등 · `--continue=X` 는 Commander 가 거부한다).
 *   - 나머지는 위치 인자. */
export function tokenizeResumeArgv(
  argv: readonly string[],
  surface: 'chat' | 'agent',
): { positionals: string[]; resumeValue: string | null; resumeValueAt: number | null } {
  const VALUE_OPTIONS = new Set(['--session']);
  const positionals: string[] = [];
  let resumeValue: string | null = null;
  let resumeValueAt: number | null = null;
  let afterDoubleDash = false;
  for (let i = argv.indexOf(surface) + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (afterDoubleDash) { positionals.push(token); continue; }
    if (token === '--') { afterDoubleDash = true; continue; }
    if (token.startsWith('--resume=')) {
      resumeValue = token.slice('--resume='.length);
      resumeValueAt = positionals.length;
      continue;
    }
    if (token === '--resume') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        resumeValue = next;
        resumeValueAt = positionals.length;
        i += 1;
      }
      continue;
    }
    const eq = token.indexOf('=');
    if (token.startsWith('--') && VALUE_OPTIONS.has(eq >= 0 ? token.slice(0, eq) : token)) {
      if (eq < 0) i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    positionals.push(token);
  }
  return { positionals, resumeValue, resumeValueAt };
}

/** 되돌린 낱말을 끼울 자리 — 토큰화 결과가 Commander 가 준 값·위치 인자와 «다르면» 맨 앞(옛 동작)으로 접고 남긴다. */
function resumeInsertIndex(argv: readonly string[], parts: readonly string[], resume: string, surface: 'chat' | 'agent'): number {
  const t = tokenizeResumeArgv(argv, surface);
  const agrees = t.resumeValue === resume
    && t.resumeValueAt !== null
    && t.positionals.length === parts.length
    && t.positionals.every((p, i) => p === parts[i]);
  if (agrees) return t.resumeValueAt!;
  try { debug.log('session', 'resume-argv-mismatch', { surface, positionals: t.positionals.length, parts: parts.length }); } catch { /* best-effort */ }
  return 0;
}

/** 대시보드 TUI 루트 이어하기 — 우선순위 `--resume <id>` > `--continue`·id 없는 `--resume`(최신 세션) >
 *  (폐기 예정) `ELANOUS_RESUME_SESSION`. ⛔ 명시 인자가 있으면 환경변수가 이기지 않는다. 아무것도 없으면 새 세션. */
export function resolveRootResumeSessionId(input: {
  flagId?: string;
  continueLatest: boolean;
  /** 폐기 예정 env 읽기 — 명시 인자가 하나도 없을 때만 «부른다»(읽기 자체가 폐기 경고를 낸다 · r2 must-fix). */
  readEnvId: () => string | null | undefined;
  latest: () => string | null;
}): { sessionId?: string; source: 'flag' | 'continue' | 'continue-none' | 'env' | 'none' } {
  const flagId = (input.flagId ?? '').trim();
  if (flagId) return { sessionId: flagId, source: 'flag' };
  if (input.continueLatest) {
    const latest = input.latest();
    return latest ? { sessionId: latest, source: 'continue' } : { source: 'continue-none' };
  }
  const envId = (input.readEnvId() ?? '').trim();
  if (envId) return { sessionId: envId, source: 'env' };
  return { source: 'none' };
}

/** 관측 — 세션이 «어떻게» 시작됐나. 실패해도 시작을 막지 않는다. */
export function observeSessionStart(data: {
  surface: 'chat' | 'agent' | 'repl' | 'tui' | 'ask';
  origin: SessionStartOrigin;
  reason: string;
  sessionId?: string | null;
  [key: string]: unknown;
}): void {
  try {
    debug.log('session', 'start', data);
  } catch {
    // Observation must never block a session start.
  }
}
