// 🪪 L2-lite — TUI 가 자기 자리 로컬 지시(`AGENTS.local.md`)를 «만들고 이어 쓴다» (TUI-SEAT-CONTINUITY · 2026-10-14).
//
// S: 자리(`~/elanous-hq/seats/<자리>`)에서 TUI 를 다시 띄우면 지난 세션에 무엇을 하다 나갔는지 모른다.
//    TUI 는 파일 기억(`buildMemoryInjection`)을 받지 않고 턴·세션 끝 기억 쓰기도 없다 — 연속성 장치가 0 이다.
// A: 둘을 한다.
//    ① 생성 — 자리 디렉터리에서 뜰 때 로컬 지시 파일이 «하나도» 없으면 템플릿으로 `AGENTS.local.md` 를 만든다.
//       재료: seat-state/<자리>/README.md 머리 ⊕ 자리 이름 ⊕ 저장소 AGENTS.md §제1원칙 요지(출처 줄) ⊕ «## 시작하면» 기본 절차.
//       ⛔ 사람이 쓴 파일은 절대 덮어쓰지 않는다 — `AGENTS.local.md` 든 `CLAUDE.local.md` 든 있으면 생성 0
//       (`CLAUDE.local.md` 만 있는데 `AGENTS.local.md` 를 만들면 앵커 로더가 사람 파일을 shadowed 로 가린다).
//    ② 이어쓰기 — «지난 세션»은 TUI 가 «통째로 소유하는» 별도 파일(자리 루트 `.AGENTS.local.last-session.md` · git 제외)에
//       대화가 끝날 때(`/quit`·Ctrl+C·SIGINT/SIGTERM = process 'exit' · `/session new`·`clear`) 5줄 이내로 쓴다(tmp ⊕ rename).
//       ⛔ 사람 지시 파일은 «고치지 않는다» — 사람 파일 안의 블록을 갈아 쓰면 잠금 없이는 경쟁 창을 0 으로 못 만든다(#27505 r1~r4).
//       재료는 대화 기록(마지막 요청·마지막 답 요지·열린 일 후보·다음 점검 시각 후보) — LLM 호출 없이 동기로(종료 경로).
//       실패해도 종료를 막지 않는다.
//    ③ 다음 기동 때 L0 앵커 로더(`universal-preamble.ts`)가 그 파일을 층 ④(로컬 지시) 뒤 조각으로 싣는다.
// 관측: `tui.local-instructions` created / create-skipped / last-session-written / last-session-skipped.
// ⛔ 생성은 cwd 가 `/seats/<자리>` 일 때만 — `COORD_ID` 만으로는 아무 저장소 디렉터리에 파일을 만들지 않는다.

import { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';

export const LOCAL_INSTRUCTIONS_FILE = 'AGENTS.local.md';
const COMPAT_LOCAL_FILE = 'CLAUDE.local.md';
/** TUI 가 통째로 소유하는 «지난 세션» 파일 — 자리 루트에 둔다. L0 앵커 로더가 같은 이름을 읽는다. */
export const LAST_SESSION_FILE = '.AGENTS.local.last-session.md';
const SEAT_DIR_IN_PATH = /^(.*?\/seats\/([A-Za-z][A-Za-z0-9_-]{0,63}))(?:\/|$)/;
const README_HEAD_MAX = 1200;
const PRINCIPLE_MAX = 1500;
const MAX_LAST_SESSION_LINES = 5;
const LINE_MAX = 200;

/** cwd 가 `/seats/<자리>` 아래면 자리 루트 디렉터리와 자리 이름. */
export function seatDirFromCwd(cwd: string): { seat: string; dir: string } | null {
  const m = SEAT_DIR_IN_PATH.exec(cwd);
  if (!m) return null;
  return { seat: m[2]!.toUpperCase(), dir: m[1]! };
}

function readHead(path: string, maxChars: number): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    const raw = readFileSync(path, 'utf8');
    if (raw.length <= maxChars) return raw.trim();
    const cut = raw.slice(0, maxChars);
    return `${cut.slice(0, Math.max(0, cut.lastIndexOf('\n'))).trim()}\n…(이하 생략 — 원문을 읽어라)`;
  } catch {
    return null;
  }
}

function findAncestorFile(startDir: string, filename: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 저장소 AGENTS.md 의 «제1원칙» 절에서 요지(북극성·넘버원 룰·SCQA 문법)를 뽑는다. 원문 복제가 아니라 발췌 ⊕ 출처. */
export function extractFirstPrinciple(agentsMd: string): string | null {
  const lines = agentsMd.split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s.*제1원칙/.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) { end = i; break; }
  }
  const section = lines.slice(start + 1, end);
  const picked: string[] = [];
  for (let i = 0; i < section.length; i++) {
    const line = section[i]!;
    if (/\*\*북극성\*\*/.test(line)) {
      picked.push(line);
      const next = section[i + 1];
      if (next && next.trim() && !/^\*\*/.test(next.trim())) picked.push(next);
    } else if (/\*\*넘버원 룰\*\*/.test(line) || /\*\*문법 = `SCQA`\*\*/.test(line)) {
      picked.push(line);
    }
  }
  const body = (picked.length ? picked : section.filter(l => l.trim() && !l.startsWith('>'))).join('\n').trim();
  if (!body) return null;
  return body.length > PRINCIPLE_MAX ? `${body.slice(0, PRINCIPLE_MAX)}…` : body;
}

export function renderLocalInstructionsTemplate(input: { seat: string; readmeHead: string | null; principle: string | null; at: string }): string {
  const out = [
    `# ${input.seat} 자리 — 로컬 지시 (TUI 가 ${input.at} 에 만들었다 · 사람이 고쳐도 된다)`,
    '',
    `너는 **${input.seat}** 자리의 엘라누스 TUI 다. 이 파일은 git 에 안 올라가는 «이 자리만의» 지시이고, 저장소 공용 지시(AGENTS.md)와 다르면 이 파일이 우선한다.`,
    '',
    '## 자리 정본 (seat-state README 머리)',
    input.readmeHead ?? `- 미관측: ~/elanous-hq/seat-state/${input.seat}/README.md 없음 — 역할은 사람에게 묻고 이 절을 채워라.`,
    '',
  ];
  if (input.principle) {
    out.push('## 제1원칙 (요지)', '> 정본 = 저장소 AGENTS.md §제1원칙 — 아래는 발췌다. 어긋나면 정본이 이긴다.', '', input.principle, '');
  }
  out.push(
    '## 시작하면',
    `- 우편함을 읽는다: \`eln msg list --to ${input.seat}\` — 안 읽은 우편 수와 처리할 것을 먼저 말한다.`,
    `- 자리 인계를 읽는다: ~/elanous-hq/seat-state/${input.seat}/HANDOFF.md (있으면).`,
    '- 앵커의 «지난 세션» 조각(TUI 가 `.AGENTS.local.last-session.md` 에 남긴다)의 열린 일을 이어받고, 다음 점검 시각을 정해 말한다.',
    '',
  );
  return out.join('\n');
}

export interface SeatLocalDeps {
  home?: string;
  now?: () => Date;
  /** 시험 심 — 생성(wx) 직후, 경쟁 확인 «전»에 불린다(사람이 그 틈에 파일을 만들거나 고치는 경우 재현). */
  afterCreateForTest?: (path: string) => void;
}

/** 자리 디렉터리에서 로컬 지시 파일이 하나도 없으면 템플릿으로 만든다. 결과를 첫 화면 한 줄에 쓴다. */
/** 경로에 «무엇이든» 있나 — 링크는 대상이 없어도 있다(lstat). */
function entryPresent(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

export function ensureSeatLocalInstructions(cwd: string, deps: SeatLocalDeps = {}): { status: 'created' | 'exists' | 'not-seat' | 'error'; path?: string; missingPrinciple?: boolean } {
  const seatDir = seatDirFromCwd(cwd);
  if (!seatDir) return { status: 'not-seat' };
  const path = join(seatDir.dir, LOCAL_INSTRUCTIONS_FILE);
  try {
    for (const name of [LOCAL_INSTRUCTIONS_FILE, COMPAT_LOCAL_FILE]) {
      const existing = join(seatDir.dir, name);
      // ⛔ «링크 자체»의 존재로 판정한다(lstat) — 대상이 없는 링크도 «있음»이다(existsSync 는 그것을 «없음»으로 본다).
      if (entryPresent(existing)) {
        // ⛔ 덮어쓰기 0 — 제1원칙 절이 없으면 «제안»만 한다(읽을 수 없는 링크면 제안도 안 한다).
        let body = '';
        try { body = readFileSync(existing, 'utf8'); } catch { body = '제1원칙'; }
        const missingPrinciple = !/제1원칙/.test(body);
        debug.log('tui.local-instructions', 'create-skipped', { seat: seatDir.seat, path: existing, reason: 'exists', missingPrinciple });
        return { status: 'exists', path: existing, missingPrinciple };
      }
    }
    const home = deps.home ?? homedir();
    const readmeHead = readHead(join(home, 'elanous-hq', 'seat-state', seatDir.seat, 'README.md'), README_HEAD_MAX);
    const agentsPath = findAncestorFile(seatDir.dir, 'AGENTS.md');
    const principle = agentsPath ? extractFirstPrinciple(readFileSync(agentsPath, 'utf8')) : null;
    const text = renderLocalInstructionsTemplate({ seat: seatDir.seat, readmeHead, principle, at: (deps.now?.() ?? new Date()).toISOString() });
    // `wx` = 없을 때만 만든다 — 확인과 쓰기 사이에 사람이 만든 파일도 덮지 않는다.
    writeFileSync(path, text, { flag: 'wx' });
    deps.afterCreateForTest?.(path);
    // 경쟁: 확인과 생성 사이에 사람이 호환 파일을 만들었으면 우리 파일이 그것을 가린다 — 방금 만든 것을 거둔다.
    if (entryPresent(join(seatDir.dir, COMPAT_LOCAL_FILE))) {
      // ⛔ «방금 쓴 내용과 같을 때만» 지운다 — 그 사이 사람이 고쳤으면 사람 문면을 지우지 않고 둘 다 남긴다(관측).
      let unchanged = false;
      try { unchanged = readFileSync(path, 'utf8') === text; } catch { unchanged = false; }
      if (unchanged) rmSync(path, { force: true });
      debug.log('tui.local-instructions', 'create-skipped', { seat: seatDir.seat, path, reason: 'compat-appeared', removedOwn: unchanged });
      return { status: 'exists', path: join(seatDir.dir, COMPAT_LOCAL_FILE), missingPrinciple: false };
    }
    debug.log('tui.local-instructions', 'created', { seat: seatDir.seat, path, chars: text.length, hasReadme: readmeHead !== null, hasPrinciple: principle !== null });
    return { status: 'created', path };
  } catch (err) {
    debug.log('tui.local-instructions', 'create-skipped', { seat: seatDir.seat, path, reason: 'error', error: err instanceof Error ? err.message : String(err) });
    return { status: 'error', path };
  }
}

// ── «지난 세션» 이어쓰기 ────────────────────────────────────────────────

export interface SessionMessage {
  role: string;
  content: unknown;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** 대시보드는 사람 턴을 `Context:\n…\n\nQuestion: <질문>` 으로 감싸 history 에 넣는다(turn-message-runtime.ts) — 질문만 꺼낸다. */
function userQuestion(text: string): string {
  const marker = '\n\nQuestion: ';
  if (!text.startsWith('Context:') || !text.includes(marker)) return text;
  return text.slice(text.lastIndexOf(marker) + marker.length);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1)}…` : flat;
}

/** 대화 기록에서 «지난 세션» 5줄 이내. 사람 턴이 없으면 null(쓸 것이 없다). */
export function summarizeSession(history: readonly SessionMessage[], meta: { endedAt: string; reason: string }): string[] | null {
  const turns = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, text: (m.role === 'user' ? userQuestion(messageText(m.content)) : messageText(m.content)).trim() }))
    .filter(t => t.text);
  const userTurns = turns.filter(t => t.role === 'user');
  if (userTurns.length === 0) return null;
  const lastUserIdx = turns.map(t => t.role).lastIndexOf('user');
  const lastAssistantIdx = turns.map(t => t.role).lastIndexOf('assistant');
  // 마지막 요청에 답하기 «전»에 끝났으면 그 앞 답을 이 요청의 답처럼 적지 않는다.
  const unanswered = lastAssistantIdx < lastUserIdx;
  const lastAnswer = lastAssistantIdx >= 0 ? turns[lastAssistantIdx]!.text : '';
  const answerLines = lastAnswer.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const open = answerLines.filter(l => /(다음|남은|열린|후속|미완|대기|TODO|할 일|이어서)/i.test(l)).slice(0, 2);
  const nextCheck = /(\d{1,2}:\d{2})/.exec(open.join(' ') || lastAnswer)?.[1];
  const lines = [
    `- 끝: ${meta.endedAt} · ${meta.reason} · 사람 턴 ${userTurns.length}`,
    unanswered
      ? `- 마지막 요청(답 없이 끝남 — 이어서 처리할 일): ${oneLine(userTurns.at(-1)!.text)}`
      : `- 마지막 요청: ${oneLine(userTurns.at(-1)!.text)}`,
  ];
  if (answerLines.length) lines.push(`- ${unanswered ? '그 전 답 요지' : '마지막 답 요지'}: ${oneLine(answerLines[0]!)}`);
  const fromPrev = unanswered ? '(그 전 답에서 — 마지막 요청의 후속이 아니다) ' : '';
  lines.push(`- 열린 일: ${open.length ? `${fromPrev}${open.map(oneLine).join(' / ')}` : '미관측(답에 «다음·남은·열린» 줄 없음) — 자리 우편·HANDOFF 로 확인'}`);
  if (nextCheck) lines.push(`- 다음 점검 시각(${unanswered ? '그 전 답에서' : '답에서'}): ${nextCheck}`);
  return lines.slice(0, MAX_LAST_SESSION_LINES);
}

/** «지난 세션» 파일 본문 — 머리 한 줄 ⊕ 요약 줄. */
export function renderLastSessionFile(lines: readonly string[]): string {
  return `## 지난 세션 (TUI 가 대화 끝마다 갈아 쓴다 · 사람이 고치지 않는 파일)\n${lines.join('\n')}\n`;
}

/** 대화 끝에 «지난 세션»을 TUI 소유 파일에 쓴다(동기 · 종료 경로 · tmp ⊕ rename). 사람 지시 파일은 건드리지 않는다. 실패는 관측만. */
export function writeLastSession(cwd: string, history: readonly SessionMessage[], reason: string, deps: SeatLocalDeps = {}): 'written' | 'skipped' {
  const seatDir = seatDirFromCwd(cwd);
  if (!seatDir) return 'skipped';
  const path = join(seatDir.dir, LAST_SESSION_FILE);
  let tmp: string | null = null;
  try {
    const lines = summarizeSession(history, { endedAt: (deps.now?.() ?? new Date()).toISOString(), reason });
    if (!lines) {
      debug.log('tui.local-instructions', 'last-session-skipped', { seat: seatDir.seat, reason: 'no-user-turn' });
      return 'skipped';
    }
    // 이 이름이 링크면(누가 심었으면) 따라가 쓰지 않는다.
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      debug.log('tui.local-instructions', 'last-session-skipped', { seat: seatDir.seat, path, reason: 'symlink' });
      return 'skipped';
    }
    const text = renderLastSessionFile(lines);
    tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
    tmp = null;
    debug.log('tui.local-instructions', 'last-session-written', { seat: seatDir.seat, path, reason, lines: lines.length, chars: text.length });
    return 'written';
  } catch (err) {
    debug.log('tui.local-instructions', 'last-session-skipped', { seat: seatDir.seat, reason: 'error', error: err instanceof Error ? err.message : String(err) });
    return 'skipped';
  } finally {
    if (tmp) { try { if (!lstatSync(tmp).isSymbolicLink()) rmSync(tmp, { force: true }); } catch { /* 없으면 그만 */ } }
  }
}

export interface SessionRecorderDeps {
  getCwd: () => string;
  getHistory: () => readonly SessionMessage[];
  onExit?: (fn: () => void) => void;
}

let recorder: SessionRecorderDeps | null = null;
let recordedThisConversation = false;
// 대화의 기록 대상 디렉터리 — 대화가 «시작될 때» 고정한다(도중 cwd 를 옮겨도 다른 자리 파일에 쓰지 않게).
let conversationCwd: string | null = null;

export function resetSessionRecorderForTest(): void {
  recorder = null;
  recordedThisConversation = false;
  conversationCwd = null;
}

/** 대화 끝 기록 — 같은 대화에서 두 번 쓰지 않는다(`/session new` 뒤 `exit` 등). */
export function recordSeatSessionEnd(reason: string): void {
  if (!recorder || recordedThisConversation) return;
  const cwd = conversationCwd ?? recorder.getCwd();
  if (writeLastSession(cwd, recorder.getHistory(), reason) === 'written') recordedThisConversation = true;
}

/** 새 대화가 시작됐다 — 기록 대상을 지금 cwd 로 다시 고정하고, 다음 끝에서 다시 쓴다. */
export function markSeatConversationStarted(): void {
  recordedThisConversation = false;
  conversationCwd = recorder?.getCwd() ?? null;
}

/** 대시보드가 부팅 때 한 번 건다. `/quit`·Ctrl+C·SIGINT/SIGTERM 은 모두 process 'exit' 로 끝난다(tui.ts 핸들러가 process.exit). */
export function installSeatSessionRecorder(deps: SessionRecorderDeps): void {
  const first = recorder === null;
  recorder = deps;
  conversationCwd = deps.getCwd();
  if (!first) return;
  const onExit = deps.onExit ?? ((fn: () => void) => { process.on('exit', fn); });
  onExit(() => {
    try { recordSeatSessionEnd('exit'); } catch { /* 종료는 언제나 끝까지 간다 */ }
  });
}
