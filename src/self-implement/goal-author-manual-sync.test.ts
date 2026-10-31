// AUTHOR-MANUAL-SYNC — 골 저작 방법 매뉴얼이 10-07 현실을 말하는지 «문면 대조»로 잰다.
// 무대 이름: 문서 문구 대조 (생산 함수 ⊕ 기록된 실제 입력 — 문서 전용 골이라 CLI sim 카탈로그 무대 비적용).
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const manualDir = join(import.meta.dir, '../../docs/manual');
const manualPath = join(manualDir, 'MANUAL-goal-authoring-method-2026-08-03.md');
const manual = readFileSync(manualPath, 'utf8');

/** 절 본문 — 주어진 제목부터 «다음 `## ` 제목» 전까지. 제목이 없으면 빈 문자열. */
function sectionBody(source: string, heading: string): string {
  const start = source.indexOf(heading);
  if (start < 0) return '';
  const rest = source.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('goal authoring manual reflects the 10-07 reality (AUTHOR-MANUAL-SYNC)', () => {
  test('names the three natural-language entrances with a real command and their registration point on the same line', () => {
    const entryLines = manual.split('\n').filter((line) => /하니스 say|«하니스로 구현»|self author/.test(line));

    expect(manual).toContain('«하니스로 구현»');
    expect(manual).toContain('bun bin/elanous.mjs harness say "');
    expect(manual).toContain('bun bin/elanous.mjs self author "');

    const sayLine = entryLines.find(
      (line) => line.includes('하니스 say') && line.includes('src/harness/harness-cli-command.ts'),
    );
    expect(sayLine).toBeDefined();

    const authorLine = entryLines.find(
      (line) =>
        line.includes('self author') &&
        line.includes('src/self-implement/goal-author-cli.ts') &&
        line.includes('src/self-implement/goal-author.ts'),
    );
    expect(authorLine).toBeDefined();
  });

  test('documents the lite/normal/complex authoring grades and the AUTHOR-ADAPTIVE automatic choice', () => {
    const body = sectionBody(manual, '## 2.');

    expect(body).toContain('AUTHOR-ADAPTIVE');
    expect(body).toMatch(/자동 선택/);
    for (const grade of ['lite', 'normal', 'complex']) expect(body).toContain(grade);
    expect(body).toContain('--author-grade');
    expect(body).toContain('harness.authorGrade');
    expect(body).toContain('ELANOUS_AUTHOR_GRADE');
    expect(body).toContain('skippedPhases');
  });

  test('documents parallel-first launch: overlap is allowed, sibling memos carry the overlap, serial only when tangled', () => {
    const body = sectionBody(manual, '## 2.');

    expect(body).toContain('겹쳐도 쏜다');
    expect(body).toContain('OVERLAP-SIBLING-CTX');
    expect(body).toContain('OVERLAP-MEMO');
    expect(body).toContain('MERGE-INTENT-RESOLVE');
    expect(body).toContain('TANGLE-ESCALATION');
    expect(body).toContain('형제 메모');
  });

  test('documents a preflight that warns instead of blocking, with zero target paths as the only exception', () => {
    const body = sectionBody(manual, '## 2.');

    expect(body).toContain('막지 않는다');
    expect(body).toContain('자동 추정');
    expect(body).toMatch(/대상 경로가 «0개»/);
    expect(body).toContain('경고');
    expect(manual).not.toContain('⛔ exit 1<br/>«이름을 대고» 멈춘다');
  });

  test('names the stop branches that still refuse a launch today, by reason code', () => {
    const body = sectionBody(manual, '## 2.');

    for (const reasonCode of ['no-target-paths', 'missing-traced-path', 'goal-parse', 'goal-unreadable']) {
      expect(body).toContain(reasonCode);
    }
    expect(body).toContain('warnings.push');
  });

  test('every reason code the manual names still exists in the preflight it points at', () => {
    const preflight = readFileSync(join(import.meta.dir, '../self-dev/launch-preflight.ts'), 'utf8');
    const body = sectionBody(manual, '## 2.');

    for (const reasonCode of ['no-target-paths', 'missing-traced-path', 'goal-parse', 'goal-unreadable']) {
      if (!body.includes(reasonCode)) continue;
      expect(preflight).toContain(`'${reasonCode}'`);
    }
  });

  test('removes the stale procedures, version numbers and manual-hand columns from §0·§2·§4·§6', () => {
    for (const heading of ['## 0.', '## 2.', '## 4.', '## 6.']) {
      const body = sectionBody(manual, heading);
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toMatch(/\bv\d{2,3}\b/);
    }
    expect(manual).not.toContain('### ⚠️ **아래 넷은 «수동 판»이다**');
    expect(manual).not.toContain('이 여섯뿐이다');
    expect(manual).not.toContain('사람 칸 «여섯»');
  });

  test('keeps the pre-launch one-liners that 10-07 did not remove, as §2.6', () => {
    const body = sectionBody(manual, '## 2.');

    expect(body).toContain('### 2.6');
    expect(body).toContain('graph-authority-resolved');
    expect(body).toContain('src/ --glob \'!*.test.ts\'');
    expect(body).toContain('0건이면 그 파일은 «아직 그 일을 모른다»');
  });

  test('no section still points at the removed §2 blocks ⓪d · ⓪e', () => {
    expect(manual).not.toMatch(/§2 ⓪[d-z]/);
  });

  test('records the measured authoring median of 110s without turning it into a timeout', () => {
    expect(manual).toMatch(/저작 중앙 110s/);
    expect(manual).toContain('타임아웃을 110s 에 «딱 붙여» 잡지 마라');
  });

  test('carries the preservation contract line verbatim', () => {
    expect(manual).toContain('보존 계약: 다른 명령·화면의 기본 동작과 원장 형식은');
  });

  test('the relative links this revision relies on resolve on disk', () => {
    const relatives = [
      '../system/EVIDENCE-goal-authoring-method-2026-08-14.md',
      'MANUAL-execution-harness-usage-2026-07-22.md',
      'MANUAL-observation-surface-map-2026-07-29.md',
    ];

    expect(relatives.filter((relative) => !existsSync(join(manualDir, relative)))).toEqual([]);
    for (const relative of relatives) expect(manual).toContain(relative);
  });
});
