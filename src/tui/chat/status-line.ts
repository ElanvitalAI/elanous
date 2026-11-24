import { fitLogLine, safeStatusText } from './log-view.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface NextTuiStatusLineInput {
  readonly turnState: string;
  readonly model: string;
  readonly queued: number;
  /** ELN-QUEUE-ITEM-CONTROLS: how many of `queued` wait as steers (shown as «Steer n · Queue n»). */
  readonly steering?: number;
  readonly backgroundTasks: number;
  readonly width: number;
  readonly elapsedMs?: number;
  readonly measuredUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly estimatedOutputTokens?: number;
}

export interface NextTuiCompactStatusLineInput {
  readonly state: string;
  readonly model?: string;
  readonly queued: number;
  /** How many of `queued` wait as steers. */
  readonly steering?: number;
  readonly activeChildren: number;
  readonly columns: number;
  readonly elapsedMs?: number;
  readonly measuredUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly estimatedOutputTokens?: number;
}

function tokenTelemetry(usage: NextTuiStatusLineInput['measuredUsage'], estimate: number | undefined, compact: boolean): string {
  if (usage?.outputTokens === undefined
    && estimate !== undefined && Number.isSafeInteger(estimate) && estimate >= 0) {
    if (usage?.inputTokens !== undefined) {
      const pair = `${usage.inputTokens}/est.${estimate}`;
      return compact ? `${pair}t` : `Tokens ${pair}`;
    }
    return compact ? `est.${estimate}t` : `Output tokens est. ${estimate}`;
  }
  const pair = `${usage?.inputTokens ?? '?'}/${usage?.outputTokens ?? '?'}`;
  return compact ? `${pair}t` : `Tokens ${pair}`;
}

function turnTelemetry(elapsedMs: number | undefined, usage: NextTuiStatusLineInput['measuredUsage'], compact = false, estimate?: number): string {
  if (elapsedMs === undefined) return '';
  const seconds = `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`;
  const tokens = tokenTelemetry(usage, estimate, compact);
  return compact ? `${seconds} · ${tokens}` : `Elapsed ${seconds} · ${tokens}`;
}

/** Only elapsed time may be approximated; provider token counts must stay exact. */
function compactElapsed(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '?';
  const digits = String(Math.max(0, Math.floor(value)));
  if (digits.length <= 5) return digits;
  return `≈${digits[0]}${digits[1] === '0' ? '' : `.${digits[1]}`}e${digits.length - 1}`;
}

function minimumTelemetry(elapsedMs: number | undefined, usage: NextTuiStatusLineInput['measuredUsage'], estimate?: number): string {
  if (elapsedMs === undefined) return '';
  const seconds = Math.max(0, elapsedMs) / 1000;
  const elapsed = String(Math.floor(seconds)).length <= 4 ? `${seconds.toFixed(1)}s` : `${compactElapsed(seconds)}s`;
  return `${elapsed}·${tokenTelemetry(usage, estimate, true)}`;
}

function smallestElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  const digits = String(Math.floor(seconds));
  return digits.length <= 4 ? `${seconds.toFixed(1)}s` : `~${digits[0]}e${digits.length - 1}s`;
}

/** Keep the shown duration monotonic even if a clock source is replaced in a device. */
export function nextTuiElapsedMs(startedAtMs: number, nowMs: number, previousMs = 0): number {
  return Math.max(previousMs, 0, nowMs - startedAtMs);
}

function clean(value: string): string {
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
}

const TURN_PHASES: Readonly<Record<string, string>> = {
  'Bash 실행': 'tools', 'Bash 실행 중': 'tools', '도구 실행': 'tools',
  '실행 중인 도구': 'tools', '응답 중': 'running', '실행 중': 'running',
  '작업 중': 'running', '로그 탐색': 'log', '조회 중': 'loading',
  '현재 맥락 조회 중': 'loading', '응답 완료': 'done', '완료': 'done',
  'Enter 전송': 'idle', '입력 대기': 'idle', '대기': 'idle',
};
/** English heads the short clause also reads as phases (the old formatter keeps them as text). */
const ENGLISH_PHASES: Readonly<Record<string, string>> = { running: 'running', idle: 'idle', done: 'done', tools: 'tools' };

/**
 * #38392: whether a turn state is only a phase word (running · thinking · tools …) — what the progress row above the
 * input already says while a turn runs. Anything else (an action answer such as «Editing queued item», «Queue closed»)
 * is information the bottom status line must keep.
 */
export function nextTuiTurnIsPhase(turnState: string): boolean {
  const head = (clean(turnState) || 'idle').split(' · ')[0] ?? '';
  return Object.hasOwn(TURN_PHASES, head) || Object.hasOwn(ENGLISH_PHASES, head);
}

function compactState(value: string): string {
  const cleaned = clean(value);
  const head = cleaned.split(' · ')[0] ?? '';
  return Object.hasOwn(TURN_PHASES, head) ? TURN_PHASES[head]! : englishFooterText(cleaned) || 'idle';
}

/** Translate only known UI clauses. Names, commands, candidates and unknown text stay untouched. */
const FOOTER_ENGLISH: Readonly<Record<string, string>> = {
  '미션 준비 완료': 'Mission ready',
  '워크스페이스 PTY 전송 결과 미확인': 'Workspace PTY send outcome unconfirmed',
  '대상 화면과 이력을 확인하기 전 재시도 금지': 'Do not retry until the target screen and history are checked',
  '마지막 전송 결과 미확인, PTY 확인 전 재시도 금지': 'Last send outcome unconfirmed; do not retry before checking the PTY',
  '선택한 에이전트에 입력 전송': 'Input sent to selected agent',
  '그래프 두 갈래·비교 합성 완료': 'Graph branches and comparison completed',
  '그래프 두 갈래 완료': 'Graph branches completed',
  '기존 pair 합성 파일 저장 실패': 'Existing pair synthesis file could not be saved',
  '연결 재시도 중': 'Reconnecting', '새 대화': 'New chat', '없음': 'none',
  '미션 준비 관찰 중': 'Watching mission readiness', '미션 실행 관찰 중': 'Watching mission execution',
  '미션 관찰 오류': 'Mission observation error', '미션 종결': 'Mission ended',
  '하니스 호출을 취소했습니다': 'Harness call cancelled',
  '완료(또는 Esc 취소) 뒤 다시': 'Retry when done (or Esc cancel)',
  "이미 이 대화다": "Already in this chat",
  "대화 이어 가기": "Resuming chat",
  "/resume 으로 목록 보기": "/resume to list chats",
  "압축할 내용 없음": "Nothing to compact",
  "측정 불가": "Unmeasured",
  "PTY 해제 실패": "PTY release failed",
  "PTY 입력 취소": "PTY input cancelled",
  "PTY 입력 결과 불명(전송 여부 확인 불가)": "PTY input outcome unknown (delivery unconfirmed)",
  "PTY 원격 작업 실패": "Remote PTY operation failed",
  "Herdr 입력 실패": "Herdr input failed",
  "Herdr 연결은 HERDR_ENV=1인 관리 세션에서만 사용할 수 있습니다": "Herdr requires a managed HERDR_ENV=1 session",
  "Herdr pane 읽기 실패": "Herdr pane read failed",
  "Herdr pane 관측": "Observing Herdr pane",
  "Esc / Ctrl+\\ 복귀": "Esc / Ctrl+\\ return",
  "Ctrl+Q 전체 종료 (Ctrl+[는 Esc로 읽힐 수 있음)": "Ctrl+Q quit all (Ctrl+[ may be read as Esc)",
  "PTY 화면이 비어 있어 채팅 화면을 유지합니다": "PTY screen empty; keeping chat visible",
  "PTY 화면 읽기 실패": "PTY screen read failed",
  "PTY 화면 읽기 오류": "PTY screen read error",
  "원격 PTY 화면": "Remote PTY screen",
  "Ctrl+\\ 후 ↑/↓ 전환": "Ctrl+\\ then ↑/↓ switch",
  "PTY 분리됨": "PTY detached",
  "사이드탭에서 다시 선택 가능": "Select again from the sidetab",
  "PTY 입력 중": "PTY input active",
  "Ctrl+\\ d 분리": "Ctrl+\\ d detach",
  "Ctrl+Q는 PTY에 전달": "Ctrl+Q sent to PTY",
  "PTY 모달은 최소 40칸 × 8줄이 필요합니다": "PTY modal requires at least 40 columns × 8 rows",
  "사이드탭으로 돌아옴": "Returned to sidetab",
  "이 항목은 Next TUI에서 만든 세션이 아닙니다": "This session was not created by Next TUI",
  "shell/agent 세션만 attach할 수 있습니다": "Only shell/agent sessions can be attached",
  "종료된 PTY는 attach할 수 없습니다": "Cannot attach an exited PTY",
  "현재 TUI 세션은 사이드탭에서 종료할 수 없습니다": "Cannot stop this TUI session from the sidetab",
  "PTY 종료 거부": "PTY stop denied",
  "PTY 종료 오류": "PTY stop error",
  "이 항목은 이 Next TUI에서 종료할 수 없습니다": "This item cannot be stopped from this Next TUI",
  "Herdr pane에서 복귀": "Returned from Herdr pane",
  "Esc로 복귀": "Esc return",
  "NUL 입력은 Herdr pane에 보낼 수 없습니다": "NUL input cannot be sent to a Herdr pane",
  "takeover 오류": "Takeover error",
  "분리 취소": "Detach cancelled",
  "Ctrl+\\ d 를 눌러 분리": "Ctrl+\\ d to detach",
  "분리 키 대기": "Waiting for detach key",
  "사람 입력 takeover 완료": "Human input takeover complete",
  "전환 때 release": "Release on switch",
  "워크스페이스 PTY 결합": "Workspace PTY linked",
  "워크스페이스의 실행 중인 PTY 행을 선택하세요": "Select a running workspace PTY row",
  "워크스페이스 입력이 비었습니다": "Workspace input is empty",
  "워크스페이스 별도 대화 응답": "Workspace side-chat reply",
  "워크스페이스 PTY 전송": "Workspace PTY sent",
  "워크스페이스 PTY 전송 거부": "Workspace PTY send denied",
  "대상을 확인하세요": "Check the target",
  "워크스페이스 입력 중지": "Workspace input stopped",
  "사용법: /side broadcast 행ID,행ID -- 내용": "Usage: /side broadcast rowID,rowID -- text",
  "거부된 대상 재확인": "Recheck denied targets",
  "워크스페이스 방송 중지": "Workspace broadcast stopped",
  "에이전트 선택: codex": "Select agent: codex",
  "에이전트 PTY 입력 실패": "Agent PTY input failed",
  "선택·실행 상태 확인": "Check selection and execution state",
  "읽을 에이전트 PTY가 없습니다": "No agent PTY to read",
  "선택한 에이전트 PTY 화면": "Selected agent PTY screen",
  "사이드탭 on": "Sidetab on",
  "열림": "Open",
  "/side open 으로 열기": "/side open to open",
  "사이드탭 전체 목록": "All sidetab entries",
  "사이드탭 미션·하니스 워크스페이스": "Sidetab mission/harness workspaces",
  "사이드탭 현재 세션 목록": "Current sidetab sessions",
  "종료할 PTY가 없습니다": "No PTY to stop",
  "미션 결과 확인": "Mission result",
  "미션 확인 실패": "Mission check failed",
  '도구 실행 실패': 'Tool failed', '응답 실패': 'failed',
  '하니스 호출 취소됨': 'Harness cancelled', '응답 취소됨': 'cancelled',
  '응답 취소 중': 'cancelling', '응답 완료': 'done', '응답 중': 'running',
  '도구 실행': 'tools', 'Bash 실행': 'Bash running', '작업 중': 'running',
  '입력 대기': 'idle', '대기': 'idle', '로그 탐색': 'Log navigation',
  '모델: 깊음': 'Model: deep', '다음 턴부터 적용': 'applies next turn',
  'Enter 전송': 'Enter send', 'Esc 취소': 'Esc cancel', 'Ctrl+Q 종료': 'Ctrl+Q quit',
  '↑ 이전 입력 후 Enter': '↑ previous input, then Enter',
  '↑↓ 선택': '↑↓ select', 'Tab 완성': 'Tab complete', 'Enter 실행': 'Enter run',
  'Enter 선택': 'Enter select', 'Enter 추가': 'Enter add', 'Esc 닫기': 'Esc close',
  '↑↓ 스크롤': '↑↓ scroll', 'Enter 접기/펼치기': 'Enter fold/unfold', 'Esc 입력': 'Esc input',
  '첨부 경로': 'Attachments', '↑↓ 내용 보기': '↑↓ view content',
  '@ 파일 첨부': '@ Attach file', '@ 파일 후보 없음': '@ No matching files',
  '@ 파일 첨부 후보': '@ File candidates',
  '계속 입력': 'keep typing', '파일 선택 닫힘': 'File picker closed', '파일 첨부 추가됨': 'File attached',
  '슬래시 명령': 'Slash commands', '/ 명령': '/ Commands', '명령 완성': 'Command completed',
  '긴 셸 명령 중단 확인': 'Confirm stopping long shell', '응답 중단 확인': 'Confirm stopping turn',
  '기본 N': 'default N', 'Enter=계속': 'Enter=continue', 'y/n 입력': 'y/n answer',
  '플러그인 그래프 승인': 'Plugin graph approval', '요청 내용': 'Request details',
  'Bash 실행 승인': 'Bash approval', '전체 명령': 'Full command',
  'y 승인': 'y approve', 'y 실행': 'y run', 'n 거부': 'n deny',
  'Enter 기본 N': 'Enter default N', 'Esc 거부': 'Esc deny',
  '플러그인 그래프 승인 필요': 'Plugin graph approval required', 'Bash 실행 승인 필요': 'Bash approval required',
  '플러그인 그래프 승인됨': 'Plugin graph approved', '플러그인 그래프 거부됨': 'Plugin graph denied',
  'Bash 명령 승인됨': 'Bash command approved', 'Bash 명령 거부됨': 'Bash command denied',
  'Bash 승인 시간 초과': 'Bash approval timed out', 'Bash 승인 취소됨': 'Bash approval cancelled', '거부됨': 'denied',
  '플러그인 그래프 승인 시간 초과': 'Plugin graph approval timed out', '플러그인 그래프 승인 취소됨': 'Plugin graph approval cancelled',
  '보류됨(거부 아님)': 'on hold (not denied)',
  '터미널 폭이 줄어 사이드탭을 닫았습니다': 'Terminal narrowed; sidetab closed',
  '사이드탭 off': 'Sidetab off', '/side on 으로 이 세션에서 켜기': '/side on to enable for this session',
  '사이드탭은 터미널 폭 34칸 이상에서 열 수 있습니다': 'Sidetab requires at least 34 columns',
  '세션 목록이 갱신되어 전환을 취소했습니다': 'Session list changed; switch cancelled',
  '응답 중에는 세션을 전환할 수 없습니다': 'Cannot switch sessions during a turn',
  '세션을 읽을 수 없습니다': 'Cannot read session', '목록을 다시 열어 주세요': 'Reopen the list',
  '세션 전환됨': 'Session switched', '사이드탭 포커스': 'Sidetab focus',
  'g 그래프/자원': 'g graphs/resources', '1–9 선택': '1–9 select',
  '부모 채팅': 'Parent chat', '입력 포커스': 'Input focus',
  '워크스페이스 PTY 선택': 'Select workspace PTY', '/side bind 로 결합': '/side bind to link',
  'Enter 로 attach': 'Enter to attach', '도구 상태 확인 불가': 'Tool status unavailable',
  '대기 입력 유지': 'Queued input preserved', '완료 뒤 대기 입력 전송': 'Send queued input when done',
  '⚡ 지금 밀어 넣기': '⚡ Send now', '대기 입력 전송 중': 'Sending queued input',
  'SIM 관측 감시 중단': 'SIM observation stopped',
  '클립보드 이미지를 첨부하지 못했습니다': 'Cannot attach clipboard image', '다시 시도': 'Try again',
  '클립보드에 붙여넣을 글이 없습니다': 'Clipboard has no text',
  '사이드탭 이름 변경 취소': 'Sidetab rename cancelled',
  'PTY 이름을 입력하거나 현재 항목을 다시 확인하세요': 'Enter a PTY name or check the current item',
  'PTY 이름 변경 완료': 'PTY renamed', 'PTY 이름 변경 실패': 'PTY rename failed',
  'PTY 종료 요청 완료': 'PTY stop requested', 'PTY 종료 불가': 'Cannot stop PTY',
  'PTY 항목을 찾을 수 없습니다': 'PTY item not found', 'PTY 종료 취소': 'PTY stop cancelled',
  '새 PTY 이름 입력': 'Enter new PTY name', 'Enter 저장': 'Enter save',
  'PTY 종료 확인': 'Confirm stopping PTY', '다른 키 취소': 'Other key cancels',
  '사이드탭 항목을 사용할 수 없습니다': 'Sidetab item unavailable', '사이드탭 메뉴 닫힘': 'Sidetab menu closed',
  '그래프 사이드탭을 열 수 없습니다': 'Cannot open graph sidetab', '사이드탭 구획 순서 저장': 'Sidetab section order saved',
  '긴 셸 명령 계속 실행': 'Long shell continues', '셸 실행 상태 확인 중': 'Checking shell execution',
  '지금 제출 중': 'Submitting now', '응답 전환 뒤 입력 가능': 'Input available after turn transition',
  '도구 실행 상태 확인 중': 'Checking tool execution', '완료 뒤 순서대로 전송': 'Send in order when done',
  '입력 취소됨': 'Input cancelled', '작업 목록': 'Tasks',
  '작업 ID를 고유한 4자 이상 앞자리로 입력하세요': 'Enter a unique task ID prefix of at least 4 characters',
  '작업 중단 요청 실패': 'Task stop request failed', '압축 중': 'Compacting',
  '압축 완료': 'Compacted', '대화 압축 완료': 'Conversation compacted',
  '압축할 대화가 없습니다': 'No conversation to compact',
  '/resume <번호|id 앞자리> 로 이어 가기': '/resume <number|id prefix> to resume',
  '현재 대화를 찾을 수 없어 모델 설정을 적용하지 못했습니다': 'Conversation not found; model settings not applied',
  'provider 조회 중': 'Loading providers', 'provider 명령 완료': 'Provider command done',
  'provider 명령 취소됨': 'Provider command cancelled', '플러그인 초안 확인': 'Review plugin draft',
  '하니스 진행 중': 'Harness running', '하니스 명령 완료': 'Harness command done',
  'PgDn 나머지 명령·키 보기': 'PgDn more commands/keys', '현재 맥락 조회 중': 'Loading current context',
  '인터뷰 시간 초과': 'Interview timed out', '답변 없음': 'No answer', '인터뷰 답변 입력': 'Enter interview answer',
  'PgUp/PgDn 내용 보기': 'PgUp/PgDn view content', 'Enter 제출': 'Enter submit', 'Esc 보류': 'Esc defer',
  '인터뷰 답변 없음': 'No interview answer', '라운드 종료': 'Round ended', '인터뷰 답변 형식 오류': 'Invalid interview answer format',
  '인터뷰 답변 전달됨': 'Interview answer delivered', '인터뷰 보류': 'Interview deferred', '인터뷰 종료': 'Interview ended',
};

export function englishFooterText(value: string): string {
  // Error detail belongs to the caller, including any separator-shaped content.
  const errorPrefixes: readonly (readonly [string, string])[] = [
    ['압축 실패: ', 'Compaction failed: '], ['provider 실패: ', 'Provider failed: '],
    ['하니스 실패: ', 'Harness failed: '],
  ];
  const translateError = (text: string): string | null => {
    for (const [source, translated] of errorPrefixes) {
      if (text.startsWith(source)) return translated + text.slice(source.length);
    }
    const launchError = text.match(/^(shell|elanous|codex|claude|claude-code|hermes|grok|grok-build) 실행 실패: /);
    return launchError ? launchError[1] + ' launch failed: ' + text.slice(launchError[0].length) : null;
  };
  const error = translateError(value);
  if (error !== null) return error;
  const translateClause = (part: string): string => {
    if (Object.hasOwn(FOOTER_ENGLISH, part)) return FOOTER_ENGLISH[part] ?? part;
    if (/^첨부 경로 /.test(part)) return part.replace('첨부 경로 ', 'Attachments ');
    if (/^워크스페이스 전송 \d+\/\d+$/.test(part)) return part.replace('워크스페이스 전송 ', 'Workspace sent ');
    if (/^모델: /.test(part)) return part.replace('모델: ', 'Model: ');
    if (/^압축 \d+→\d+ 메시지$/.test(part)) return part.replace('압축 ', 'Compacted ').replace(' 메시지', ' messages');
    if (/^대기 \d+건을 입력칸으로$/.test(part)) return part.replace('대기 ', '').replace('건을 입력칸으로', ' queued drafts restored');
    // A200 ELN-MIDTURN-STEER footer clauses (English chrome · NEXT-TUI-UI-ENGLISH).
    if (/^조향 대기 \d+건$/.test(part)) return part.replace('조향 대기 ', '').replace('건', ' steer pending');
    if (part === '다음 도구 경계에 넣음') return 'joins at next tool boundary';
    if (part === '조향 반영') return 'Steer applied';
    if (/^작업 [\w-]+ 중단 요청$/.test(part)) return part.replace('작업 ', 'Task ').replace(' 중단 요청', ' stop requested');
    if (/^사이드탭 \d+번 항목 없음$/.test(part)) return part.replace('사이드탭 ', 'Sidetab item ').replace('번 항목 없음', ' not found');
    if (/^이전 = /.test(part)) return part === '이전 = 없음' ? 'previous = none' : part.replace('이전 = ', 'previous = ');
    if (/^응답 중에는 \/(?:new|compact|resume) [를을] 받지 않습니다$/.test(part)) return part.replace(/^응답 중에는 /, 'Cannot use ').replace(/ [를을] 받지 않습니다$/, ' during a turn');
    if (/^그래프 [^\s·]+\/[^\s·]+$/.test(part)) return part.replace('그래프 ', 'Graph ');
    if (value.startsWith('그래프 ') && / (시작|완료|실패|재시도)( \(\d+회\))?$/.test(part)) return part.replace(/ (시작|완료|실패|재시도)( \(\d+회\))?$/, (_, verb: '시작' | '완료' | '실패' | '재시도', attempt: string | undefined) => ' ' + ({ 시작: 'started', 완료: 'completed', 실패: 'failed', 재시도: 'retrying' }[verb] ?? verb) + (attempt?.replace('회', ' attempts') ?? ''));
    if (/^".*" 번호·앞자리에 맞는 대화 없음$/.test(part)) return part.replace(' 번호·앞자리에 맞는 대화 없음', ' matches no chat number/prefix');
    if (/^\d+ 메시지$/.test(part)) return part.replace(' 메시지', ' messages');
    if (/^대상 전환으로 /.test(part) && part.endsWith('에 보내지 않았습니다')) return part.replace('대상 전환으로 ', 'Target switched; input not sent to ').replace(/에 보내지 않았습니다$/, '');
    if (/^(?:shell|elanous|codex|claude|claude-code|hermes|grok|grok-build) 종료됨$/.test(part)) return part.slice(0, -' 종료됨'.length) + ' exited';
    if (/^(?:shell|elanous|codex|claude|claude-code|hermes|grok|grok-build) 사이드탭 PTY 실행$/.test(part)) return part.slice(0, -' 사이드탭 PTY 실행'.length) + ' sidetab PTY started';
    if (/^(?:shell|elanous|codex|claude|claude-code|hermes|grok|grok-build) PTY 실행 실패$/.test(part)) return part.slice(0, -' PTY 실행 실패'.length) + ' PTY launch failed';
    if (/^(?:shell|elanous|codex|claude|claude-code|hermes|grok|grok-build) 실행$/.test(part)) return part.slice(0, -' 실행'.length) + ' started';
    if (/^agent-mission 구독 경로 scrub 적용\(\d+개 env 제거\)$/.test(part)) return part.replace('agent-mission 구독 경로 scrub 적용(', 'agent-mission subscription scrub applied (').replace('개 env 제거)', ' env removed)');
    if (value.startsWith('그래프 ') && part === '시험') return 'dry run';
    return part;
  };
  const [head = '', ...tail] = value.split(' · ');
  const translatedHead = translateClause(head);
  // These producer templates have fixed chrome and explicitly positioned data slots.
  const sessionIdSlot = /^[\p{L}\p{N}_-]+$/u;
  if (head === '대화 이어 가기' && tail.length === 2 && sessionIdSlot.test(tail[0]!)
    && tail[1]!.startsWith('이전 = ') && sessionIdSlot.test(tail[1]!.slice('이전 = '.length))) {
    return [translatedHead, tail[0], translateClause(tail[1]!)].join(' · ');
  }
  if (value === '원격 PTY 화면 · t takeover · Ctrl+\\ 후 ↑/↓ 전환'
    || value === 'Herdr pane 관측 · t takeover · Esc / Ctrl+\\ 복귀 · Ctrl+Q 전체 종료 (Ctrl+[는 Esc로 읽힐 수 있음)') {
    return [translatedHead, ...tail.map(translateClause)].join(' · ');
  }
  // Recognizing a word inside an otherwise unknown status is not enough.
  if (translatedHead === head && head !== 'Herdr pane takeover') return value;
  const opaqueDetailHeaders = new Set([
    '도구 실행 실패', '미션 관찰 오류', '미션 확인 실패', '측정 불가',
    'PTY 해제 실패', 'PTY 입력 결과 불명(전송 여부 확인 불가)', 'PTY 원격 작업 실패',
    'Herdr 입력 실패', 'Herdr pane 읽기 실패', 'PTY 화면 읽기 실패', 'PTY 화면 읽기 오류',
    'PTY 종료 거부', 'PTY 종료 오류', 'takeover 오류', '워크스페이스 입력 중지', '워크스페이스 방송 중지',
  ]);
  if (opaqueDetailHeaders.has(head)) return translatedHead + value.slice(head.length);
  const translatedTail: string[] = [];
  for (let index = 0; index < tail.length; index++) {
    const part = tail[index]!;
    const remaining = tail.slice(index).join(' · ');
    const error = translateError(remaining);
    if (error !== null) return [translatedHead, ...translatedTail, error].join(' · ');
    if (opaqueDetailHeaders.has(part)) return [translatedHead, ...translatedTail, translateClause(part), ...tail.slice(index + 1)].join(' · ');
    const translated = translateClause(part);
    if (translated === part) return [translatedHead, ...translatedTail, remaining].join(' · ');
    translatedTail.push(translated);
  }
  return [translatedHead, ...translatedTail].join(' · ');
}

function takeCells(value: string, cells: number): string {
  if (cells <= 0) return '';
  let result = '';
  let used = 0;
  for (const { segment } of segmenter.segment(value)) {
    const width = Bun.stringWidth(segment);
    if (used + width > cells) break;
    result += segment;
    used += width;
  }
  return result;
}

function modelWithoutProvider(value: string): string {
  const cleanValue = clean(value) || '?';
  const slash = cleanValue.lastIndexOf('/');
  return slash >= 0 ? cleanValue.slice(slash + 1) || '?' : cleanValue;
}

/** Did the turn state say it failed or was cancelled (the meaning every footer form keeps)? */
function turnOutcome(state: string): { readonly failed: boolean; readonly cancelled: boolean } {
  const stateHead = state.split(' · ')[0] ?? '';
  const knownLabel = Object.hasOwn(FOOTER_ENGLISH, stateHead) ? FOOTER_ENGLISH[stateHead] ?? '' : '';
  const failed = /\bfailed\b/i.test(knownLabel) || /^(?:실패|fail|failed)$/i.test(stateHead)
    || /^(?:압축|provider|하니스) 실패: /.test(stateHead)
    || /^(?:shell|elanous|codex|claude|claude-code|hermes|grok|grok-build) 실행 실패: /.test(stateHead);
  const cancelled = /\bcancell?ed\b|\bcancelling\b/i.test(knownLabel) || /^(?:취소|cancel|cancelled|canceled)$/i.test(stateHead);
  return { failed, cancelled };
}

function shortDuration(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * The short footer pieces (STATUSLINE-WIRE · OP 11-17 priority): the turn as one glyph-led clause
 * (`● running 3m` · `○ idle` · `✗ failed` · `■ cancelled`), whether it is an exception (failed), the model without its
 * provider, and the rest as counters with the tokens (`Q0·B0` · `S1·Q2·B0·14/6t`). The full sentence stays for wide
 * footers and /status.
 */
export function nextTuiShortStatus(input: NextTuiStatusLineInput): { readonly turn: string; readonly exception: boolean; readonly model: string; readonly rest: string } {
  const state = clean(input.turnState) || 'idle';
  const { failed, cancelled } = turnOutcome(state);
  const head = state.split(' · ')[0] ?? state;
  // A known phase becomes one word (+ how long); any other state is information (an approval outcome, a new chat id)
  // and stays whole, in English — the footer cuts it at its end only when the cwd and the version need the room.
  const phase = Object.hasOwn(TURN_PHASES, head) ? TURN_PHASES[head]! : Object.hasOwn(ENGLISH_PHASES, head) ? ENGLISH_PHASES[head]! : undefined;
  const idle = phase === 'idle' || phase === 'done';
  const elapsed = input.elapsedMs !== undefined && phase !== undefined && !idle ? ` ${shortDuration(input.elapsedMs)}` : '';
  // A bare outcome word is said in English; an outcome with its detail keeps the detail (in English where known).
  const bareOutcome = /^(?:실패|fail|failed|취소|cancel|cancelled|canceled)$/i.test(head);
  const text = phase ?? (bareOutcome ? (failed ? 'failed' : 'cancelled') : (englishFooterText(state) || state));
  const turn = `${failed ? '✗' : cancelled ? '■' : idle ? '○' : '●'} ${text}${elapsed}`;
  const modelValue = clean(input.model) || '?';
  const queued = Math.max(0, Math.floor(input.queued));
  const steering = Math.min(queued, Math.max(0, Math.floor(input.steering ?? 0)));
  const queue = steering > 0 ? `S${steering}·Q${queued - steering}` : `Q${queued}`;
  // Tokens join the counters whenever the old footer would show them (a turn with telemetry), in its compact form.
  const tokens = input.elapsedMs !== undefined ? `·${tokenTelemetry(input.measuredUsage, input.estimatedOutputTokens, true)}` : '';
  return { turn, exception: failed, model: modelWithoutProvider(modelValue === 'auto/미설정' ? 'auto/unset' : modelValue),
    rest: `${queue}·B${Math.max(0, Math.floor(input.backgroundTasks))}${tokens}` };
}

/** One-line status with compact labels and failure/cancellation meaning preserved. */
export function formatNextTuiStatusLine(input: NextTuiStatusLineInput): string {
  const width = Math.max(1, Math.floor(input.width));
  const state = clean(input.turnState) || 'idle';
  const shortState = width <= 32 && state.split(' · ')[0] === '응답 중' ? 'running' : compactState(state);
  const modelValue = clean(input.model) || '?';
  const model = modelValue === 'auto/미설정' ? 'auto/unset' : modelValue;
  const shortModel = modelWithoutProvider(model);
  const queued = Math.max(0, Math.floor(input.queued));
  const steering = Math.min(queued, Math.max(0, Math.floor(input.steering ?? 0)));
  // Contract «조향 n · 대기 n» in the English footer (#37922); unchanged «Queue n» while nothing steers.
  const queueLong = steering > 0 ? `Steer ${steering} · Queue ${queued - steering}` : `Queue ${queued}`;
  const queueShort = steering > 0 ? `S${steering}·Q${queued - steering}` : `Q${queued}`;
  const backgroundTasks = Math.max(0, Math.floor(input.backgroundTasks));
  const telemetry = turnTelemetry(input.elapsedMs, input.measuredUsage, false, input.estimatedOutputTokens);
  const shortTelemetry = turnTelemetry(input.elapsedMs, input.measuredUsage, true, input.estimatedOutputTokens);
  const minimum = minimumTelemetry(input.elapsedMs, input.measuredUsage, input.estimatedOutputTokens);
  const stateHead = state.split(' · ')[0] ?? '';
  const { failed, cancelled } = turnOutcome(state);
  const metricState = failed ? 'fail' : cancelled ? 'cancel' : shortState;
  const candidates = [
    ...(telemetry ? [
      `Turn ${shortState} · Model ${model} · ${telemetry} · ${queueLong} · Bg ${backgroundTasks}`,
      `Turn ${shortState} · ${shortModel} · ${telemetry} · ${queueShort} · B${backgroundTasks}`,
      `Turn ${shortState} · ${shortTelemetry} · ${queueShort} · B${backgroundTasks}`,
      `${shortState} · ${shortTelemetry} · ${queueShort} · B${backgroundTasks}`,
      `Turn ${metricState} · ${minimum} · ${queueShort} · B${backgroundTasks}`,
      `${metricState}·${minimum}·${queueShort}·B${backgroundTasks}`,
      ...(input.measuredUsage?.inputTokens !== undefined && input.measuredUsage?.outputTokens !== undefined
        ? [`${input.measuredUsage.inputTokens}/${input.measuredUsage.outputTokens}t${smallestElapsed(input.elapsedMs!)}`,
          `${metricState}·${input.measuredUsage.inputTokens}/${input.measuredUsage.outputTokens}t`]
        : []),
      ...(input.measuredUsage?.outputTokens === undefined && input.estimatedOutputTokens !== undefined
        && Number.isSafeInteger(input.estimatedOutputTokens) && input.estimatedOutputTokens >= 0
        ? [`${tokenTelemetry(input.measuredUsage, input.estimatedOutputTokens, true)}·${smallestElapsed(input.elapsedMs!)}`,
          `${metricState}·${tokenTelemetry(input.measuredUsage, input.estimatedOutputTokens, true)}`,
          tokenTelemetry(input.measuredUsage, input.estimatedOutputTokens, true)]
        : []),
    ] : []),
    `Turn ${shortState} · Model ${model} · ${queueLong} · Bg ${backgroundTasks}`,
    `Turn ${shortState} · Model ${shortModel} · ${queueLong} · Bg ${backgroundTasks}`,
    `Turn ${shortState} · ${shortModel} · ${queueShort} · B${backgroundTasks}`,
    `${shortState} · ${shortModel} · ${queueShort} · B${backgroundTasks}`,
    `${shortState} · ${shortModel} · ${queueShort} · B${backgroundTasks}`,
  ];
  const fits = candidates.find((candidate) => Bun.stringWidth(candidate) <= width);
  // ELN-QUEUE-ITEM-CONTROLS: «조향 대기 n건 · 다음 도구 경계에 넣음» reads in full where it fits. Where only a counter-less
  // line would fit, the turn is simply running and the S/Q counter carries the steer, so the counter is kept instead.
  if (steering > 0 && /^조향 대기 \d+건$/u.test(stateHead) && !(fits ?? '').includes(queueShort) && !(fits ?? '').includes(queueLong))
    return formatNextTuiStatusLine({ ...input, turnState: '응답 중' });
  if (fits) return fits;

  const suffix = `·${queueShort}·B${backgroundTasks}`;
  const fallbackState = failed ? 'fail' : cancelled ? 'cancel' : shortState;
  const firstModel = [...segmenter.segment(shortModel)][0]?.segment ?? '?';
  const stateWithModelInitial = `${fallbackState}·${firstModel}${suffix}`;
  const preserveOutcome = failed || cancelled;
  if (preserveOutcome) {
    const outcomeWithModel = `${fallbackState}·${shortModel}${suffix}`;
    if (Bun.stringWidth(outcomeWithModel) <= width) return outcomeWithModel;
    if (Bun.stringWidth(stateWithModelInitial) <= width) return stateWithModelInitial;
    const stateWithCounters = `${fallbackState}${suffix}`;
    if (Bun.stringWidth(stateWithCounters) <= width) return stateWithCounters;
    return takeCells(fallbackState, width);
  }
  if (Bun.stringWidth(stateWithModelInitial) <= width) return stateWithModelInitial;

  const stateRoomWithModel = width - Bun.stringWidth(shortModel) - Bun.stringWidth(suffix) - Bun.stringWidth('·');
  if (stateRoomWithModel > 0) {
    const visibleState = takeCells(fallbackState, stateRoomWithModel);
    if (visibleState) return `${visibleState}·${shortModel}${suffix}`;
  }
  const initialAndCountersWidth = Bun.stringWidth(`·${firstModel}${suffix}`);
  const stateRoomWithInitial = width - initialAndCountersWidth;
  if (stateRoomWithInitial > 0 && Bun.stringWidth(shortState) > stateRoomWithInitial) {
    const clippedState = stateRoomWithInitial > 1
      ? `${takeCells(shortState, stateRoomWithInitial - 1)}…`
      : takeCells(shortState, stateRoomWithInitial);
    if (clippedState) return `${clippedState}·${firstModel}${suffix}`;
  }
  const stateWithCounters = `${fallbackState}${suffix}`;
  if (Bun.stringWidth(stateWithCounters) <= width) return stateWithCounters;

  const stateCells = Bun.stringWidth(fallbackState);
  const finalStateRoom = Math.max(0, width - Bun.stringWidth(suffix));
  const finalState = stateCells > finalStateRoom && finalStateRoom > 0
    ? `${takeCells(fallbackState, Math.max(0, finalStateRoom - 1))}…`
    : takeCells(fallbackState, finalStateRoom);
  const minimumBody = `${finalState}${suffix}`;
  return Bun.stringWidth(minimumBody) <= width ? minimumBody : takeCells(suffix, width);
}

/** State-first compact footer used by the standard Next TUI status contract. */
export function nextTuiStatusLine(input: NextTuiCompactStatusLineInput): string {
  const state = englishFooterText(safeStatusText(input.state)).trim();
  const model = input.model ? safeStatusText(input.model).trim() : '';
  const parts = [
    state,
    turnTelemetry(input.elapsedMs, input.measuredUsage, true, input.estimatedOutputTokens),
    model,
    input.queued > 0 ? ((input.steering ?? 0) > 0
      ? `Steer ${Math.min(input.queued, input.steering!)} · Queue ${input.queued - Math.min(input.queued, input.steering!)}`
      : `Queue ${input.queued}`) : '',
    input.activeChildren > 0 ? `Children ${input.activeChildren}` : '',
  ].filter(Boolean);
  const fits = (value: string) => Bun.stringWidth(value) <= Math.max(1, input.columns);
  while (parts.length > 1 && !fits(parts.join(' · '))) parts.pop();
  return fitLogLine(parts.join(' · '), input.columns);
}
