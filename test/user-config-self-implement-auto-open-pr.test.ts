// ── ⭐ tools.selfImplement.autoOpenPr — operator 사전 승인 (2026-07-26 대표 결정) ──
//
// CLI `elanous self implement --open-pr` 은 **플래그가 곧 사람의 명시 승인**이라 무인 진행이
// 되지만, 툴(ACP/데몬/텔레그램) 경로엔 등가물이 없어 매번 대화형 확인을 받거나(무인이면)
// **완성 산출이 worktree 에 좌초**했다. 이 노브가 그 갭을 닫는다 — 승인 주체는 사람으로
// 유지되고 시점만 앞당겨진다(툴 파라미터로 열면 LLM 자기승인이 되므로 config 가 옳은 자리).
//
// 기본은 **ON**(대표: "오토를 좋아하므로"). 끄려면 명시적 `false`.

import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { buildUserConfig, findRetiredConfigKeys } from '../src/user-config.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const REPO_ROOT = join(import.meta.dir, '..');
const ENTRY = join(REPO_ROOT, 'src/index.ts');

/** 격리 config 디렉토리에 config.json 을 쓰고 로드한다(운영 ~/.elanous 무접촉). */
function loadWith(toolsRaw: unknown): ReturnType<typeof buildUserConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-cfg-autoopenpr-'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(toolsRaw === undefined ? {} : { tools: toolsRaw }));
  return buildUserConfig(path);
}

describe('tools.selfImplement.autoOpenPr', () => {
  test('⭐ 기본값 ON — config 에 아무것도 없어도 자동 PR 개설', () => {
    const selfImplement = loadWith(undefined).tools.selfImplement;
    expect(selfImplement.autoOpenPr).toBe(true);
    expect(selfImplement.observeOnly).toBe(false);
    // ⭐ 설정 졸업 1-a(2026-09-24): 감독 셋은 기본 켬(운영이 늘 켜 두던 값). `enabled` 는 폐기 키다.
    //   ⚠️ autoAssist 는 `elanous drive --elanous` 도 읽는다 — 새 설치에서도 drive 가 감독 입력을 받는다(의도).
    expect(selfImplement.autoStop).toEqual({ enabled: true, minRung: 2 });
    expect(selfImplement.autoAssist).toEqual({ enabled: true, minRung: 2 });
    expect(selfImplement.screenStallTermination).toEqual({ enabled: true, minRung: 2 });
    // 대표 결정(2026-09-24): 재작업 예산 기본 = 운영 값(판정기를 따른다 · 상한 3).
    expect(selfImplement.reworkBudget).toEqual({ shadowStop: false, maxRounds: 3 });
  });

  test('childInstanceMode defaults to isolation, accepts inheritance, and fail-softs invalid values', () => {
    expect(loadWith(undefined).tools.selfImplement.childInstanceMode).toBe('isolated');
    expect(loadWith({ selfImplement: { childInstanceMode: 'inherit' } }).tools.selfImplement.childInstanceMode).toBe('inherit');
    for (const bad of ['isolate', true, false, null, {}, []]) {
      expect(loadWith({ selfImplement: { childInstanceMode: bad } }).tools.selfImplement.childInstanceMode).toBe('isolated');
    }
  });

  test('autoAssist — 명시값 파싱 · 음수 minRung 은 0 으로 바닥', () => {
    const cfg = loadWith({ selfImplement: { autoAssist: { enabled: true, minRung: 5 } } });
    expect(cfg.tools.selfImplement.autoAssist).toEqual({ enabled: true, minRung: 5 });
    const floored = loadWith({ selfImplement: { autoAssist: { enabled: true, minRung: -3 } } });
    expect(floored.tools.selfImplement.autoAssist.minRung).toBe(0);
  });

  test('autoAssist — 잘못된 모양은 기본값으로 떨어진다(수락 후 무시 금지의 반대편: 파싱은 관대)', () => {
    expect(loadWith({ selfImplement: { autoAssist: 'yes' } }).tools.selfImplement.autoAssist)
      .toEqual({ enabled: true, minRung: 2 });
  });

  test('설정 졸업 1-a — 파일의 enabled:false 는 폐기 키라 무시되고 minRung 만 존중된다', () => {
    const cfg = loadWith({ selfImplement: { autoStop: { enabled: false, minRung: 3 }, screenStallTermination: { enabled: false } } });
    expect(cfg.tools.selfImplement.autoStop).toEqual({ enabled: true, minRung: 3 });
    expect(cfg.tools.selfImplement.screenStallTermination).toEqual({ enabled: true, minRung: 2 });
    expect(findRetiredConfigKeys({ tools: { selfImplement: { autoStop: { enabled: false, minRung: 3 } } } }).map(({ path }) => path))
      .toContain('tools.selfImplement.autoStop.enabled');
  });

  test('goalRecordInDoc defaults on, accepts explicit false, and ignores non-boolean values', () => {
    expect(loadWith(undefined).tools.selfImplement.goalRecordInDoc).toBe(true);
    expect(loadWith({ selfImplement: { goalRecordInDoc: true } }).tools.selfImplement.goalRecordInDoc).toBe(true);
    expect(loadWith({ selfImplement: { goalRecordInDoc: false } }).tools.selfImplement.goalRecordInDoc).toBe(false);
    for (const bad of ['false', 0, null, [], {}]) {
      expect(loadWith({ selfImplement: { goalRecordInDoc: bad } }).tools.selfImplement.goalRecordInDoc).toBe(true);
    }
  });

  test('observeOnly는 명시 boolean만 존중하고 기본은 OFF', () => {
    expect(loadWith({ selfImplement: { observeOnly: true } }).tools.selfImplement.observeOnly).toBe(true);
    expect(loadWith({ selfImplement: { observeOnly: false } }).tools.selfImplement.observeOnly).toBe(false);
    for (const bad of ['true', 1, null, [], {}]) {
      expect(loadWith({ selfImplement: { observeOnly: bad } }).tools.selfImplement.observeOnly).toBe(false);
    }
  });

  test('격리 CLI config get은 selfImplement의 기존 필드와 observeOnly를 함께 노출한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-cfg-observe-only-cli-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        tools: { selfImplement: { observeOnly: true, autoOpenPr: false } },
      }));
      const result = spawnSync('bun', [ENTRY, '--config-dir', dir, 'config', 'get', 'tools.selfImplement'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: { ...process.env, ELANOUS_SUPPRESS_XDG_WARNING: '1' },
        timeout: 15_000,
      });
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toMatchObject({
        observeOnly: true,
        autoOpenPr: false,
        autoStop: { enabled: true, minRung: 2 },
        autoAssist: { enabled: true, minRung: 2 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⛔⭐ 리뷰 must-fix(인수 라운드) — 위 검사는 `--config-dir`(1층 명시)만 지나므로 **격리 그 자체**를
  //   검증하지 않는다. 코퍼스 측정이 서는 자리는 `--test`(트리 파생 격리)이고, 그 경로에서 계약이
  //   조회되지 않으면 스위치는 있어도 **닿지 않는다**. ⇒ 실제 `--test` 를 임시 git 트리에서 돌린다
  //   (이 저장소의 .elanous-test 를 건드리지 않게 cwd 를 임시 트리로 둔다).
  test('⭐ --test 격리(트리 파생)에서도 config get 이 observeOnly 를 낸다', () => {
    const tree = mkdtempSync(join(tmpdir(), 'elanous-testtree-observe-only-'));
    try {
      const init = spawnSync('git', ['init', '-q', tree], { encoding: 'utf-8', timeout: 15_000 });
      expect(init.status).toBe(0);
      const isolatedRoot = join(tree, '.elanous-test');
      mkdirSync(isolatedRoot, { recursive: true });
      writeFileSync(join(isolatedRoot, 'config.json'), JSON.stringify({
        tools: { selfImplement: { observeOnly: true } },
      }));
      const result = spawnSync('bun', [ENTRY, '--test', 'config', 'get', 'tools.selfImplement'], {
        cwd: tree,
        encoding: 'utf-8',
        env: { ...process.env, ELANOUS_SUPPRESS_XDG_WARNING: '1', ELANOUS_STATE_DIR: '' },
        timeout: 60_000,
      });
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      // ⭐ 이 단언이 스위치가 **격리 우주에 닿는다**를 고정한다 — 손으로 한 번 확인한 것과 다르다.
      expect(output).toMatchObject({ observeOnly: true });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test('tools 는 있으나 selfImplement 가 없으면 기본 ON', () => {
    expect(loadWith({ deferred: { mode: 'always' } }).tools.selfImplement.autoOpenPr).toBe(true);
  });

  test('명시적 false 만 끈다', () => {
    expect(loadWith({ selfImplement: { autoOpenPr: false } }).tools.selfImplement.autoOpenPr).toBe(false);
  });

  test('명시적 true 는 그대로 ON', () => {
    expect(loadWith({ selfImplement: { autoOpenPr: true } }).tools.selfImplement.autoOpenPr).toBe(true);
  });

  test('오타·비-boolean 은 기본값(ON)으로 수렴 — fail-soft(다른 노브와 동형)', () => {
    for (const bad of ['false', 0, null, [], { nested: true }]) {
      expect(loadWith({ selfImplement: { autoOpenPr: bad } }).tools.selfImplement.autoOpenPr).toBe(true);
    }
    // selfImplement 자체가 배열/스칼라여도 죽지 않고 기본값.
    expect(loadWith({ selfImplement: [] }).tools.selfImplement.autoOpenPr).toBe(true);
    expect(loadWith({ selfImplement: 'nope' }).tools.selfImplement.autoOpenPr).toBe(true);
  });

  // should-fix(리뷰 #5463): 잘못된 설정이 **조용히** 기본값(ON)으로 수렴하면 "껐다고
  // 믿었는데 자동 개설"이 된다 → 값이 있는데 boolean 이 아닐 때만 경고를 낸다(부재는 정상).
  test('비-boolean 값이면 경고를 낸다 · 부재면 조용하다', () => {
    const seen: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (msg: string) => { seen.push(String(msg)); return true; };
    try {
      loadWith({ selfImplement: { autoOpenPr: 'false' } });
      expect(seen.join()).toContain('tools.selfImplement.autoOpenPr');
      seen.length = 0;
      loadWith({ deferred: { mode: 'always' } });           // 부재 = 정상
      expect(seen.join()).not.toContain('tools.selfImplement.autoOpenPr');
      seen.length = 0;
      loadWith({ selfImplement: { autoOpenPr: false } });   // 명시 false = 정상
      expect(seen.join()).not.toContain('tools.selfImplement.autoOpenPr');
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
  });

  test('기존 tools 노브(deferred·agentSpawn)는 무회귀', () => {
    const cfg = loadWith({ deferred: { mode: 'off' }, agentSpawn: { hopCap: 2 } });
    expect(cfg.tools.deferred.mode).toBe('off');
    expect(cfg.tools.agentSpawn.hopCap).toBe(2);
    expect(cfg.tools.selfImplement.autoOpenPr).toBe(true);
    expect(cfg.tools.selfImplement.autoStop).toEqual({ enabled: true, minRung: 2 });
  });

  test('reworkBudget은 기본 상한 3과 명시 boolean·정수 상한만 존중한다', () => {
    expect(loadWith({ selfImplement: { reworkBudget: { shadowStop: true, maxRounds: 6 } } }).tools.selfImplement.reworkBudget)
      .toEqual({ shadowStop: true, maxRounds: 6 });
    expect(loadWith({ selfImplement: { reworkBudget: { shadowStop: 'true' } } }).tools.selfImplement.reworkBudget)
      .toEqual({ shadowStop: false, maxRounds: 3 });
  });

  test('reworkBudget maxRounds는 이상값을 경고하고 기본 상한 3으로 대체한다', () => {
    const original = process.stderr.write;
    const warnings: string[] = [];
    (process.stderr as unknown as { write: typeof original }).write = ((message: string) => {
      warnings.push(message);
      return true;
    }) as typeof original;
    try {
      for (const invalid of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '6']) {
        expect(loadWith({ selfImplement: { reworkBudget: { maxRounds: invalid } } }).tools.selfImplement.reworkBudget.maxRounds).toBe(3);
      }
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    expect(warnings).toHaveLength(6);
    expect(warnings.every((warning) => warning.includes('1 이상의 유한한 정수여야 합니다'))).toBe(true);
  });

  // ⭐ autoStop 파서 회귀(리뷰 should-fix) — 기본값만 보면 **켜는 경로와 정규화**가 무보호다.
  test('⭐ autoStop 은 명시값을 존중하고 비정상값은 기본으로 폴백한다', () => {
    expect(loadWith({ selfImplement: { autoStop: { enabled: true, minRung: 1 } } })
      .tools.selfImplement.autoStop).toEqual({ enabled: true, minRung: 1 });
    // 음수·소수는 정규화(하한 0·정수) — 확증 요구를 config 로 못 끄게 하는 1차 방어선.
    expect(loadWith({ selfImplement: { autoStop: { enabled: true, minRung: -4 } } })
      .tools.selfImplement.autoStop.minRung).toBe(0);
    expect(loadWith({ selfImplement: { autoStop: { enabled: true, minRung: 2.9 } } })
      .tools.selfImplement.autoStop.minRung).toBe(2);
    // 타입이 틀리면 기본값(파싱 실패로 죽지 않는다).
    expect(loadWith({ selfImplement: { autoStop: { enabled: 'yes', minRung: 'two' } } })
      .tools.selfImplement.autoStop).toEqual({ enabled: true, minRung: 2 });
    expect(loadWith({ selfImplement: { autoStop: [] } })
      .tools.selfImplement.autoStop).toEqual({ enabled: true, minRung: 2 });
  });
});
