// U2 명명 중립화 — `elanous agent-mission`(canonical) + `codex`(deprecated alias) 하위호환·관측 판정 검증.
//
// (a) isLegacyCodexInvocation 순수 판정 — argv[2] 브리틀함 대신 첫 positional 토큰 스캔의 강건성.
// (b) CLI surface(subprocess) — canonical 과 alias 가 같은 명령으로 resolve 되는지(cron 하위호환 acceptance).
//   cli-wf-aliases.test.ts 패턴 재사용(in-process 액션 재실행이 아니라 commander 를 실사용자처럼 구동).

import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { isLegacyCodexInvocation } from '../src/agent-mission/legacy-alias.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const ENTRY = resolve(import.meta.dir, '..', 'src', 'index.ts');

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', [ENTRY, ...args], { encoding: 'utf-8', env: { ...process.env, ...env } });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('isLegacyCodexInvocation — 첫 positional 토큰 판정(robust)', () => {
  it('codex 가 명령이면 legacy=true', () => {
    expect(isLegacyCodexInvocation(['bun', '/x/index.ts', 'codex', 'review-watch', '--once'])).toBe(true);
  });
  it('agent-mission 이 명령이면 legacy=false', () => {
    expect(isLegacyCodexInvocation(['bun', '/x/index.ts', 'agent-mission', 'review-watch'])).toBe(false);
  });
  it('선행 옵션 플래그를 스킵하고 첫 positional 을 명령으로 판정(argv[2] 브리틀함 회피)', () => {
    // --config-dir 는 상류(applyConfigDirFlagFromArgv)에서 제거된 상태로 도달 → 남는 선행 플래그만 스킵.
    expect(isLegacyCodexInvocation(['bun', '/x/index.ts', '--foo', 'codex', 'mission'])).toBe(true);
  });
  it('canonical 뒤 미션 텍스트에 "codex" 가 섞여도 legacy=false(명령 토큰이 먼저)', () => {
    expect(isLegacyCodexInvocation(['bun', '/x/index.ts', 'agent-mission', 'mission', 'codex 를 붙여줘'])).toBe(false);
  });
  it('codex 뒤 미션 텍스트에 "agent-mission" 이 섞여도 legacy=true(명령 토큰이 먼저)', () => {
    expect(isLegacyCodexInvocation(['bun', '/x/index.ts', 'codex', 'mission', 'agent-mission 처럼'])).toBe(true);
  });
  it('agent-mission/codex 어느 것도 아니면 false', () => {
    expect(isLegacyCodexInvocation(['bun', '/x/index.ts', 'chat', '안녕'])).toBe(false);
  });
});

describe('elanous agent-mission — codex alias 하위호환(subprocess)', () => {
  it('`agent-mission --help` 는 canonical 명령으로 resolve', () => {
    const r = run(['agent-mission', '--help']);
    expect(r.code).toBe(0);
    // commander 는 usage 에 `agent-mission|codex` 처럼 두 이름을 렌더.
    expect(r.stdout).toMatch(/agent-mission\|codex/);
  });

  it('`codex --help` (deprecated alias) 도 같은 명령으로 resolve — cron 하위호환', () => {
    const r = run(['codex', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/agent-mission\|codex/);
    // 서브커맨드가 alias 아래에도 노출.
    expect(r.stdout).toContain('review-watch');
    expect(r.stdout).toContain('mission');
  });

  it('`codex review-watch --help` (라이브 cron 명령) 이 여전히 resolve', () => {
    const r = run(['codex', 'review-watch', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('review-watch');
  });

  it('`agent-mission mission --help` 는 애그노스틱 --backend 옵션 노출(U1 정합)', () => {
    const r = run(['agent-mission', 'mission', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--backend');
  });

  it('기존 최상위 `agent <text>`(single-turn) 명령은 무충돌(별개 명령)', () => {
    const r = run(['agent', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Single-turn agent');
  });
});

describe('preAction 관측 배선 — 레거시 alias 브레드크럼이 logs.db 도달(E2E)', () => {
  // 격리 ELANOUS_STATE_DIR 에 실제 CLI 를 구동 → preAction 훅이 sink 등록+브레드크럼 → 같은 스토어를
  // `elanous logs --category` 로 조회(관측 경로 end-to-end). `models` 는 비대화·무네트워크로 안전·빠름.
  // ⚠️ NODE_ENV='development' — bun test 러너가 NODE_ENV=test 를 주입하는데 그 값이면 로그 스토어가
  //   skip 되어(테스트 격리 동작) db 미생성. 프로덕션 cron(NODE_ENV 미설정)을 반영하려 비-test 로 오버라이드.
  const PROD_ENV = { NODE_ENV: 'development' };
  function withTmpState<T>(fn: (stateDir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'u2-alias-'));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('codex(legacy) 진입 → agent-cli.alias/legacy-codex-invoked 가 logs.db 에 기록', () => {
    withTmpState((stateDir) => {
      const env = { ...PROD_ENV, ELANOUS_STATE_DIR: stateDir };
      const cmd = run(['codex', 'models'], env);
      expect(cmd.code).toBe(0); // 명령 성공을 먼저 보장(vacuous pass 방지)
      const logs = run(['logs', '--category', 'agent-cli.alias'], env);
      expect(logs.code).toBe(0);
      const out = logs.stdout + logs.stderr;
      expect(out).toContain('legacy-codex-invoked');
      expect(out).toContain('"sub":"models"');
    });
  });

  it('canonical agent-mission 진입 → 브레드크럼 미기록(alias 만 남긴다·오탐 없음)', () => {
    withTmpState((stateDir) => {
      const env = { ...PROD_ENV, ELANOUS_STATE_DIR: stateDir };
      const cmd = run(['agent-mission', 'models'], env);
      expect(cmd.code).toBe(0); // 명령·싱크 실패 시 not.toContain 가 헛통과하지 않도록 성공 보장
      // ⛔⭐ **`--instance` 로 내 우주만 본다**(2026-07-30 실측) — `elanous logs` 의 기본 타겟은
      //   *"내 우주 ⊕ 운영"* 이다(설계 · logs-cli.ts P5: 격리에서 조회하다 운영 로그를 통째로
      //   못 찾는 사고를 막으려고 그렇게 정했다). 그래서 **부재 단언**을 기본 타겟으로 하면
      //   운영의 `review-watch` 크론 브레드크럼 수십 줄에 걸려 **항상 실패**한다.
      //   ⇒ 부재를 재려면 **우주를 좁혀야 한다**. (⚠️ 이 테스트는 main 에서 조용히 빨간색이었다)
      const logs = run(['logs', '--category', 'agent-cli.alias', '--instance', basename(stateDir)], env);
      expect(logs.code).toBe(0);
      expect(logs.stdout + logs.stderr).not.toContain('legacy-codex-invoked');
    });
  });

  it('--config-dir 경로가 있어도 alias 판정 정확(값이 명령 토큰을 가리지 않음)', () => {
    // 리뷰 우려(옵션 값이 명령으로 오판)의 실파이프라인 반증 — config-dir 는 Commander 이전 argv 에서 제거됨.
    withTmpState((stateDir) => {
      const cfgDir = mkdtempSync(join(tmpdir(), 'u2-cfg-'));
      try {
        const env = { ...PROD_ENV, ELANOUS_STATE_DIR: stateDir };
        const cmd = run(['--config-dir', cfgDir, 'codex', 'models'], env);
        expect(cmd.code).toBe(0);
        const logs = run(['--config-dir', cfgDir, 'logs', '--category', 'agent-cli.alias'], env);
        expect(logs.code).toBe(0);
        expect(logs.stdout + logs.stderr).toContain('legacy-codex-invoked');
      } finally { rmSync(cfgDir, { recursive: true, force: true }); }
    });
  });
});
