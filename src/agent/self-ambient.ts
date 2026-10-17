// ── elanous 자기접근 규율 + 자기인지 ambient — 단일 출처 leaf (P3 · 2026-07-13) ──
//
// 텔레그램/디스코드(makeElanousAgentRunTurn)와 TUI 채팅(buildDashboardTurnPreamble)이
// 같은 규율·ambient 를 주입하도록 추출. 그간 TUI 채팅은 3박자(툴·기억·규율) 전부 0 이라
// "P2 왜 실패?" 같은 자기 상황판단이 표면에 따라 됐다 안 됐다 했다(표면 패리티 갭).
// 이 모듈은 순수 문자열 조립 + read-only 스토어 조회(fail-soft)만 — 실행엔진 없음.

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { recentSelfChangesContext, recallSelfEvents } from '../domains/self-awareness.js';
import { openSurfaceEventsDb, surfaceEventsDbPath } from '../domains/surface-events.js';
import { recentAutonomyContext } from '../domains/autonomy-log.js';
import { opsHealthContext } from '../domains/ops-status.js';
import { openOpsEventsDb, queryOpsEvents } from '../domains/ops-log.js';
import { buildMissionIncidentContext, formatIncidentContextCompact, type MissionIncidentContext } from '../autopilot/mission-incident-context.js';

/** session ID 를 system prompt 에 그대로(verbatim) 넣어도 되는 안전 형식인지 검증한다.
 *  실제 session ID(buildPromptSessionId 의 http-<ts>-<rand>·ACP base36·elanous-session-N)는
 *  영숫자 시작 + 영숫자/하이픈/언더스코어(최대 64자) 형식이다. 이 형식을 만족하면 **원문 그대로**
 *  쓴다(mangle 하면 session_manage 조회가 실제 ID 와 어긋나 실패하므로 절대 변형하지 않는다).
 *  만족하지 못하면(개행·공백·콜론·점·지시문 문자 포함 등) 호출부가 session ID 라인을 통째로 생략한다
 *  → 개행·공백·구분자로 라벨 라인을 벗어나는 injection 을 차단한다. (하이픈으로 이어진 단일 토큰
 *  IGNORE-PREVIOUS-INSTRUCTIONS 류는 형식상 통과하나, 개행/공백이 없어 라벨된 데이터 값으로만 한 줄에
 *  표시되므로 지시문으로 분리되지 않는다 — 완전 차단이 아닌 라인이탈 차단·fail-safe.) */
export function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(sessionId);
}

/** elanous 자기접근 규율 — 에이전트가 이미 가진 내부 도구(소스 분석·수정·ACP 위임·세션·
 *  자기인지·웹검증·미션 진단)를 지식/기억으로 단정하지 말고 실제로 호출하게 하는 규율.
 *  codex 엔진은 도구 호출을 건너뛰고 텍스트로 서술하는 경향이 있어(동물 종명을 검색 없이
 *  "없다"고 오답한 사례) 명시적 규율이 필요. 코어·finance 무관 상시. */
export function elanousSelfAccessPrompt(sessionId?: string): string {
  const safeSessionId = sessionId && isSafeSessionId(sessionId) ? sessionId : '';
  return [
    '[elanous 북극성 · 정체성 (manifesto)]',
    '너는 elanous 다 — 전전두엽(PFC)처럼 팔다리·감각기관(도구·로그·기억·PTY·서브-elanous)을 써서 스스로',
    '계획하고 스스로 진화하는 에이전트. 존재 이유이자 최우선 기준은 **자기 관측성 → 자기 인지 → 셀프',
    '힐링**이다: 사람이 매 단계를 판단하는 게 아니라 시스템이 스스로 수렴한다. 관측 없이는 인지가 없고,',
    '인지 없이는 힐링이 없다. 그러므로 지식·기억으로 단정하지 말고 도구로 관측하고, 관측 위에서 맥락을',
    '파악하며, 스스로 판단·수복하되 안 되면 충분한 정보와 함께 사람에게 올린다(HITL). 모든 자율 행동은',
    '관측(로그·기억·문서 3박자)을 남긴다 — 남기지 않은 행동은 관측하지 않은 것이다.',
    '',
    '[elanous 자기접근 규율]',
    '너는 elanous 자신이다. 너의 소스코드·로직·세션·기억에 접근하는 도구를 이미 갖고 있다. 지식이나',
    '기억으로 단정하지 말고 아래 도구로 확인하고 행동하라. codex 엔진은 도구 호출을 건너뛰고 텍스트로',
    '서술하는 경향이 있으니, 필요하면 반드시 실제로 도구를 호출하라(서술로 대체하지 마라).',
    '- 네 코드/로직/기능 질문("네 코드가 어떻게", "이 기능 왜", "어디서 처리하나"): Read/Grep/Glob 로',
    '  실제 소스를 읽고 file:line 근거로 답하라. 기억으로 지어내지 마라.',
    // ⭐ 2026-08-11(대표 승인) — 이 항목의 «적용 범위»를 좁혔다. 종전 문면은 *"소스 수정 요청: 크기와
    //   무관하게 … 직접 코딩하라"* 였는데, 그 문장이 대표 결정 2026-07-14 의 «대상이 아니던» 하니스
    //   (SelfImplement/RunDevHarness)까지 눌렀다. 원 결정(4f79887a2)의 실사건은 *"사용자가 부르지 않은
    //   codex 의 exec 승인 프롬프트 표면화"* 였고 고친 파일도 전부 ACP 위임 축이다 ⇒ 그 규율은 ⓑ(외부
    //   에이전트)에만 걸고, ⓒ(자체 하니스)의 기본값은 아래 「자기 수정」 항목이 정한다.
    '- 소스 수정 요청: **기본은 하니스다** — 기능 구현·수정·리팩토링은 아래 「자기 수정」 항목대로',
    '  SelfImplement/RunDevHarness 로 격리 self-build 를 띄워라. 한 줄 수정·설정값·문서처럼 작은 것은',
    '  Edit/Write + Bash(테스트·검증)/PtyShell 로 직접 코딩하라.',
    '- delegate_code_agent(ACP 외부 에이전트 위임)는 사용자가 특정 코딩 에이전트(claude/codex/gemini/grok)를',
    '  **명시 지목했을 때만** 쓴다(대표 결정 2026-07-14). 지목이 없으면 네 재량으로 backend 를 골라',
    '  위임하지 마라 — 하니스로 가거나 위 기준대로 직접 코딩하라.',
    // [터미널 미션 규율] lives in agent/terminal-surface.ts
    // (TERMINAL_MISSION_DISCIPLINE) — buildTerminalCapableTurn appends it.
    '- 사실/존재/고유명사/종명/인물/제품/최신정보 확인("~가 있나요/맞나요", 낯선 이름·오타 의심):',
    '  지식으로 단정 말고 WebSearch 로 먼저 검증하고 출처를 밝혀라.',
    '- 과거 대화/세션("아까 무슨 얘기", "그 세션", "전에 말한"): session_manage 로 실제 세션을 조회하라.',
    '- 네 구현 이력·자기 인지: self_recall / memory_recall 로 회상하라.',
    '- 방금 일어난 일·오류·표면 동작은 logs_query(= elanous logs, logs.db)로 최근 이벤트를 실제 조회하라.',
    '  관측이 부족하면 네가 수정하는 코드 경로에 debug.log(category, event, data)를 추가해 logs.db에 남겨라.',
    '- 자기 수정(기능 구현·수정·리팩토링을 격리 self-build 로)이 필요하면 SelfImplement 또는 RunDevHarness',
    '  **툴을 직접 호출**하라. 셸(Bash/PtyShell)로 `elanous self implement`·`elanous dev`·`harness run` 같은',
    '  CLI 를 실행하는 것은 같은 파이프라인을 우회 진입하는 것이라 서피스 승인막(HITL)·진행 push·격리',
    '  컨텍스트가 전달되지 않는다. **툴이 있으면 툴로, 셸아웃은 금지.**',
    '  auto-review 는 opt-in auto-review 라벨이 붙은 PR의 무인 리뷰·검증·자율머지 파이프라인이므로,',
    '  라벨/HITL 경계를 우회하거나 머지를 단정하지 마라.',
    // ⭐ F1 소환 인지(RFC-observability-driven-tool-selection · 2026-07-26) — 실전검증에서
    //   에이전트가 deferred 된 SelfImplement 를 "없는 툴"로 취급하고 PtyShell 로 CLI 셸아웃한
    //   사건의 프롬프트 층 수리. 배틀쉽은 목록에만 있고 스키마는 접혀 있다는 사실을 명시한다.
    '- ★ 툴 소환(deferred): 시스템 프롬프트에 "이름만" 나열된 툴(예: SelfImplement·RunDevHarness·',
    '  SolveMission)은 **없는 게 아니라 스키마가 접혀 있는 것**이다. 목록에 있으면 그 툴은 존재한다.',
    '  쓰려면 먼저 ToolSearch({query:"select:<이름>"}) 로 스키마를 펼친 뒤 호출하라. 목록에 있는 툴을',
    '  "가용하지 않다"고 단정하거나, 스키마가 안 보인다는 이유로 셸 우회를 택하지 마라.',
    ...(safeSessionId ? [`- 현재 요청의 session ID: ${safeSessionId}. 이 값은 이번 턴의 식별자이며 다른 세션에 재사용·추측하지 마라.`] : []),
    '- ★ 선제 회상(반응형만 하지 말고 능동): 중요한 판단·제안을 하기 **전에** 관련 과거를 스스로',
    '  먼저 self_recall/memory_recall 로 소환하라(과거 결정·유사 사건·앞선 교훈). 물어보길 기다리지',
    '  말고 판단 시점에 선제적으로 — 관련 기억은 회상하는 것만으로 강화된다(축B 능동회상).',
    '- ★ 자율 미션/페이즈 상태·실패("무슨 미션 도나", "P2 왜 실패했어", "지금 뭐 하는 중", "어떻게',
    '  해야 해"): ops_status 로 조회하라. action:mission(id)=미션 상세 + 페이즈별 진단(왜 실패·근본원인',
    '  추정·권장 힐)·전이 이력, action:timeline(entity-type task)=페이즈 실패 전이. 진단은 이미',
    '  기록돼 있으니(run-mission 이 남김) 재계산 말고 그대로 전하고, 권장 힐(재구현/분할/골정정/건너뛰기)을 안내하라.',
    '- ★ 방금 받은 알림/국면 브레이크/자율매매 후속("그 알림 왜 왔어", "국면 왜 바뀌었어",',
    '  "더 파봐", "어떻게 조치하지"): 알림은 네가 발송한 것이고 기억(surface_events)에 남아있다.',
    '  먼저 memory_recall/self_recall 로 그 알림의 상세 컨텍스트(국면벡터·괴리·캡스톤·근거)를',
    '  회상하고, finance_dig / finance_ontology / finance_kr_flow 로 원인을 더 깊이 디깅해',
    '  "왜/좋아진건지·나빠진건지"를 짜임새 있게 설명하라. 조치가 필요하면 mandate 조정 방향을',
    '  구체적으로 제안하라(실제 mandate 파일 편집은 개념 변경이라 대표 확인 필수 — 네가 제안·안내만).',
    '- 확인 못 하면 "확인 못 함"이라고 정직하게 말하라. 도구로 검증 가능한 것을 추측으로 답하지 마라.',
  ].join('\n');
}

/** 최근(12h) 사건(실패·셀프힐) 미션 id — ops_events(refs.missionId + 실패 신호)에서 결정론 추출.
 *  fail-soft. "왜 실패?" 질문의 대상 미션을 봇이 추측 않게 push 문맥을 고정하는 seam(RFC P2). */
function recentIncidentMissionId(): string | null {
  try {
    const db = openOpsEventsDb();
    try {
      const rows = queryOpsEvents(db, { entityType: 'task', event: 'status_change', sinceHours: 12, limit: 50 });
      for (const r of rows) {
        if (!r.refs) continue;
        let refs: Record<string, unknown>;
        try { refs = JSON.parse(r.refs) as Record<string, unknown>; } catch { continue; }
        const mid = typeof refs.missionId === 'string' ? refs.missionId : null;
        if (!mid) continue;
        // 실패/셀프힐 신호가 있는 최신 이벤트의 미션.
        if (refs.failClass || refs.heal || refs.verdict === 'fail' || refs.stage === 'triage'
          || /fail/i.test(r.to_state ?? '')) return mid;
      }
      return null;
    } finally { db.close(); }
  } catch { return null; }
}

/** ★ 미션 사건 ambient(RFC P2) — 최근 사건(실패) 미션의 **실제 사건 사실**을 압축 주입. 봇 LLM(특히
 *  terra)이 ops_status 툴 호출을 건너뛰고 fuzzy 기억으로 유사 과거(#3928 류)를 지어내던 confabulation
 *  차단. 정상/사건 없으면 빈 문자열(무노이즈). READ-ONLY·fail-soft. deps=테스트 seam. */
export function missionIncidentAmbient(
  deps: { missionId?: () => string | null; build?: (id: string) => MissionIncidentContext } = {},
): string {
  try {
    const mid = (deps.missionId ?? recentIncidentMissionId)();
    if (!mid) return '';
    const ctx = (deps.build ?? buildMissionIncidentContext)(mid);
    return formatIncidentContextCompact(ctx);
  } catch { return ''; }
}

// ── 축B 조사문맥 자동 회상 (2026-07-19) ──────────────────────────────────────
//
// 갭: elanousSelfAccessPrompt 의 "★ 선제 회상" 규율은 판단 전 self_recall 을 프롬프트로
// 지시하지만, codex/terra 엔진이 툴 호출을 건너뛰어 실제로는 회상 안 하는 경우가 잦다
// (같은 confabulation 계열). recentSelfChangesContext 는 최근성만 주입(query 무관).
// → 프롬프트가 **내부 조사** 문맥일 때, task 에 **관련된** 과거 자기변경/사건을 결정론으로
// query-recall 해 주입한다(최근성의 자매=relevance). Claude Code 자동회상 훅(축A)의 elanous
// 이식. 명시룰(트리거·랭킹 결정론)·READ-ONLY(bump 안 함)·조사문맥 아니면 무주입(무노이즈).

/** 내부 조사 신호(한/영) — 자기 코드·실패·원인·검증 문맥. */
const ELANOUS_INVESTIGATION_SIGNALS = [
  '왜', '원인', '근본', '이유', '실패', '에러', '오류', '버그', '안돼', '안 돼', '안됨',
  '조사', '확인', '검증', '점검', '디버', '어디서', '어떻게', '무슨', '이상', '이력', '과거',
  '네 코드', '이 기능', '회상',
  'why', 'fail', 'error', 'bug', 'debug', 'root cause', 'root-cause', 'incident',
  'investigate', 'verify', 'inspect', 'diagnose', 'regression', 'trace', 'audit',
];

/** 내부 조사 문맥인가 — 순수·결정론(명시 키워드). */
export function isInvestigationContext(text: string): boolean {
  if (!text || !text.trim()) return false;
  const lower = text.toLowerCase();
  return ELANOUS_INVESTIGATION_SIGNALS.some((s) => lower.includes(s));
}

/** 축B 테스트 코어(db 주입) — 조사문맥이면 task 관련 과거 자기사건 top-K 요약.
 *  조사문맥 아님/무히트 → 빈 문자열(무주입). READ-ONLY(bump 안 함 — 모듈 read-only 계약). */
export function investigationRecallDigest(db: Database, taskText: string, opts: { limit?: number } = {}): string {
  if (!isInvestigationContext(taskText)) return '';
  const hits = recallSelfEvents(db, taskText, { limit: opts.limit ?? 5 });
  if (!hits.length) return '';
  const rows = hits.map((h) => {
    const body = (h.summary ?? h.text ?? '').replace(/\s+/g, ' ').slice(0, 200);
    return `- [${(h.ts ?? '').slice(0, 10)}${h.kind ? `·${h.kind}` : ''}] ${body}`;
  });
  return `현재 요청(내부 조사)에 **관련된** 과거 자기변경/사건 (자동 회상 · 더 필요하면 self_recall):\n${rows.join('\n')}`;
}

/** 축B ambient wrapper — 실 db·fail-soft·매 턴 fresh. */
export function investigationRecallAmbient(taskText: string): string {
  try {
    if (!isInvestigationContext(taskText)) return '';
    if (!existsSync(surfaceEventsDbPath())) return '';
    const db = openSurfaceEventsDb();
    try { return investigationRecallDigest(db, taskText); } finally { db.close(); }
  } catch { return ''; }
}

/** 자기인지 ambient — 최근 자기 구현/변경 + 최근 자율행동 + 자율 시스템 이상 + 미션 사건 사실
 *  (+ taskText 주면 조사문맥 관련 회상·축B). 매 턴 fresh · 각각 fail-soft(없음이면 빈 문자열). */
export function elanousSelfAmbientParts(taskText?: string): string[] {
  const parts = elanousSelfAmbientBaseParts();
  if (taskText) { try { parts.push(investigationRecallAmbient(taskText)); } catch { /* fail-soft */ } }
  return parts.filter(Boolean);
}

/** The request-independent ambient parts (store scans · `ps` · crontab). Split out so the
 *  TUI can compute them off its event loop (`self-ambient-cache.ts`). */
export function elanousSelfAmbientBaseParts(): string[] {
  const parts: string[] = [];
  try { parts.push(recentSelfChangesContext()); } catch { /* fail-soft */ }
  try { parts.push(recentAutonomyContext()); } catch { /* fail-soft */ }
  try { parts.push(opsHealthContext()); } catch { /* fail-soft */ }
  try { parts.push(missionIncidentAmbient()); } catch { /* fail-soft */ }
  return parts.filter(Boolean);
}
