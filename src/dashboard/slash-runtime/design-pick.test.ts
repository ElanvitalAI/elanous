import { expect, test, mock, spyOn } from 'bun:test';
import { debug } from '../../debug/log.js';
import { handleDesignPick } from './design-pick.js';
import type { DesignDirection } from '../../design/design-directions.js';
import type { ApplyDesignDirectionResult } from '../../design/apply-direction.js';
import { buildDashboardSlashRegistry, type DashboardSlashContext } from './dashboard-handlers.js';
import { SLASH_COMMANDS } from '../../chat/index.js';

const directions: DesignDirection[] = [
  { id: 'theme-one', label: 'Theme', mood: 'soft', source: 'theme', isDark: false, isPastel: true, swatch: { text: '#fff', accent: '#000', muted: '#aaa' } },
  { id: 'system-one', label: 'First', mood: 'editorial', source: 'design-system', isDark: false, isPastel: false, swatch: { text: '#fff', accent: '#000', muted: '#aaa' } },
  { id: 'system-two', label: 'Second', mood: 'bold', source: 'design-system', isDark: true, isPastel: false, swatch: { text: '#fff', accent: '#000', muted: '#aaa' } },
];

function fixture(result: ApplyDesignDirectionResult = { ok: true, direction: 'system-two', documentPath: '/project/DESIGN.md' }) {
  const chatLines: string[] = [];
  const apply = mock((_path: string, _id: string): ApplyDesignDirectionResult => result);
  const ctx = { chatLines, setChatScrollOffset: (_offset: number) => {} };
  const deps = {
    list: () => directions,
    apply,
    cwd: () => '/project/nested',
    repositoryRoot: () => '/project',
    readDocument: () => '# Design\n\n## Design direction\n\n- system-two\n',
  };
  return { chatLines, apply, ctx, deps };
}

test('/design pick shows numbered systems before themes and marks declared', () => {
  const f = fixture();
  handleDesignPick([], f.ctx, f.deps);
  expect(f.chatLines.slice(0, 3)).toEqual([
    '1. system-one · First · editorial · 밝음 / 비파스텔',
    '2. system-two · Second · bold · 어두움 / 비파스텔 · 지금 선언',
    '3. theme-one · Theme · soft · 밝음 / 파스텔',
  ]);
  expect(f.apply).not.toHaveBeenCalled();
});

test('/design pick 2 applies second system id at git root exactly once', () => {
  const f = fixture();
  handleDesignPick(['2'], f.ctx, f.deps);
  expect(f.apply).toHaveBeenCalledTimes(1);
  expect(f.apply).toHaveBeenCalledWith('/project/DESIGN.md', 'system-two');
  expect(f.chatLines).toEqual(['✅ system-two 적용 — /project/DESIGN.md']);
});

test('/design pick id applies the same canonical direction', () => {
  const f = fixture();
  handleDesignPick(['theme-one'], f.ctx, f.deps);
  expect(f.apply).toHaveBeenCalledWith('/project/DESIGN.md', 'theme-one');
});

test('conflicting-system-file refuses in Korean, reports path, and does not retry', () => {
  const f = fixture({ ok: false, reason: 'conflicting-system-file', documentPath: '/project/DESIGN.md', path: '/project/design/system/tokens.css' });
  handleDesignPick(['2'], f.ctx, f.deps);
  expect(f.chatLines).toEqual(['적용 거부: design/system/ 을 사람이 고쳤다 — 덮지 않는다 · /project/design/system/tokens.css']);
  expect(f.apply).toHaveBeenCalledTimes(1);
});

test('apply and refusal emit structured design.pick events', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const success = fixture();
    handleDesignPick(['2'], success.ctx, success.deps);
    expect(log).toHaveBeenCalledWith('design.pick', 'applied', { id: 'system-two' });

    const failure = fixture({ ok: false, reason: 'conflicting-system-file', documentPath: '/project/DESIGN.md', path: '/project/design/system/tokens.css' });
    handleDesignPick(['2'], failure.ctx, failure.deps);
    expect(log).toHaveBeenCalledWith('design.pick', 'refused', { id: 'system-two', reason: 'conflicting-system-file' });
  } finally {
    log.mockRestore();
  }
});

test('outside git refuses before applying, while list remains available', () => {
  const f = fixture();
  const deps = { ...f.deps, repositoryRoot: () => undefined };
  handleDesignPick(['2'], f.ctx, deps);
  expect(f.chatLines[0]).toContain('git 저장소가 아닙니다');
  expect(f.apply).not.toHaveBeenCalled();
  handleDesignPick([], f.ctx, deps);
  expect(f.chatLines).toContain('1. system-one · First · editorial · 밝음 / 비파스텔');
});

test('unknown selection does not call apply; each apply refusal has a distinct line', () => {
  const f = fixture();
  handleDesignPick(['0'], f.ctx, f.deps);
  expect(f.chatLines[0]).toContain('찾을 수 없습니다');
  expect(f.apply).not.toHaveBeenCalled();
  for (const reason of ['unknown-direction', 'cannot-read', 'cannot-write'] as const) {
    const failure = fixture({ ok: false, reason, documentPath: '/project/DESIGN.md' });
    handleDesignPick(['2'], failure.ctx, failure.deps);
    expect(failure.chatLines).toHaveLength(1);
    expect(failure.chatLines[0]).toContain('적용 거부');
    expect(failure.apply).toHaveBeenCalledTimes(1);
  }
});

test('dashboard dispatches pick into chatLines and slash catalog exposes it', async () => {
  const lines: string[] = [];
  const debugLines: string[] = [];
  const identity = (s: string) => s;
  const ctx = {
    chatLines: lines,
    pushChatLine: (s: string) => lines.push(s),
    pushDebugLine: (s: string) => debugLines.push(s),
    setChatScrollOffset: () => {},
    highlight: identity, success: identity, error: identity, muted: identity, text: identity,
  } as unknown as DashboardSlashContext;
  await buildDashboardSlashRegistry().dispatch('design', ['pick'], ctx);
  expect(lines[0]).toStartWith('1. ');
  expect(debugLines).toEqual([]);
  const catalogEntry = SLASH_COMMANDS.find((c) => c.name === 'design');
  expect(catalogEntry?.subcommands).toContain('pick');
  expect(catalogEntry?.description).toContain('/design pick');
});
