// `elanous dev` help 컨사이스 계약 (2026-07-27) — 대표 지시 *"컨사이스하게 · 상세는 연결된 매뉴얼에서"*.
//
// 종전 `--ground` help 는 내부 동작(LLM 키워드 추출·랭킹·상위 12파일·심볼 12개·미주입 범위·표적 품질
// 한계)을 전부 담아 화면에서 문단이 됐다. 줄이는 건 쉽지만 **다시 불어나는 것**이 문제라 계약을 잠근다.
//
// ⚠️ 터미널 폭 스냅샷을 쓰지 않는다(리뷰 should-fix 에 대한 선택) — Commander 는 폭에 따라 접으므로
//    "몇 줄"은 환경 의존이라 고정할 수 없다. 대신 **폭과 무관한 두 가지**를 단정한다:
//      ① 설명 **원문 길이** 상한(불어나면 실패)
//      ② 상세로 가는 **매뉴얼 경로**가 help 에 실제로 노출되는가(위임처가 없으면 축약은 정보 손실이다)

import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const REPO = join(import.meta.dir, '..');
const MANUAL = 'docs/manual/MANUAL-frontdoor-selfdev-dogfood-mechanism-2026-07-25.md';

function devHelp(): string {
  const r = spawnSync('bun', [join(REPO, 'bin/elanous.mjs'), 'dev', '--help'], {
    encoding: 'utf8', timeout: 120_000, cwd: REPO, env: { ...process.env, COLUMNS: '200' },
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

function devHelpAll(): string {
  const r = spawnSync('bun', [join(REPO, 'bin/elanous.mjs'), 'dev', '--help-all'], {
    encoding: 'utf8', timeout: 120_000, cwd: REPO, env: { ...process.env, COLUMNS: '200' },
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** 폭 접힘을 되돌린다 — Commander 는 `process.stdout.columns`(파이프면 80)로 **자동 개행**한다.
 *  ⚠️ 이 테스트 자신이 그 함정에 걸렸다: `COLUMNS=200` 을 줘도 파이프에서는 안 먹어
 *     `"무인 완결이\n기본"` 으로 접혀 정규식이 빗나갔다. 그래서 **모든 매칭은 정규화 후**에 한다
 *     (= 폭 스냅샷을 계약으로 삼지 않는 이유의 실증). */
function flat(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** `--<name>` 옵션의 설명 원문 — 다음 옵션 줄까지 모아 공백 정규화(폭 접힘을 되돌린다). */
function optionText(help: string, flag: string): string {
  const lines = help.split('\n');
  const i = lines.findIndex(l => l.trimStart().startsWith(`${flag} `) || l.trimStart() === flag);
  expect(i).toBeGreaterThan(-1);
  const acc = [lines[i]!.trimStart().slice(flag.length)];
  for (const l of lines.slice(i + 1)) {
    if (/^\s+-{1,2}[A-Za-z]/.test(l)) break;      // 다음 옵션 시작
    if (!l.trim()) break;
    acc.push(l.trim());
  }
  return acc.join(' ').replace(/\s+/g, ' ').trim();
}

describe('elanous dev help — 컨사이스 계약', () => {
  test('⭐ 옵션 설명이 한 문장 분량을 넘지 않는다 (문단 회귀 차단)', () => {
    // ⛔ 2026-09-02: 이 시험은 `--ground` 를 표본으로 썼는데 그 옵션이 «은퇴»했다(#15264).
    //   ⭐ 지키던 것은 «그 옵션»이 아니라 ***「설명이 문단으로 불어나지 않는다」***이므로 축을 옮긴다.
    //   ⇒ 살아 있는 옵션 «전부»를 재서 상한을 지키게 한다 — 표본 하나에 매이지 않는다.
    const help = devHelpAll();
    const flags = [...help.matchAll(/^\s+(--[a-z][a-z0-9-]*)/gm)].map(m => m[1]!);
    expect(flags.length).toBeGreaterThan(10);   // ⛔ 모집단 확인 — 0 이면 「없다」가 아니라 「못 잼」이다
    const tooLong = flags.filter(f => optionText(help, f).length > 160);
    expect(tooLong).toEqual([]);
  }, 150_000);

  test.skipIf(!existsSync(join(REPO, '.rules/README.md')))('⭐ private manual 축약의 위임처가 help 에 노출된다 (없으면 정보 손실이다)', () => {
    const help = flat(devHelp());
    expect(help).toContain(MANUAL);
    // 그리고 그 문서가 실제로 존재해야 한다 — 죽은 경로를 안내하면 축약이 삭제가 된다.
    expect(existsSync(join(REPO, MANUAL))).toBe(true);
  }, 150_000);

  test('무인 완결 기본값과 탈출구가 help 에 보인다 (footgun 방지)', () => {
    const help = flat(devHelp());
    expect(help).toMatch(/무인 완결이 기본/);
    for (const esc of ['--no-open-pr', '--no-auto-review', '--no-auto-merge']) {
      expect(help).toContain(esc);
    }
  }, 150_000);
});
