// 🪪 L0 정체성 — 자리 로컬 지시(`AGENTS.local.md` · 호환 `CLAUDE.local.md`) ⊕ 루트→cwd 계층.
// 설계 = seat-state/OPC/PLAN-tui-self-awareness-2026-10-14 §A L0.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_ANCHOR_LOCAL_CANDIDATES,
  PROJECT_ANCHOR_LOCAL_LEAN_MAX_CHARS,
  PROJECT_ANCHOR_LOCAL_MAX_CHARS,
  PROJECT_ANCHOR_MAX_CHARS,
  buildUniversalPreamble,
  loadProjectAnchor,
  loadProjectAnchorWithMeta,
  resetUniversalPreambleCache,
  setGlobalAnchorPathForTest,
} from '../src/prompt-library/universal-preamble.js';
import { debug } from '../src/debug/log.js';

let root: string;

beforeEach(() => {
  setGlobalAnchorPathForTest(null); // 실제 ~/.elanous/AGENTS.md 가 있는 기계에서도 파일 목록 단언이 서게
  root = mkdtempSync(join(tmpdir(), 'elanous-anchor-local-'));
  mkdirSync(join(root, '.git'));
  resetUniversalPreambleCache();
});

afterEach(() => {
  setGlobalAnchorPathForTest(undefined);
  rmSync(root, { recursive: true, force: true });
  resetUniversalPreambleCache();
});

describe('자리 로컬 지시 — L0 정체성', () => {
  test('후보 순서: AGENTS.local.md 가 1순위, CLAUDE.local.md 는 호환', () => {
    expect(PROJECT_ANCHOR_LOCAL_CANDIDATES.map(c => c.filename)).toEqual(['AGENTS.local.md', 'CLAUDE.local.md']);
  });

  test('루트만 — 로컬 파일이 없으면 종전과 같고 absent 소음도 없다', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# shared\n');
    const result = loadProjectAnchorWithMeta(root);
    expect(result.files.map(f => f.filename)).toEqual(['AGENTS.md']);
    expect(result.skipped.some(s => s.filename.endsWith('.local.md'))).toBe(false);
  });

  test('cwd 하위 — 루트→cwd 순서로 공용 조각, 그 뒤 로컬 지시가 맨 끝', () => {
    const seat = join(root, 'seats', 'OP');
    mkdirSync(seat, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), '# root guide\n');
    writeFileSync(join(seat, 'AGENTS.md'), '# seat guide\n');
    writeFileSync(join(seat, 'AGENTS.local.md'), '# 너는 OP 다\n');
    const result = loadProjectAnchorWithMeta(seat);
    expect(result.files.map(f => [f.filename, f.relDir, f.local ?? false])).toEqual([
      ['AGENTS.md', '../..', false],
      ['AGENTS.md', '', false],
      ['AGENTS.local.md', '', true],
    ]);
    const c = result.content!;
    expect(c.indexOf('# root guide')).toBeLessThan(c.indexOf('# seat guide'));
    expect(c.indexOf('# seat guide')).toBeLessThan(c.indexOf('# 너는 OP 다'));
  });

  test('CLAUDE.local.md 호환 — AGENTS.local.md 가 없을 때 읽는다', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# shared\n');
    writeFileSync(join(root, 'CLAUDE.local.md'), '# 자리 OPC\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# 공용 claude\n');
    const result = loadProjectAnchorWithMeta(root);
    expect(result.files.map(f => f.filename)).toEqual(['AGENTS.md', 'CLAUDE.local.md']);
    expect(result.content).toContain('# 자리 OPC');
    // 공용 CLAUDE.md 는 여전히 정책 제외
    expect(result.content).not.toContain('# 공용 claude');
    expect(result.skipped).toContainEqual({ filename: 'CLAUDE.md', relDir: '', reason: 'policy-excluded' });
  });

  test('둘 다 있으면 AGENTS.local.md 만 싣고 CLAUDE.local.md 는 shadowed', () => {
    writeFileSync(join(root, 'AGENTS.local.md'), '# agents local\n');
    writeFileSync(join(root, 'CLAUDE.local.md'), '# claude local\n');
    const result = loadProjectAnchorWithMeta(root);
    expect(result.content).toContain('# agents local');
    expect(result.content).not.toContain('# claude local');
    expect(result.skipped).toContainEqual({ filename: 'CLAUDE.local.md', relDir: '', reason: 'shadowed' });
  });

  test('예산 — 공용이 상한을 넘어도 로컬 지시는 따로 예산이라 빠지지 않는다', () => {
    writeFileSync(join(root, 'AGENTS.md'), 'A'.repeat(PROJECT_ANCHOR_MAX_CHARS + 100));
    writeFileSync(join(root, 'AGENTS.local.md'), '# 너는 OP 다\n');
    const result = loadProjectAnchorWithMeta(root);
    expect(result.files.find(f => f.filename === 'AGENTS.md')!.truncated).toBe(true);
    expect(result.files.find(f => f.filename === 'AGENTS.local.md')).toEqual(
      expect.objectContaining({ truncated: false, local: true }),
    );
    expect(result.content!.endsWith('=== end AGENTS.local.md ===')).toBe(true);
  });

  test('루트와 cwd 둘 다 로컬 — 싣는 순서는 루트→cwd(cwd 가 맨 끝)', () => {
    const seat = join(root, 'seats', 'OP');
    mkdirSync(seat, { recursive: true });
    writeFileSync(join(root, 'AGENTS.local.md'), '# root local\n');
    writeFileSync(join(seat, 'CLAUDE.local.md'), '# seat local\n');
    const result = loadProjectAnchorWithMeta(seat);
    expect(result.files.map(f => [f.filename, f.relDir])).toEqual([
      ['AGENTS.local.md', '../..'],
      ['CLAUDE.local.md', ''],
    ]);
    expect(result.content!.indexOf('# root local')).toBeLessThan(result.content!.indexOf('# seat local'));
  });

  test('④ 로컬은 자르지 않는다 — 로컬 상한을 넘으면 경고 관측 ⊕ 넘친 만큼 공용 예산이 준다', () => {
    writeFileSync(join(root, 'AGENTS.md'), 'A'.repeat(PROJECT_ANCHOR_MAX_CHARS));
    writeFileSync(join(root, 'AGENTS.local.md'), 'L'.repeat(PROJECT_ANCHOR_LOCAL_MAX_CHARS + 500));
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const origLog = debug.log;
    (debug as { log: unknown }).log = (category: string, event: string, data: Record<string, unknown>) => { events.push({ category, event, data }); };
    let result;
    try { result = loadProjectAnchorWithMeta(root); } finally { (debug as { log: unknown }).log = origLog; }
    const local = result.files.find(f => f.local)!;
    expect(local).toEqual(expect.objectContaining({ truncated: false, chars: PROJECT_ANCHOR_LOCAL_MAX_CHARS + 500, layer: 'local' }));
    const shared = result.files.find(f => f.filename === 'AGENTS.md')!;
    expect(shared.truncated).toBe(true);
    expect(shared.chars).toBeLessThanOrEqual(PROJECT_ANCHOR_MAX_CHARS - 500);
    expect(events.some(e => e.category === 'chat.project-anchor' && e.event === 'local-over-cap')).toBe(true);
  });

  test('lean 예산에서도 로컬은 자르지 않는다', () => {
    const prev = process.env.ELANOUS_PROMPT_BUDGET;
    process.env.ELANOUS_PROMPT_BUDGET = 'lean';
    try {
      writeFileSync(join(root, 'AGENTS.local.md'), 'L'.repeat(PROJECT_ANCHOR_LOCAL_LEAN_MAX_CHARS + 50));
      expect(loadProjectAnchorWithMeta(root).files.find(f => f.local)!.truncated).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_PROMPT_BUDGET;
      else process.env.ELANOUS_PROMPT_BUDGET = prev;
    }
  });

  test('캐시 — 로컬 파일을 새로 만들면 다음 조회에 반영된다', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# shared\n');
    expect(loadProjectAnchor(root).files.some(f => f.local)).toBe(false);
    writeFileSync(join(root, 'AGENTS.local.md'), '# 새 자리\n');
    expect(loadProjectAnchor(root).files.some(f => f.local)).toBe(true);
  });

  test('buildUniversalPreamble — 머리말이 로컬 우선을 말하고 관측에 anchorLocalFiles 가 남는다', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# shared\n');
    writeFileSync(join(root, 'AGENTS.local.md'), '# 너는 OP 다\n');
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const origLog = debug.log;
    const wasEnabled = debug.enabled;
    (debug as { log: unknown }).log = (category: string, event: string, data: unknown) => { events.push({ category, event, data }); };
    if (!wasEnabled) debug.setDiagEnabled(true);
    try {
      const msgs = buildUniversalPreamble({ cwd: root, enabledTools: ['Read'] });
      const anchor = msgs.find(m => (m.content as string).startsWith('## Project Anchor'))!.content as string;
      expect(anchor).toContain('Directory-local instructions');
      expect(anchor).toContain('YOUR OWN instruction file');
      expect(anchor).toContain('# 너는 OP 다');
    } finally {
      (debug as { log: unknown }).log = origLog;
      if (!wasEnabled) debug.setDiagEnabled(false);
    }
    const built = events.find(e => e.category === 'chat.universal-preamble' && e.event === 'built');
    expect(built?.data).toEqual(expect.objectContaining({
      anchorFiles: ['AGENTS.md', 'AGENTS.local.md'],
      anchorLocalFiles: ['AGENTS.local.md'],
    }));
  });

  test('자기 편집 관측 — 로컬 지시가 바뀌면(길이가 같아도) 다음 조회에서 edited 한 줄', () => {
    const path = join(root, 'AGENTS.local.md');
    writeFileSync(path, '# 역할 A\n');
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const origLog = debug.log;
    (debug as { log: unknown }).log = (category: string, event: string, data: Record<string, unknown>) => { events.push({ category, event, data }); };
    try {
      loadProjectAnchor(root);
      writeFileSync(path, '# 역할 B\n'); // 같은 길이
      const bumped = new Date(Date.now() + 5000);
      utimesSync(path, bumped, bumped);
      loadProjectAnchor(root);
      writeFileSync(path, '# 역할 B\n## 교훈\n- 한 줄\n');
      const bumped2 = new Date(Date.now() + 10000);
      utimesSync(path, bumped2, bumped2);
      expect(loadProjectAnchor(root).content).toContain('## 교훈');
    } finally {
      (debug as { log: unknown }).log = origLog;
    }
    const edited = events.filter(e => e.category === 'tui.local-instructions' && e.event === 'edited');
    expect(edited.map(e => [e.data.file, e.data.charsBefore, e.data.charsAfter])).toEqual([
      ['AGENTS.local.md', 7, 7],
      ['AGENTS.local.md', 7, 19],
    ]);    // 직전 판 백업 — 같은 폴더 .AGENTS.local.md.prev 한 벌(덮어쓰기)
    expect(edited.map(e => e.data.prevPath)).toEqual([join(root, '.AGENTS.local.md.prev'), join(root, '.AGENTS.local.md.prev')]);
    expect(readFileSync(join(root, '.AGENTS.local.md.prev'), 'utf8')).toBe('# 역할 B\n');
  });

  test('본문에 펜스 끝 줄(=== end …)이 있어도 그 뒤 편집을 잡고 백업은 직전 판 «전체»', () => {
    const path = join(root, 'AGENTS.local.md');
    const before = '# 역할\n=== end AGENTS.local.md ===\n꼬리 A\n';
    writeFileSync(path, before);
    const events: string[] = [];
    const origLog = debug.log;
    (debug as { log: unknown }).log = (category: string, event: string) => { if (category === 'tui.local-instructions') events.push(event); };
    try {
      loadProjectAnchor(root);
      writeFileSync(path, '# 역할\n=== end AGENTS.local.md ===\n꼬리 B\n'); // 같은 길이 · 펜스 뒤만 바뀜
      const bumped = new Date(Date.now() + 5000);
      utimesSync(path, bumped, bumped);
      loadProjectAnchor(root);
    } finally {
      (debug as { log: unknown }).log = origLog;
    }
    expect(events).toEqual(['edited']);
    expect(readFileSync(join(root, '.AGENTS.local.md.prev'), 'utf8')).toBe(before);
  });

  test('mtime 만 바뀐 touch 는 edited 가 아니고 백업도 안 만든다', () => {
    const path = join(root, 'AGENTS.local.md');
    writeFileSync(path, '# 역할 A\n');
    const events: string[] = [];
    const origLog = debug.log;
    (debug as { log: unknown }).log = (category: string, event: string) => { if (category === 'tui.local-instructions') events.push(event); };
    try {
      loadProjectAnchor(root);
      const bumped = new Date(Date.now() + 5000);
      utimesSync(path, bumped, bumped);
      loadProjectAnchor(root);
    } finally {
      (debug as { log: unknown }).log = origLog;
    }
    expect(events).toEqual([]);
    expect(existsSync(join(root, '.AGENTS.local.md.prev'))).toBe(false);
  });

  test('호환 CLAUDE.local.md 를 고치면 .CLAUDE.local.md.prev', () => {
    const path = join(root, 'CLAUDE.local.md');
    writeFileSync(path, '# 옛 지시\n');
    loadProjectAnchor(root);
    writeFileSync(path, '# 새 지시 — 더 길다\n');
    const bumped = new Date(Date.now() + 5000);
    utimesSync(path, bumped, bumped);
    loadProjectAnchor(root);
    expect(readFileSync(join(root, '.CLAUDE.local.md.prev'), 'utf8')).toBe('# 옛 지시\n');
  });

  test('처음 생긴 로컬 지시는 edited 가 아니다', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# shared\n');
    const events: string[] = [];
    const origLog = debug.log;
    (debug as { log: unknown }).log = (category: string, event: string) => { if (category === 'tui.local-instructions') events.push(event); };
    try {
      loadProjectAnchor(root);
      writeFileSync(join(root, 'AGENTS.local.md'), '# 새 자리\n');
      loadProjectAnchor(root);
    } finally {
      (debug as { log: unknown }).log = origLog;
    }
    expect(events).toEqual([]);
  });
});
