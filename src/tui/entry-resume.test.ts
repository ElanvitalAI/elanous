// 재현 — TUI-RESUME-PICKER(백로그 #16 · n8n 재기동 때 «/resume·/session list 가 화면에 안 뜸»).
// 라이브 격리 next TUI(10-23): `/resume` 이 처리기 없이 «채팅 턴»으로 모델에 가서
// «재개할 작업의 저장된 맥락을 확인하겠습니다…» 조사를 시작했다 — 대화 목록은 안 떴다.
// The store is the real session store pointed at a temp root.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { appendMessage, createSession, getActiveSessionId, setActiveSessionId } from '../session/index.js';
import { RESUME_BUSY_STATUS, parseResumeCommand, requestResumeTuiSession, resumeCandidates, resumeListLines } from './slash/resume.js';
import { isNewSessionCommand } from './slash/new-session.js';

let dir = '';
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'next-tui-resume-'));
  for (const key of ['ELANOUS_STATE_DIR', 'ELANOUS_SESSION_ROOT']) saved[key] = process.env[key];
  process.env.ELANOUS_STATE_DIR = dir;
  process.env.ELANOUS_SESSION_ROOT = join(dir, 'sessions');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function seed(title: string): string {
  const id = createSession({ source: 'tui', title }).id;
  appendMessage(id, { role: 'user', content: title, ts: new Date().toISOString() });
  appendMessage(id, { role: 'assistant', content: '답', ts: new Date().toISOString() });
  return id;
}

describe('TUI-RESUME-PICKER incident — next TUI sent «/resume» to the model', () => {
  test('the words the user typed are commands now, not chat text', () => {
    expect(parseResumeCommand('/resume')).toEqual({ kind: 'list' });
    expect(parseResumeCommand('/session list')).toEqual({ kind: 'list' });
    expect(parseResumeCommand('/session')).toEqual({ kind: 'list' });
    expect(parseResumeCommand('/resume ab12')).toEqual({ kind: 'load', prefix: 'ab12' });
    expect(parseResumeCommand('/session load ab12')).toEqual({ kind: 'load', prefix: 'ab12' });
  });

  test('/session new stays with /new; ordinary text and other slashes are not resume', () => {
    expect(parseResumeCommand('/session new')).toBeNull();
    expect(isNewSessionCommand('/session new')).toBe(true);
    for (const text of ['/resume a b', '/resumes', 'resume', '/session load', '/session fork', '이전 대화 /resume 해줘']) {
      expect(parseResumeCommand(text)).toBeNull();
    }
  });

  test('/resume lists the saved conversations with the active one marked', () => {
    const n8n = seed('n8n 특강 단계별 영상');
    const other = seed('다른 대화');
    const lines = resumeListLines(resumeCandidates(other), other);
    expect(lines[0]).toContain('최근 대화 2개');
    expect(lines.some((l) => l.includes(n8n.slice(0, 8)) && l.includes('n8n 특강 단계별 영상'))).toBe(true);
    expect(lines.find((l) => l.includes(other.slice(0, 8)))?.startsWith('▸')).toBe(true);
  });

  test('an empty store says so instead of showing nothing', () => {
    expect(resumeListLines(resumeCandidates(null), null)).toEqual(['저장된 대화 없음']);
  });
});

describe('requestResumeTuiSession', () => {
  test('idle: a unique prefix makes that session active and logs from→to', () => {
    const target = seed('n8n 특강');
    const from = seed('지금 대화');
    setActiveSessionId(from);
    const log = spyOn(debug, 'log');
    try {
      const result = requestResumeTuiSession({ busy: false, from, prefix: target.slice(0, 10) });
      expect(result).toMatchObject({ kind: 'started', id: target });
      expect(getActiveSessionId()).toBe(target);
      expect(log).toHaveBeenCalledWith('tui.next', 'session-resume', { from, to: target });
    } finally {
      log.mockRestore();
    }
  });

  test('busy, unknown prefix, and the current session are rejected without moving the active marker', () => {
    const from = seed('지금 대화');
    setActiveSessionId(from);
    expect(requestResumeTuiSession({ busy: true, from, prefix: from }).status).toBe(RESUME_BUSY_STATUS);
    expect(requestResumeTuiSession({ busy: false, from, prefix: 'zzzz-none' })).toMatchObject({ kind: 'rejected' });
    expect(requestResumeTuiSession({ busy: false, from, prefix: from })).toMatchObject({ kind: 'rejected' });
    expect(getActiveSessionId()).toBe(from);
  });
});
