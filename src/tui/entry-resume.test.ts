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
import { resumeRowByNumber } from './slash/resume.js';
import { seedSessionWithId } from '../ux-sim/session-id-seed.js';

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
    expect(lines.find((l) => l.includes(other.slice(0, 8)))).toContain(`▸ ${other.slice(0, 8)}`);
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
      expect(log).toHaveBeenCalledWith('tui.next', 'session-resume', { from, to: target, by: 'prefix' });
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

describe('TUI-RESUME-PICKER — pick by number · ids that share their first 8 characters', () => {
  test('rows are numbered; /resume <n> resumes the n-th row the user saw', () => {
    const a = seed('첫째');
    const b = seed('둘째');
    const from = seed('지금 대화');
    setActiveSessionId(from);
    const rows = resumeCandidates(from);
    const lines = resumeListLines(rows, from);
    expect(lines[0]).toContain('/resume <번호>');
    rows.forEach((m, i) => expect(lines[i + 1]).toMatch(new RegExp(`^${i + 1}\\. [ ▸] ${m.id.slice(0, 8)}`)));
    const pick = rows.findIndex((m) => m.id === a) + 1;
    const log = spyOn(debug, 'log');
    try {
      expect(requestResumeTuiSession({ busy: false, from, prefix: String(pick), rows })).toMatchObject({ kind: 'started', id: a });
      expect(log).toHaveBeenCalledWith('tui.next', 'session-resume', { from, to: a, by: 'number' });
    } finally {
      log.mockRestore();
    }
    expect(getActiveSessionId()).toBe(a);
    expect(resumeRowByNumber(String(rows.findIndex((m) => m.id === b) + 1), rows)?.id).toBe(b);
  });

  test('a number outside the list, 0, or 4+ digits is not a row', () => {
    // A fixed id with no digit start: `9` falls back to a prefix lookup, which a random UUID would match 1 time in 16.
    const rows = resumeCandidates(seedSessionWithId('aaaa0000-0000-4000-8000-000000000009', '하나'));
    for (const arg of ['0', String(rows.length + 1), '1234', '1a']) expect(resumeRowByNumber(arg, rows)).toBeNull();
    expect(requestResumeTuiSession({ busy: false, from: null, prefix: '9', rows })).toMatchObject({ kind: 'rejected' });
  });

  test('colliding 8-char prefixes: the list shows longer unique prefixes and each one resumes its own session', () => {
    const ids = [
      seedSessionWithId('abcd1234-0001-4000-8000-000000000001', 'n8n 특강'),
      seedSessionWithId('abcd1234-0002-4000-8000-000000000002', 'RSS 재촬영'),
      seedSessionWithId('abcd1234-0002-4fff-8000-000000000003', '세 번째'),
    ];
    const from = seed('지금 대화');
    setActiveSessionId(from);
    const lines = resumeListLines(resumeCandidates(from), from);
    const expected = { [ids[0]!]: 'abcd1234-0001', [ids[1]!]: 'abcd1234-0002-40', [ids[2]!]: 'abcd1234-0002-4f' };
    for (const [id, prefix] of Object.entries(expected)) {
      expect(lines.some((l) => l.includes(` ${prefix} `))).toBe(true);
      setActiveSessionId(from);
      expect(requestResumeTuiSession({ busy: false, from, prefix })).toMatchObject({ kind: 'started', id });
    }
    // The old fixed 8-character cut is ambiguous — that was the bug.
    expect(requestResumeTuiSession({ busy: false, from, prefix: 'abcd1234' })).toMatchObject({ kind: 'rejected' });
  });

  test('the status line names both sessions by their unique prefix — daemon ids are not cut to «elanous-»', () => {
    const from = seedSessionWithId('elanous-session-c01bd3', '지금 대화');
    const to = seedSessionWithId('elanous-session-h7k2pq', '이어 갈 대화');
    setActiveSessionId(from);
    const r = requestResumeTuiSession({ busy: false, from, prefix: 'elanous-session-h' });
    expect(r).toMatchObject({ kind: 'started', id: to });
    expect(r.status).toBe('대화 이어 가기 · elanous-session-h · 이전 = elanous-session-c');
  });
});

