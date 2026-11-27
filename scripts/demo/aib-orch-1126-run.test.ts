import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 시험은 --dry-run 계약만 검증한다(데몬·네트워크 0). 운영보다 관대하지 않게:
// flood 실행의 전제(ELANOUS_HISTORY_DIR 방위)는 실제 시험에서도 똑같이 거부되어야 한다.
// 기대값은 제품 상수가 아니라 리터럴(31500-31599 · 30통 · «[합성]» · «nexus run --test»)로 독립 둔다.
setDefaultTimeout(60_000);

const SCRIPT = join(process.cwd(), 'scripts/demo/aib-orch-1126-run.sh');
const SRC = readFileSync(SCRIPT, 'utf8');
const dirs: string[] = [];

function mkd(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', cwd: tmpdir(), env: e });
}

function spawnBg(command: string, argv: string[]): number {
  // argv[0] 을 그대로 명령줄에 남긴다(가짜 nexus 판정용) — ps -o command= 로 보인다.
  const quoted = [command, ...argv].map((a) => JSON.stringify(a)).join(' ');
  const r = spawnSync('bash', ['-c', `${quoted} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' });
  return Number(r.stdout.trim());
}

function alive(pid: number): boolean {
  return spawnSync('ps', ['-p', String(pid)], { encoding: 'utf8' }).status === 0;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('scripts/demo/aib-orch-1126-run.sh — 인자·방위', () => {
  test('인자 없음 → usage exit 2', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect((r.stdout + r.stderr)).toContain('Usage');
  });

  test('알 수 없는 phase/인자 → exit 2', () => {
    expect(run(['--phase', 'nope', '--dry-run']).status).toBe(2);
    expect(run(['--phase', 'boot', '--dry-run', '--wat']).status).toBe(2);
  });

  test('포트 범위 31500-31599 밖 거부 · 안 통과(독립 리터럴)', () => {
    expect(run(['--phase', 'boot', '--dry-run', '--port', '31499']).status).toBe(2);
    expect(run(['--phase', 'boot', '--dry-run', '--port', '31600']).status).toBe(2);
    expect(run(['--phase', 'boot', '--dry-run', '--port', '31500']).status).toBe(0);
    expect(run(['--phase', 'boot', '--dry-run', '--port', '31599']).status).toBe(0);
  });
});

describe('boot — dry-run 부작용 0', () => {
  test('[plan] nexus run --test · setsid · --history-dir · [receipt]', () => {
    const state = join(mkd('orch-boot-'), 'state');
    const r = run(['--phase', 'boot', '--dry-run', '--state-dir', state]);
    expect(r.status).toBe(0);
    // 계약 리터럴: 데몬은 nohup setsid 로 분리 기동된다(원문 형식 = «[plan] cd … && nohup setsid bun …»).
    expect(r.stdout).toContain('nohup setsid bun');
    expect(r.stdout).toContain('nexus run --test --port 31561');
    expect(r.stdout).toContain(`--history-dir ${state}/history`);
    expect(r.stdout).toContain('http://127.0.0.1:31561/app/');
    expect(r.stdout).toContain('[receipt] phase=boot dry-run=1');
    expect(existsSync(state)).toBe(false); // dry-run 은 상태루트를 만들지 않는다
  });
});

describe('flood — 운영 원장 방위(fail-closed)', () => {
  test('실제 flood는 history가 상태루트 안이어도 발송 전 HOLD', () => {
    const base = mkd('orch-flood-hold-');
    const state = join(base, 'state');
    mkdirSync(join(state, 'history'), { recursive: true });
    const r = run(['--phase', 'flood', '--state-dir', state], {
      ELANOUS_HISTORY_DIR: join(state, 'history'),
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('발송 전 fail-closed HOLD');
    expect(r.stdout).not.toContain('msg post');
    expect(r.stdout).not.toContain('phase=flood');
  });

  test('ELANOUS_HISTORY_DIR 미설정 → [refuse] exit 3(dry-run 도)', () => {
    const r = run(['--phase', 'flood', '--dry-run'], { ELANOUS_HISTORY_DIR: undefined });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('[refuse]');
    expect(r.stderr).toContain('fail-closed');
  });

  test('ELANOUS_HISTORY_DIR 가 상태루트 밖 → [refuse] exit 3', () => {
    const base = mkd('orch-flood-');
    const outside = join(base, 'elsewhere');
    mkdirSync(outside);
    const r = run(
      ['--phase', 'flood', '--dry-run', '--state-dir', join(base, 'state')],
      { ELANOUS_HISTORY_DIR: outside },
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('[refuse]');
  });

  test('방위 통과 시: 30통 msg post SIM→OP · 매 통 «[합성]»·«출처:» · dry-run 부작용 0', () => {
    const base = mkd('orch-flood-ok-');
    const state = join(base, 'state');
    const r = run(
      ['--phase', 'flood', '--dry-run', '--state-dir', state],
      { ELANOUS_HISTORY_DIR: join(state, 'history') },
    );
    expect(r.status).toBe(0);
    const plans = r.stdout.split('\n').filter((l) => l.includes('msg post'));
    expect(plans.length).toBe(30);
    for (const line of plans) {
      expect(line).toContain('msg post --from SIM --to OP --kind alert');
      expect(line).toContain('[합성]');
      expect(line).toContain('출처:');
      expect(line).toContain('실제 사고 아님');
    }
    expect(plans.filter((l) => l.includes('우편 폭주')).length).toBe(12);
    expect(plans.filter((l) => l.includes('승인 프롬프트')).length).toBe(8);
    expect(plans.filter((l) => l.includes('도구 거부')).length).toBe(6);
    expect(plans.filter((l) => l.includes('착지 0')).length).toBe(4);
    expect(r.stdout).toContain('[receipt] phase=flood posts=30 marker=DEMO1126_FLOOD_DONE');
    expect(existsSync(state)).toBe(false); // dry-run: 상태루트 미생성
  });
});

describe('briefs — 3막 위임봉투 3(부작용 0)', () => {
  test('뉴스·감성·시장 3봉투 + 완료 기준 + 고지 + [receipt]', () => {
    const r = run(['--phase', 'briefs', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[brief news]');
    expect(r.stdout).toContain('[brief sentiment]');
    expect(r.stdout).toContain('[brief market]');
    expect(r.stdout).toContain('완료 기준');
    expect(r.stdout).toContain('firecrawl 단독');
    expect(r.stdout).toContain('uv run --with requests');
    expect(r.stdout).toContain('투자 권유 아님');
    expect(r.stdout).toContain('실매매 0');
    expect(r.stdout).toContain('[receipt] phase=briefs briefs=3');
  });
});

describe('check · capture', () => {
  test('check dry-run: /app/ 헬스 계획', () => {
    const r = run(['--phase', 'check', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[plan] curl http://127.0.0.1:31561/app/');
  });

  test('capture dry-run: 80×24 규약·screencapture·evidence 경로 — 미생성', () => {
    const ev = join(mkd('orch-cap-'), 'evidence');
    const r = run(['--phase', 'capture', '--dry-run', '--evidence-dir', ev]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('stty rows 24 cols 80');
    expect(r.stdout).toContain('screencapture -x');
    expect(ev.endsWith('evidence')).toBe(true);
    expect(existsSync(ev)).toBe(false);
  });
});

describe('teardown — pidfile 데몬만', () => {
  test('dry-run: pidfile 읽어 명령 확인 후 kill 계획', () => {
    const r = run(['--phase', 'teardown', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ps -o command=');
    expect(r.stdout).toContain('«nexus run --test»');
  });

  test('pidfile 없음 → [skip] exit 0(실모드)', () => {
    const state = mkd('orch-td-skip-');
    const r = run(['--phase', 'teardown', '--state-dir', state]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[skip]');
  });

  test('pidfile 의 프로세스가 nexus run --test 아니면 거부 exit 5(실모드)', () => {
    const state = mkd('orch-td-ref-');
    const pid = spawnBg('/bin/sleep', ['300']);
    expect(alive(pid)).toBe(true);
    writeFileSync(join(state, 'nexus.pid'), `${pid}\n`);
    const r = run(['--phase', 'teardown', '--state-dir', state]);
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('[refuse]');
    expect(alive(pid)).toBe(true); // 거부: 죽이지 않는다
    process.kill(pid);
  });

  test('«nexus run --test» 프로세스만 TERM 정지(실모드) — 가짜 nexus 스크립트', () => {
    const state = mkd('orch-td-kill-');
    const bin = join(state, 'bin');
    mkdirSync(bin);
    const fakeNexus = join(bin, 'nexus');
    // shebang 스크립트로 exec 를 피한다 — ps -o command= 가 «…nexus run --test» 로 보여야 패턴이 통과.
    writeFileSync(
      fakeNexus,
      [
        '#!/bin/bash',
        'trap \'kill "${child:-}" 2>/dev/null; exit 0\' TERM',
        'sleep 600 &',
        'child=$!',
        'wait "$child"',
        '',
      ].join('\n'),
    );
    chmodSync(fakeNexus, 0o755);
    const pid = spawnBg(fakeNexus, ['run', '--test']);
    expect(alive(pid)).toBe(true);
    const tdState = join(state, 'run');
    mkdirSync(tdState);
    writeFileSync(join(tdState, 'nexus.pid'), `${pid}\n`);
    const r = run(['--phase', 'teardown', '--state-dir', tdState]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[receipt] phase=teardown pid=${pid} term`);
    expect(alive(pid)).toBe(false);
  });
});

describe('스크립트 원문 안전 규약', () => {
  test('pkill·killall 없음 · setsid 분리 · fail-closed 문구 존재', () => {
    expect(SRC.includes('pkill')).toBe(false);
    expect(SRC.includes('killall')).toBe(false);
    expect(SRC.includes('setsid')).toBe(true);
    expect(SRC.includes('fail-closed')).toBe(true);
    expect(SRC.includes('--test')).toBe(true);
  });
});

// 실행 권한 비트: git 은 100755 로 기록해야 한다(리허설에서 곧바로 실행).
chmodSync(SCRIPT, 0o755);