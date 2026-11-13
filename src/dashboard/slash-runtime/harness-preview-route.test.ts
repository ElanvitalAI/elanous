import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { resolveClassicHarnessPreview, runClassicHarnessPreview } from './harness-preview-route.js';

test('classic preview distinguishes a goal file from prose and never treats a missing file as a live goal', () => {
  const root = mkdtempSync(join(tmpdir(), 'classic-harness-preview-'));
  const goal = join(root, 'goal.md');
  writeFileSync(goal, '대상 경로: src/tui/entry.ts\n');
  try {
    expect(resolveClassicHarnessPreview(`--dry-run ${goal}`)).toEqual({
      kind: 'preview', source: 'file', value: goal,
    });
    expect(resolveClassicHarnessPreview('--dry-run 대상 경로: src/tui/entry.ts')).toEqual({
      kind: 'preview', source: 'prose', value: '대상 경로: src/tui/entry.ts',
    });
    expect(resolveClassicHarnessPreview(`--dry-run\t${goal}`)).toEqual({
      kind: 'preview', source: 'file', value: goal,
    });
    expect(resolveClassicHarnessPreview('--dry-run\n대상 경로: src/tui/entry.ts')).toEqual({
      kind: 'preview', source: 'prose', value: '대상 경로: src/tui/entry.ts',
    });
    expect(resolveClassicHarnessPreview('--dry-run')).toMatchObject({ kind: 'invalid' });
    expect(resolveClassicHarnessPreview(`--dry-run ${join(root, 'missing.md')}`)).toMatchObject({ kind: 'invalid' });
    expect(resolveClassicHarnessPreview(`--dry-run "${join(root, 'missing goal.md')}"`)).toMatchObject({ kind: 'invalid' });
    expect(resolveClassicHarnessPreview('ordinary goal')).toEqual({ kind: 'ordinary' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('classic preview adapter produces a canonical goal-file dry-run receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'classic-harness-goal-'));
  const repo = resolve(import.meta.dir, '..', '..', '..');
  const goal = join(root, 'goal.md');
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(repo, 'scripts', 'ask-marker-check.ts'), join(root, 'scripts', 'ask-marker-check.ts'));
  writeFileSync(goal, `대상 경로: scripts/ask-marker-check.ts

불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = 검사기가 export를 센다; 관측 = rg -c 'export function inspectAskMarkers' scripts/ask-marker-check.ts; 기대 = 1 이상.
`);
  try {
    const preview = resolveClassicHarnessPreview(`--dry-run ${goal}`);
    expect(preview.kind).toBe('preview');
    if (preview.kind !== 'preview') throw new Error('goal preview not parsed');
    const lines: string[] = [];
    await runClassicHarnessPreview(preview, new AbortController().signal,
      line => lines.push(line), join(repo, 'bin', 'elanous.mjs'));
    expect(lines).toContain(`[dry-run] 입력: ${goal}`);
    expect(lines).toContain('[dry-run] 입구: cli-harness-ask');
    expect(lines).toContain('[dry-run] ✅ ask 마커 — 경고 없음');
    expect(lines.join('\n')).not.toContain('워크트리 생성 완료');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
