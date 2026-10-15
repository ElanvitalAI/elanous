// 🪪 L2-lite — 자리 로컬 지시 생성(덮어쓰기 0) ⊕ «지난 세션» 이어쓰기 ⊕ 다음 기동 앵커로 이어짐.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LAST_SESSION_FILE,
  ensureSeatLocalInstructions,
  extractFirstPrinciple,
  installSeatSessionRecorder,
  markSeatConversationStarted,
  recordSeatSessionEnd,
  resetSessionRecorderForTest,
  seatDirFromCwd,
  summarizeSession,
  writeLastSession,
} from '../src/dashboard/seat-local-instructions.js';
import { PROJECT_ANCHOR_LAST_SESSION_MAX_CHARS, loadProjectAnchor, loadProjectAnchorWithMeta, resetUniversalPreambleCache, setGlobalAnchorPathForTest } from '../src/prompt-library/universal-preamble.js';

const AGENTS_FIXTURE = [
  '# Repository Collaboration Rules',
  '',
  '## ⭐ 제1원칙 — 자기 관측성 · 자기 인지 · 셀프 힐링',
  '> 인용 줄은 요지에서 뺀다',
  '',
  '**북극성**: 사람이 매 단계를 판단하는 게 아니라 **시스템이 스스로 수렴**한다.',
  '**자기 관측성**(자기 행동을 본다) → **자기 인지** → **셀프 힐링**.',
  '',
  '**넘버원 룰**: ①관측 기반 스스로 판단·힐링 → ②안 되면 HITL.',
  '',
  '⭐⭐ **문법 = `SCQA`** — `관측=S` · `자기인지=C·Q` · `셀프힐링=A`.',
  '',
  '## 다른 절',
  '여기는 안 들어간다',
].join('\n');

// 운영 자리 OPT 처럼 «사람이 쓴» 로컬 지시
const HUMAN_OPT = '# 이 자리 = OPT (OP 연습생 · 그림자 OP)\n\n너는 **OPT** 자리의 엘라누스 TUI 다.\n\n## ⛔ 절대 하지 않는 것\n- eln msg ack\n';

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'seat-local-'));
  home = join(root, 'home');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'AGENTS.md'), AGENTS_FIXTURE);
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'TEST'), { recursive: true });
  writeFileSync(join(home, 'elanous-hq', 'seat-state', 'TEST', 'README.md'), '# TEST 자리 정본\n- 역할: 시험 자리\n');
  mkdirSync(join(root, 'seats', 'TEST', 'sub'), { recursive: true });
  mkdirSync(join(root, 'seats', 'OPT'), { recursive: true });
  resetSessionRecorderForTest();
  resetUniversalPreambleCache();
  setGlobalAnchorPathForTest(null);
});

afterEach(() => {
  setGlobalAnchorPathForTest(undefined);
  rmSync(root, { recursive: true, force: true });
  resetSessionRecorderForTest();
  resetUniversalPreambleCache();
});

const now = () => new Date('2026-10-14T09:00:00.000Z');

describe('생성 — 자리 디렉터리에서 로컬 지시가 하나도 없을 때만', () => {
  test('seatDirFromCwd — 하위 디렉터리여도 자리 루트를 찾는다', () => {
    expect(seatDirFromCwd(join(root, 'seats', 'TEST', 'sub'))).toEqual({ seat: 'TEST', dir: join(root, 'seats', 'TEST') });
    expect(seatDirFromCwd(join(root, 'work'))).toBeNull();
  });

  test('템플릿 — 자리 이름 ⊕ README 머리 ⊕ 제1원칙 요지(출처 줄) ⊕ «## 시작하면»', () => {
    const r = ensureSeatLocalInstructions(join(root, 'seats', 'TEST', 'sub'), { home, now });
    expect(r.status).toBe('created');
    const text = readFileSync(join(root, 'seats', 'TEST', 'AGENTS.local.md'), 'utf8');
    expect(text).toContain('# TEST 자리 — 로컬 지시');
    expect(text).toContain('TEST 자리 정본');
    expect(text).toContain('## 제1원칙 (요지)');
    expect(text).toContain('정본 = 저장소 AGENTS.md §제1원칙');
    expect(text).toContain('**북극성**');
    expect(text).toContain('**넘버원 룰**');
    expect(text).toContain('문법 = `SCQA`');
    expect(text).not.toContain('여기는 안 들어간다');
    expect(text).not.toContain('인용 줄은 요지에서 뺀다');
    expect(text).toContain('## 시작하면');
    expect(text).toContain('eln msg list --to TEST');
  });

  test('운영 자리 OPT 처럼 사람이 쓴 AGENTS.local.md 는 덮어쓰지 않는다(바이트 그대로)', () => {
    const path = join(root, 'seats', 'OPT', 'AGENTS.local.md');
    writeFileSync(path, HUMAN_OPT);
    const r = ensureSeatLocalInstructions(join(root, 'seats', 'OPT'), { home, now });
    expect(r).toEqual({ status: 'exists', path, missingPrinciple: true });
    expect(readFileSync(path, 'utf8')).toBe(HUMAN_OPT);
  });

  test('생성 경쟁 — 호환 파일이 나타났고 우리 파일이 그대로면 거두고, 사람이 고쳤으면 지우지 않는다', () => {
    const dir = join(root, 'seats', 'TEST');
    ensureSeatLocalInstructions(dir, { home, now, afterCreateForTest: () => writeFileSync(join(dir, 'CLAUDE.local.md'), '# 사람\n') });
    expect(existsSync(join(dir, 'AGENTS.local.md'))).toBe(false);
    rmSync(join(dir, 'CLAUDE.local.md'));
    ensureSeatLocalInstructions(dir, {
      home,
      now,
      afterCreateForTest: (path) => {
        writeFileSync(join(dir, 'CLAUDE.local.md'), '# 사람\n');
        writeFileSync(path, '# 사람이 고친 AGENTS\n');
      },
    });
    expect(readFileSync(join(dir, 'AGENTS.local.md'), 'utf8')).toBe('# 사람이 고친 AGENTS\n');
  });

  test('대상이 없는 링크 CLAUDE.local.md 도 «있음» — AGENTS.local.md 를 만들지 않는다', () => {
    const dir = join(root, 'seats', 'TEST');
    symlinkSync(join(root, 'nowhere.md'), join(dir, 'CLAUDE.local.md'));
    expect(ensureSeatLocalInstructions(dir, { home, now }).status).toBe('exists');
    expect(existsSync(join(dir, 'AGENTS.local.md'))).toBe(false);
  });

  test('생성 직후 대상 없는 링크 CLAUDE.local.md 가 나타나도 «있음»으로 보고 우리 파일을 거둔다', () => {
    const dir = join(root, 'seats', 'TEST');
    ensureSeatLocalInstructions(dir, { home, now, afterCreateForTest: () => symlinkSync(join(root, 'nowhere.md'), join(dir, 'CLAUDE.local.md')) });
    expect(existsSync(join(dir, 'AGENTS.local.md'))).toBe(false);
  });

  test('CLAUDE.local.md 만 있어도 만들지 않는다(사람 파일을 shadowed 로 가리지 않게)', () => {
    writeFileSync(join(root, 'seats', 'TEST', 'CLAUDE.local.md'), '# 사람 지시\n');
    expect(ensureSeatLocalInstructions(join(root, 'seats', 'TEST'), { home, now }).status).toBe('exists');
    expect(existsSync(join(root, 'seats', 'TEST', 'AGENTS.local.md'))).toBe(false);
  });

  test('자리 디렉터리가 아니면(COORD_ID 만으로는) 만들지 않는다', () => {
    mkdirSync(join(root, 'work'));
    expect(ensureSeatLocalInstructions(join(root, 'work'), { home, now }).status).toBe('not-seat');
    expect(existsSync(join(root, 'work', 'AGENTS.local.md'))).toBe(false);
  });

  test('README 가 없으면 «미관측» 한 줄로 채운다', () => {
    mkdirSync(join(root, 'seats', 'ZZ'));
    ensureSeatLocalInstructions(join(root, 'seats', 'ZZ'), { home, now });
    expect(readFileSync(join(root, 'seats', 'ZZ', 'AGENTS.local.md'), 'utf8')).toContain('미관측: ~/elanous-hq/seat-state/ZZ/README.md 없음');
  });

  test('이 저장소 AGENTS.md 에서도 제1원칙 요지가 뽑힌다', () => {
    const real = readFileSync(join(import.meta.dir, '..', 'AGENTS.md'), 'utf8');
    const principle = extractFirstPrinciple(real);
    expect(principle).toContain('북극성');
    expect(principle).toContain('넘버원 룰');
    expect(principle).toContain('SCQA');
  });
});

describe('«지난 세션» 이어쓰기', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '우편 정리해 줘' },
    { role: 'assistant', content: '우편 3통을 읽었다.\n- 남은 일: #27494 착지 대기\n- 다음 점검 18:30' },
    { role: 'user', content: [{ type: 'text', text: '좋아, 마무리' }] },
    { role: 'assistant', content: [{ type: 'text', text: '정리했다.\n이어서 할 일: OP 우편 답장 · 19:00 재확인' }] },
  ];

  test('summarizeSession — 5줄 이내 · 마지막 요청·답 요지·열린 일·다음 점검 시각', () => {
    const lines = summarizeSession(history, { endedAt: 'T', reason: 'exit' })!;
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toBe('- 끝: T · exit · 사람 턴 2');
    expect(lines[1]).toBe('- 마지막 요청: 좋아, 마무리');
    expect(lines[2]).toBe('- 마지막 답 요지: 정리했다.');
    expect(lines[3]).toContain('이어서 할 일: OP 우편 답장 · 19:00 재확인');
    expect(lines[4]).toBe('- 다음 점검 시각(답에서): 19:00');
  });

  test('대시보드 사람 턴 감싸개(Context: … Question:)는 벗기고 질문만 적는다', () => {
    const wrapped = [{ role: 'user', content: 'Context:\nDashboard mode: browse\nRecent status output:\nx\n\nQuestion: 우편 정리해 줘' }];
    expect(summarizeSession(wrapped, { endedAt: 'T', reason: 'exit' })![1]).toBe('- 마지막 요청(답 없이 끝남 — 이어서 처리할 일): 우편 정리해 줘');
  });

  test('사람 턴이 없으면 쓸 것이 없다', () => {
    expect(summarizeSession([{ role: 'system', content: 'x' }], { endedAt: 'T', reason: 'exit' })).toBeNull();
  });

  test('마지막 요청에 답하기 전에 끝났으면 그 앞 답을 이 요청의 답처럼 적지 않는다', () => {
    const lines = summarizeSession([...history, { role: 'user', content: '새 요청인데 답 전에 나감' }], { endedAt: 'T', reason: 'exit' })!;
    expect(lines[1]).toBe('- 마지막 요청(답 없이 끝남 — 이어서 처리할 일): 새 요청인데 답 전에 나감');
    expect(lines[2]).toBe('- 그 전 답 요지: 정리했다.');
    expect(lines[3]).toContain('(그 전 답에서 — 마지막 요청의 후속이 아니다)');
    expect(lines[4]).toBe('- 다음 점검 시각(그 전 답에서): 19:00');
  });

  const lastPath = (dir: string) => join(dir, LAST_SESSION_FILE);

  test('«지난 세션»은 TUI 소유 별도 파일에 — 사람 지시 파일은 바이트 하나 안 바뀐다', () => {
    const dir = join(root, 'seats', 'OPT');
    const human = join(dir, 'AGENTS.local.md');
    writeFileSync(human, HUMAN_OPT);
    const before = statSync(human).mtimeMs;
    expect(writeLastSession(dir, history, 'exit', { now })).toBe('written');
    expect(readFileSync(human, 'utf8')).toBe(HUMAN_OPT);
    expect(statSync(human).mtimeMs).toBe(before);
    const text = readFileSync(lastPath(dir), 'utf8');
    expect(text.startsWith('## 지난 세션')).toBe(true);
    expect(text).toContain('- 마지막 요청: 좋아, 마무리');
    expect(statSync(lastPath(dir)).mode & 0o777).toBe(0o600);
  });

  test('로컬 지시 파일이 없는 자리에도 쓴다(사람 파일과 무관)', () => {
    expect(writeLastSession(join(root, 'seats', 'TEST', 'sub'), history, 'exit', { now })).toBe('written');
    expect(existsSync(lastPath(join(root, 'seats', 'TEST')))).toBe(true);
    expect(existsSync(join(root, 'seats', 'TEST', 'AGENTS.local.md'))).toBe(false);
  });

  test('자리가 아니면 쓰지 않는다', () => {
    mkdirSync(join(root, 'work'));
    expect(writeLastSession(join(root, 'work'), history, 'exit', { now })).toBe('skipped');
    expect(readdirSync(join(root, 'work'))).toEqual([]);
  });

  test('recorder — exit 에서 한 번 · /session new 뒤 새 대화는 다시 쓴다(갈아 쓰기)', () => {
    const seatDir = join(root, 'seats', 'TEST');
    let exitFn: (() => void) | null = null;
    let current: Array<{ role: string; content: unknown }> = [...history];
    installSeatSessionRecorder({ getCwd: () => seatDir, getHistory: () => current, onExit: fn => { exitFn = fn; } });
    recordSeatSessionEnd('session-new');
    const afterNew = readFileSync(lastPath(seatDir), 'utf8');
    expect(afterNew).toContain('session-new');
    recordSeatSessionEnd('exit'); // 같은 대화 — 두 번 쓰지 않는다
    expect(readFileSync(lastPath(seatDir), 'utf8')).toBe(afterNew);
    markSeatConversationStarted();
    current = [{ role: 'user', content: '두 번째 대화' }, { role: 'assistant', content: '받았다' }];
    exitFn!();
    const afterExit = readFileSync(lastPath(seatDir), 'utf8');
    expect(afterExit).toContain('- 마지막 요청: 두 번째 대화');
    expect(afterExit).not.toContain('좋아, 마무리');
  });

  test('기록 대상은 대화 시작 때 고정 — 도중 cwd 를 옮겨도 시작한 자리에 쓴다', () => {
    const seatDir = join(root, 'seats', 'TEST');
    let cwd = seatDir;
    installSeatSessionRecorder({ getCwd: () => cwd, getHistory: () => history, onExit: () => {} });
    cwd = join(root, 'seats', 'OPT');
    recordSeatSessionEnd('exit');
    expect(existsSync(lastPath(seatDir))).toBe(true);
    expect(existsSync(lastPath(cwd))).toBe(false);
  });

  test('임시 파일은 예측되지 않고 남지 않는다 · 같은 이름 링크를 따라가지 않는다', () => {
    const dir = join(root, 'seats', 'OPT');
    const decoy = join(root, 'decoy.md');
    writeFileSync(decoy, 'decoy');
    symlinkSync(decoy, `${lastPath(dir)}.tmp-${process.pid}`);
    expect(writeLastSession(dir, history, 'exit', { now })).toBe('written');
    expect(readFileSync(decoy, 'utf8')).toBe('decoy');
    expect(readdirSync(dir).filter(n => n.includes('.tmp-') && n !== `${LAST_SESSION_FILE}.tmp-${process.pid}`)).toEqual([]);
  });

  test('다음 기동 — L0 앵커 로더가 «지난 세션»을 로컬 지시 «뒤» 조각으로 싣는다', () => {
    const seatDir = join(root, 'seats', 'TEST');
    ensureSeatLocalInstructions(seatDir, { home, now });
    writeLastSession(seatDir, history, 'exit', { now });
    const anchor = loadProjectAnchorWithMeta(seatDir);
    expect(anchor.files.map(f => f.layer).slice(-2)).toEqual(['local', 'last-session']);
    expect(anchor.content).toContain('- 마지막 요청: 좋아, 마무리');
    expect(anchor.content!.indexOf('=== end AGENTS.local.md')).toBeLessThan(anchor.content!.indexOf('- 마지막 요청: 좋아, 마무리'));
  });
});

describe('L0 로더의 last-session 조각', () => {
  const seatDir = () => join(root, 'seats', 'TEST');
  test('링크면 싣지 않는다(바깥 파일 주입 차단)', () => {
    const outside = join(root, 'outside-secret.md');
    writeFileSync(outside, 'OUTSIDE-SECRET-91f\n');
    symlinkSync(outside, join(seatDir(), LAST_SESSION_FILE));
    const anchor = loadProjectAnchorWithMeta(seatDir());
    expect(anchor.content ?? '').not.toContain('OUTSIDE-SECRET-91f');
    expect(anchor.skipped).toContainEqual({ filename: LAST_SESSION_FILE, relDir: '', reason: 'read-failed' });
  });

  test('2K 상한에서 자른다', () => {
    writeFileSync(join(seatDir(), LAST_SESSION_FILE), 'S'.repeat(5000));
    const meta = loadProjectAnchorWithMeta(seatDir()).files.find(f => f.layer === 'last-session')!;
    expect(meta.truncated).toBe(true);
    expect(meta.chars).toBeLessThanOrEqual(PROJECT_ANCHOR_LAST_SESSION_MAX_CHARS);
  });

  test('캐시 — 파일이 갈아 쓰이면 다음 조회에 새 문면', () => {
    const path = join(seatDir(), LAST_SESSION_FILE);
    writeFileSync(path, '## 지난 세션\n- 첫째\n');
    expect(loadProjectAnchor(seatDir()).content).toContain('- 첫째');
    writeFileSync(path, '## 지난 세션\n- 둘째\n');
    const bumped = new Date(Date.now() + 5000);
    utimesSync(path, bumped, bumped);
    expect(loadProjectAnchor(seatDir()).content).toContain('- 둘째');
  });

  test('기록 실패(그 이름이 디렉터리라 rename 불가)여도 예외 없이 skipped — 종료를 막지 않는다', () => {
    const dir = seatDir();
    mkdirSync(join(dir, LAST_SESSION_FILE));
    writeFileSync(join(dir, LAST_SESSION_FILE, 'keep'), 'x');
    expect(() => writeLastSession(dir, [{ role: 'user', content: 'x' }], 'exit', { now })).not.toThrow();
    expect(writeLastSession(dir, [{ role: 'user', content: 'x' }], 'exit', { now })).toBe('skipped');
    expect(readdirSync(dir).filter(n => n.includes('.tmp-'))).toEqual([]);
  });

  test('자리 밖 cwd 는 같은 이름 파일이 있어도 싣지 않는다', () => {
    mkdirSync(join(root, 'work'), { recursive: true });
    writeFileSync(join(root, 'work', LAST_SESSION_FILE), 'NOT-A-SEAT-44a\n');
    expect(loadProjectAnchorWithMeta(join(root, 'work')).content ?? '').not.toContain('NOT-A-SEAT-44a');
  });

  test('자리 «루트» 파일 하나만 — 자리 하위 cwd 에서도 루트 것을 싣고, 상위·하위 디렉터리 것은 안 싣는다', () => {
    writeFileSync(join(root, LAST_SESSION_FILE), 'ANCESTOR-77b\n');
    writeFileSync(join(seatDir(), 'sub', LAST_SESSION_FILE), 'SUBDIR-12c\n');
    writeFileSync(join(seatDir(), LAST_SESSION_FILE), 'SEAT-ROOT-5e0\n');
    const content = loadProjectAnchorWithMeta(join(seatDir(), 'sub')).content ?? '';
    expect(content).toContain('SEAT-ROOT-5e0');
    expect(content).not.toContain('ANCESTOR-77b');
    expect(content).not.toContain('SUBDIR-12c');
  });
});

describe('실제 /session clear 핸들러 경로', () => {
  test('dispatch(session clear) → 비우기 전 그 자리 last-session 에 session-clear 기록 ⊕ history 비움', async () => {
    const { buildDashboardSlashRegistry } = await import('../src/dashboard/slash-runtime/dashboard-handlers.js');
    const seatDir = join(root, 'seats', 'TEST');
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: '세션 정리 전 요청' },
      { role: 'assistant', content: '- 남은 일: 클리어 시험' },
    ];
    installSeatSessionRecorder({ getCwd: () => seatDir, getHistory: () => history, onExit: () => {} });
    const lines: string[] = [];
    const id = (t: string) => t;
    const ctx = {
      chatLines: lines,
      pushChatLine: (l: string) => { lines.push(l); },
      accent: id, warning: id, error: id, success: id, muted: id, text: id,
      setChatScrollOffset: () => {},
      draw: () => {},
      getAttachedSessionId: () => null,
      setAttachedSessionId: () => {},
      setAttachedChatId: () => {},
      compactSlash: { chatHistory: history },
      sessionSlash: { remoteDaemon: () => null },
    } as unknown as Parameters<ReturnType<typeof buildDashboardSlashRegistry>['dispatch']>[2];
    await buildDashboardSlashRegistry().dispatch('session', ['clear'], ctx);
    const text = readFileSync(join(seatDir, LAST_SESSION_FILE), 'utf8');
    expect(text).toContain('session-clear');
    expect(text).toContain('- 마지막 요청: 세션 정리 전 요청');
    expect(history).toEqual([]);
  }, 60_000);
});

describe('배선 — 대시보드 호출부', () => {
  test('기동 때 생성·recorder 설치, /session new·clear 는 비우기 «전»에 기록', () => {
    const index = readFileSync(join(import.meta.dir, '../src/dashboard/index.ts'), 'utf8');
    expect(index).toContain('const seatLocal = ensureSeatLocalInstructions(getSessionCwd());');
    expect(index).toContain('installSeatSessionRecorder({ getCwd: () => getSessionCwd(), getHistory: () => chat.history });');
    const handlers = readFileSync(join(import.meta.dir, '../src/dashboard/slash-runtime/dashboard-handlers.ts'), 'utf8');
    const branch = handlers.slice(handlers.indexOf("if (seSub === 'new' || seSub === 'clear')"), handlers.indexOf("if (seSub === 'fork')"));
    const record = branch.indexOf("recordSeatSessionEnd(seSub === 'new' ? 'session-new' : 'session-clear')");
    expect(record).toBeGreaterThan(0);
    expect(record).toBeLessThan(branch.indexOf('chatHistory.length = 0'));
    expect(branch).toContain('markSeatConversationStarted();');
  });
});
