// TUI-ONE-WORD-LAUNCH — 격리 우주에서 `--cwd`·`--worktree` 없이 `dev --elanous --hold` 를 치면
// 시스템이 작업 디렉토리를 스스로 정한다(대표 *"cwd 를 넣어야 한다는 것 자체가 프릭션"*).
// ⛔ 이 시험은 본 저장소에 진짜 워크트리를 만들지 않는다 — 실물 spawn 은 git 저장소 «밖» 임시 cwd 에서만.
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideAutoWorktree, formatAutoWorktreeFailure, formatAutoWorktreeNotice } from './dev-cli.js';
import { isExplicitlyIsolated } from '../cli/pty-drive-cli.js';

describe('decideAutoWorktree — 네 갈래', () => {
  it('명시 --cwd 가 이긴다(격리 우주여도 자동으로 만들지 않는다)', () => {
    expect(decideAutoWorktree({ explicitlyIsolated: true, elanous: true, hold: true, cwd: '/wt/a' })).toBe('explicit-cwd');
  });

  it('--worktree 를 주면 requested', () => {
    expect(decideAutoWorktree({ explicitlyIsolated: true, elanous: true, hold: true, worktree: true })).toBe('requested');
    expect(decideAutoWorktree({ explicitlyIsolated: false, elanous: true, hold: true, worktree: true })).toBe('requested');
  });

  it('명시 격리 ⊕ --elanous ⊕ 둘 다 없음이면 auto', () => {
    expect(decideAutoWorktree({ explicitlyIsolated: true, elanous: true, hold: true })).toBe('auto');
    // 공백 cwd 는 «안 준 것»이다
    expect(decideAutoWorktree({ explicitlyIsolated: true, elanous: true, hold: true, cwd: '  ' })).toBe('auto');
  });

  it('격리가 아닌 우주(운영·트리 파생)나 elanous 가 아니면 none — 종전 동작 그대로', () => {
    expect(decideAutoWorktree({ explicitlyIsolated: false, elanous: true, hold: true })).toBe('none');
    expect(decideAutoWorktree({ explicitlyIsolated: true, elanous: false })).toBe('none');
    expect(decideAutoWorktree({ explicitlyIsolated: true })).toBe('none');
  });
});

describe('isExplicitlyIsolated — runPtyDriveInner 와 같은 한 벌', () => {
  it('--test(명시 플래그 층) 또는 --isolated-root 만 명시 격리다', () => {
    expect(isExplicitlyIsolated({ kind: 'test', layer: 'explicit-flag' })).toBe(true);
    expect(isExplicitlyIsolated({ kind: 'prod', layer: 'default' }, '/iso')).toBe(true);
    // 3층(트리 파생)은 «명시»가 아니다
    expect(isExplicitlyIsolated({ kind: 'test', layer: 'tree-derived' })).toBe(false);
    expect(isExplicitlyIsolated({ kind: 'prod', layer: 'default' })).toBe(false);
  });
});

describe('사람 문면', () => {
  it('git 저장소 밖 실패는 원인을 한 마디로 말하고 스택을 싣지 않는다', () => {
    const msg = formatAutoWorktreeFailure(new Error('dev --worktree requires a Git repository — /tmp/x\n    at prepareDevWorktree'));
    expect(msg).toContain('작업 디렉토리를 스스로 정하지 못했다');
    expect(msg).toContain('--cwd <경로>');
    expect(msg).toContain('git 저장소가 아니다');
    expect(msg).not.toContain('at prepareDevWorktree');
  });

  it('자동으로 만들었으면 경로와 직접 정하는 법을 한 줄로 알린다', () => {
    expect(formatAutoWorktreeNotice('/wt/dev-run-1')).toBe('작업 디렉토리: /wt/dev-run-1 (격리 우주라 자동으로 만들었다 · 직접 정하려면 --cwd)');
  });
});

describe('실물 CLI — git 저장소 밖 임시 cwd', () => {
  const REPO = resolve(import.meta.dir, '..', '..');
  const CLI = join(REPO, 'bin', 'elanous.mjs');

  it('--config-dir <임시> dev --elanous --hold x 는 «스스로 정하지 못했다» 문면 ⊕ 0 아닌 종료로 끝난다', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dev-auto-wt-no-git-'));
    const sandbox = mkdtempSync(join(tmpdir(), 'dev-auto-wt-cfg-'));
    try {
      const r = spawnSync('bun', [CLI, '--config-dir', sandbox, 'dev', '--elanous', '--hold', 'x'], {
        cwd: outside,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, ELANOUS_STATE_DIR: sandbox },
      });
      const err = r.stderr ?? '';
      expect(err).toContain('작업 디렉토리를 스스로 정하지 못했다');
      expect(err).toContain('git 저장소가 아니다');
      // 종전 거부(「명시해야 한다」)로 가지 않았다 — 자동 갈래를 탔다
      expect(err).not.toContain('작업 디렉토리를 명시해야 한다');
      expect(err).not.toMatch(/\n\s+at \S+ \(/);
      expect(r.status ?? -1).not.toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 130_000);
});
