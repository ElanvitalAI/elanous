import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REVIEW_CONTEXT_PACK_CAP_BYTES,
  buildReviewContextPack,
  renderReviewContextPack,
  spawnReviewContextPackGh,
} from './review-context-pack';

/**
 * 무대: fake-bin fake gh — PATH 위의 `gh` 를 가짜 실행 파일로 바꾼다.
 * 생산 기본 실행기(spawnReviewContextPackGh)가 그대로 PATH 를 지나므로, 주입 seam 만이 아니라
 * 실제 호출 경로가 시험된다.
 */
const TARGET_FILE = 'src/agent-substrate/self-review-cli.ts';

interface Stage {
  root: string;
  fakeDir: string;
  binDir: string;
  restore: () => void;
}

const stages: Stage[] = [];

function makeStage(): Stage {
  const root = mkdtempSync(join(tmpdir(), 'review-context-pack-'));
  const binDir = join(root, 'fake-bin');
  const fakeDir = join(root, 'fake-gh');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(fakeDir, { recursive: true });
  mkdirSync(join(root, 'release'), { recursive: true });
  const decisionMark = String.fromCodePoint(0x1f451);
  writeFileSync(join(root, 'AGENTS.md'), [
    '# Repository Collaboration Rules',
    '## ⭐ 제1원칙',
    '⭐⭐ **문법 = `SCQA`** — 운영 규칙.',
    `- ${decisionMark} 2026-10-25 16:1x «리뷰어가 이번 판·출시 목표·현재 작업 중인 맥락을 받아 근시안적 리뷰가 안 되게»`,
    `- ${decisionMark} 10-18 수용선: 새 코드는 실제 생산 진입점에서 호출되게 배선한다`,
  ].join('\n'), 'utf8');
  writeFileSync(join(root, 'release', 'next.md'), '0.2.39 판 — REVIEW-CONTEXT-PACK 칸 · 다음 착지 열차 금요일', 'utf8');
  const now = Date.now();
  writeFileSync(join(fakeDir, 'view.json'), JSON.stringify({
    number: 42,
    title: 'self review: 리뷰 맥락 팩',
    body: [
      '# PR — REVIEW-CONTEXT-PACK',
      '[OP · 0.2.39 칸 REVIEW-CONTEXT-PACK · TASK-AGENT(OP 디스패처)]',
      '- 완료 경계 코드: self review 가 맥락 팩 다섯 갈래를 만들어 리뷰 프롬프트에 싣고, 끄는 플래그(--no-context-pack)가 있다.',
      '- 완료 경계 증거 명령: bun test src/agent-substrate/review-context-pack.test.ts',
    ].join('\n'),
  }), 'utf8');
  writeFileSync(join(fakeDir, 'open.json'), JSON.stringify([
    { number: 42, title: '자기 자신', files: [TARGET_FILE] },
    { number: 77, title: '칸 경계 겹침 PR', files: [TARGET_FILE, 'src/other.ts'] },
    { number: 78, title: '무관 PR', files: ['docs/unrelated.md'] },
  ]), 'utf8');
  writeFileSync(join(fakeDir, 'merged.json'), JSON.stringify([
    { number: 90, title: '이틀 전 착지', mergedAt: new Date(now - 48 * 3_600_000).toISOString(), files: [TARGET_FILE] },
    { number: 99, title: '세 시간 전 착지', mergedAt: new Date(now - 3 * 3_600_000).toISOString(), files: [TARGET_FILE] },
  ]), 'utf8');
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, [
    '#!/bin/sh',
    'set -u',
    'if [ -n "${FAKE_GH_FAIL_ALL:-}" ]; then echo "gh: not authenticated" >&2; exit 1; fi',
    'case "$*" in',
    '  *"pr list"*)',
    '    if [ -n "${FAKE_GH_FAIL_OVERLAP:-}" ]; then echo "gh: rate limited" >&2; exit 1; fi',
    '    case "$*" in',
    '      *merged*) cat "${FAKE_GH_DIR:-/nonexistent}/merged.json" ;;',
    '      *) cat "${FAKE_GH_DIR:-/nonexistent}/open.json" ;;',
    '    esac',
    '    ;;',
    '  *"pr view"*) cat "${FAKE_GH_DIR:-/nonexistent}/view.json" ;;',
    '  *) echo "fake gh: unexpected args: $*" >&2; exit 2 ;;',
    'esac',
  ].join('\n'), 'utf8');
  chmodSync(ghPath, 0o755);

  const previousPath = process.env.PATH ?? '';
  const previousDir = process.env.FAKE_GH_DIR;
  const previousFailAll = process.env.FAKE_GH_FAIL_ALL;
  const previousFailOverlap = process.env.FAKE_GH_FAIL_OVERLAP;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_GH_DIR = fakeDir;
  delete process.env.FAKE_GH_FAIL_ALL;
  delete process.env.FAKE_GH_FAIL_OVERLAP;

  const stage: Stage = {
    root,
    fakeDir,
    binDir,
    restore: () => {
      process.env.PATH = previousPath;
      if (previousDir === undefined) delete process.env.FAKE_GH_DIR; else process.env.FAKE_GH_DIR = previousDir;
      if (previousFailAll === undefined) delete process.env.FAKE_GH_FAIL_ALL; else process.env.FAKE_GH_FAIL_ALL = previousFailAll;
      if (previousFailOverlap === undefined) delete process.env.FAKE_GH_FAIL_OVERLAP; else process.env.FAKE_GH_FAIL_OVERLAP = previousFailOverlap;
      rmSync(root, { recursive: true, force: true });
    },
  };
  stages.push(stage);
  return stage;
}

let stage: Stage;

beforeEach(() => {
  stage = makeStage();
});

afterEach(() => {
  stage.restore();
  const index = stages.indexOf(stage);
  if (index >= 0) stages.splice(index, 1);
});

function pack() {
  return buildReviewContextPack({
    pr: '42',
    files: [TARGET_FILE],
    rootDir: stage.root,
    gh: spawnReviewContextPackGh(),
  });
}

describe('REVIEW-CONTEXT-PACK', () => {
  it('겹치는 PR 하나·24h 착지 하나가 있는 PR → 팩에 칸 경계·겹침 줄·결정 줄이 들어간다', () => {
    const built = pack();
    const text = built.text;
    expect(text).toContain('칸 경계:');
    expect(text).toContain('REVIEW-CONTEXT-PACK');
    expect(text).toContain('겹침: #77');
    expect(text).toContain('겹침: main 착지 #99');
    expect(text).toContain('결정:');
    expect(text).toContain('must-fix:');
    // 24h 창 밖 착지(48h 전)와 무관 PR 은 싣지 않는다.
    expect(text).not.toContain('#90');
    expect(text).not.toContain('#78');
    expect(built.branches.map((branch) => branch.status)).toEqual([
      'measured', 'measured', 'measured', 'measured', 'measured',
    ]);
  });

  it('gh pr list 실패 → ④ 겹침 갈래만 미측정, 나머지 갈래는 계속된다', () => {
    process.env.FAKE_GH_FAIL_OVERLAP = '1';
    const built = pack();
    const byId = new Map(built.branches.map((branch) => [branch.id, branch]));
    expect(byId.get('overlap')?.status).toBe('unmeasured');
    expect(byId.get('overlap')?.reason ?? '').toContain('rate limited');
    expect(byId.get('cell')?.status).toBe('measured');
    expect(byId.get('decisions')?.status).toBe('measured');
    expect(byId.get('release')?.status).toBe('measured');
    expect(byId.get('must-fix')?.status).toBe('measured');
    expect(built.text).toContain('미측정: gh: rate limited');
    expect(built.text).toContain('칸 경계:');
    expect(built.text).toContain('결정:');
  });

  it('gh 전면 실패 → gh 를 쓰는 갈래(①④)만 미측정, 문서·must-fix 갈래는 남는다', () => {
    process.env.FAKE_GH_FAIL_ALL = '1';
    const built = pack();
    const byId = new Map(built.branches.map((branch) => [branch.id, branch]));
    expect(byId.get('cell')?.status).toBe('unmeasured');
    expect(byId.get('overlap')?.status).toBe('unmeasured');
    expect(byId.get('decisions')?.status).toBe('measured');
    expect(byId.get('release')?.status).toBe('measured');
    expect(byId.get('must-fix')?.status).toBe('measured');
  });

  it('문서가 없으면 그 갈래만 미측정이다', () => {
    const built = buildReviewContextPack({
      pr: '42',
      files: [TARGET_FILE],
      rootDir: stage.root,
      decisionsDoc: join('docs', 'missing.md'),
      gh: spawnReviewContextPackGh(),
    });
    const byId = new Map(built.branches.map((branch) => [branch.id, branch]));
    expect(byId.get('decisions')?.status).toBe('unmeasured');
    expect(byId.get('decisions')?.reason ?? '').toContain('문서 없음');
    expect(byId.get('release')?.status).toBe('measured');
  });

  it('6KB 상한 — 넘치면 잘라 표시하고 상한 안에 머문다', () => {
    const branches = Array.from({ length: 5 }, (_, index) => ({
      id: 'must-fix' as const,
      title: `갈래 ${index}`,
      status: 'measured' as const,
      lines: Array.from({ length: 40 }, () => 'x'.repeat(200)),
    }));
    const rendered = renderReviewContextPack(branches, REVIEW_CONTEXT_PACK_CAP_BYTES);
    expect(rendered.truncated).toBe(true);
    expect(rendered.unmeasuredBranchIds.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(REVIEW_CONTEXT_PACK_CAP_BYTES);
    expect(rendered.text).toContain('6KB 상한');
  });

  it('잘린 갈래와 뒤의 미포함 갈래는 구조 결과도 미측정이다', () => {
    const built = buildReviewContextPack({
      pr: '42',
      prTitle: '칸 절단 시험',
      prBody: '칸: CONTEXT\n완료 경계: pack 주입',
      files: [],
      rootDir: stage.root,
      capBytes: 1024,
      readFile: () => Array.from({ length: 8 }, () => '출시 필수 칸 정보 '.repeat(12)).join('\n'),
      gh: () => ({ ok: true, stdout: '[]' }),
    });
    const byId = new Map(built.branches.map((branch) => [branch.id, branch]));
    expect(built.truncated).toBe(true);
    expect(byId.get('release')?.status).toBe('unmeasured');
    expect(byId.get('release')?.reason).toContain('상한');
    expect(byId.get('decisions')?.status).toBe('unmeasured');
  });

  it('갈래는 문서·gh 순서와 무관하게 독립 실패한다(gh 실행 파일이 없어도 팩은 나온다)', () => {
    process.env.PATH = join(stage.root, 'empty-bin');
    const built = pack();
    expect(built.text.length).toBeGreaterThan(0);
    expect(built.text).toContain('must-fix:');
    const byId = new Map(built.branches.map((branch) => [branch.id, branch]));
    expect(byId.get('overlap')?.status).toBe('unmeasured');
  });
});
