import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { AUDITORS, extractKeyNumbers, runWeeklyAudit, selfCheck, type AuditName } from './repo-audit-weekly.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const SCRIPT = new URL('./repo-audit-weekly.ts', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;
const names: AuditName[] = ['goal-marker-population', 'commit-claim-audit', 'goal-method-audit', 'parked-still-broken', 'open-pr-staleness', 'graph-declaration-loss', 'ad-reader-no-writer'];
const GRAPH_DECLARATION_LOSS_OUTPUT = 'graph-declaration-loss · scanned files 9 · graphs 6 · nodes 54 · discarded fields 206 · unknown node keys 0 · unreadable files 0';
const run = (script: string, args: readonly string[] = []) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
const OPEN_PR_STALENESS_OUTPUT = 'open-pr-staleness · 임계 14일 · 의도적 상설 2 · 조건부 보류 0 · 최근 1 · ⚠️ 정지 0';

describe('repo-audit-weekly', () => {
  test('합성 self-check가 성공과 실패 갈래를 모두 보고한다', () => {
    const lines: string[] = [];
    expect(selfCheck(line => lines.push(line))).toBe(0);
    expect(lines.at(-1)).toContain('합성 성공 갈래 통과');
    expect(lines.at(-1)).toContain('합성 실패 갈래 통과');
    expect(lines.at(-1)).toContain('fail-open 계속 통과');
  });

  test('실행 불가 감사자를 이름으로 기록하고 뒤의 감사를 계속 실행하며 오류는 한 줄이다', () => {
    const calls: string[] = [], lines: string[] = [];
    const responses = [
      { status: null, stdout: '', stderr: 'spawn failed\nwith detail', error: 'missing child\nagain' },
      { status: 0, stdout: '훑은 커밋 7 · ⚠️ 적발 2\n', stderr: '' },
      { status: 0, stdout: '축① 로직화 — 조항 6 · ⛔ §0 판정이 «없는» 조항 1\n', stderr: '' },
      { status: 0, stdout: 'parked-still-broken · 지금 통과 1 · 지금도 실패 1 · 골 문서 없음 1 · 대상 시험 없음 1 · 시험 실행 불가 1\n', stderr: '' },
      { status: 0, stdout: `${OPEN_PR_STALENESS_OUTPUT}\n`, stderr: '' },
      { status: 0, stdout: `${GRAPH_DECLARATION_LOSS_OUTPUT}\n`, stderr: '' },
      { status: 0, stdout: 'ad-reader-no-writer · suspects 3\nblindSpots: { spreadSupplied: 1 }\n', stderr: '' },
    ];
    const summaries = runWeeklyAudit((path) => { calls.push(path); return responses[calls.length - 1]!; }, line => lines.push(line), new Date('2026-09-01T12:00:00Z'));
    expect(summaries).toHaveLength(7);
    expect(AUDITORS.at(-1)?.name).toBe('ad-reader-no-writer');
    expect(calls).toEqual(AUDITORS.map(auditor => auditor.path));
    const broken = lines.find(line => line.includes('goal-marker-population'))!;
    expect(broken).toContain('실행 불가(종료 코드 없음)');
    expect(broken).toContain('실패: missing child again');
    expect(broken).not.toContain('\n');
    expect(lines.find(line => line.includes('commit-claim-audit'))).toContain('훑은 커밋 7 · 적발 2');
    expect(lines.find(line => line.includes('goal-method-audit'))).toContain('조항 6');
    expect(lines.find(line => line.includes('parked-still-broken'))).toContain('통과 1 · 실패 1');
    expect(lines.find(line => line.includes('open-pr-staleness'))).toContain('임계 14일 · 상설 2 · 조건부 보류 0 · 최근 1 · 정지 0');
    expect(lines.find(line => line.includes('graph-declaration-loss'))).toContain('파일 9 · 그래프 6 · 노드 54 · 버린 칸 206 · 모르는 키 0 · 못 읽음 0');
  });

  test('실물 open-pr-staleness 산출의 다섯 수를 프로덕션 파서로 추출한다', () => {
    expect(extractKeyNumbers('open-pr-staleness', OPEN_PR_STALENESS_OUTPUT)).toBe('임계 14일 · 상설 2 · 조건부 보류 0 · 최근 1 · 정지 0');
  });

  test('graph-declaration-loss의 분모와 두 손실 수를 프로덕션 파서로 추출한다', () => {
    expect(extractKeyNumbers('graph-declaration-loss', GRAPH_DECLARATION_LOSS_OUTPUT)).toBe('파일 9 · 그래프 6 · 노드 54 · 버린 칸 206 · 모르는 키 0 · 못 읽음 0');
  });

  test('ad-reader-no-writer의 의심과 식별자 spread 사각 수를 프로덕션 파서로 추출한다', () => {
    expect(extractKeyNumbers('ad-reader-no-writer', 'ad-reader-no-writer · suspects 3 · one, two, three\nblindSpots: { spreadSupplied: 7 }')).toBe('의심 3 · 식별자 spread 사각 7');
  });

  test('미래 open-pr-staleness 갈래 추가를 거부해 문면 드리프트를 드러낸다', () => {
    const futureOutput = `${OPEN_PR_STALENESS_OUTPUT} · 새 갈래 3`;
    expect(extractKeyNumbers('open-pr-staleness', futureOutput)).toBe('보고 수 없음');
  });

  test('신호로 끝난 감사자는 실행 불가로 오보하지 않고 신호를 보존한다', () => {
    const lines: string[] = [];
    runWeeklyAudit((path) => path === AUDITORS[0].path
      ? { status: null, signal: 'SIGTERM', stdout: '', stderr: 'terminated' }
      : { status: 0, stdout: '', stderr: '' }, line => lines.push(line));
    const terminated = lines.find(line => line.includes('goal-marker-population'))!;
    expect(terminated).toContain('신호 SIGTERM로 종료(종료 코드 없음)');
    expect(terminated).not.toContain('실행 불가');
  });

  test('CLI self-check는 종료 코드 0으로 네 감사자 이름을 모두 한 장에 낸다', () => {
    const weekly = run(SCRIPT, ['--self-check']);
    expect(weekly.error).toBeUndefined();
    expect(weekly.status).toBe(0);
    for (const name of names) expect(weekly.stdout).toContain(name);
  });

  test('실제 parked 감사자 CLI 출력이 실제 주간 CLI 요약에 반영된다', () => {
    const parked = run(new URL('./parked-still-broken.ts', import.meta.url).pathname);
    const weekly = run(SCRIPT);
    expect(parked.error).toBeUndefined();
    expect(parked.status).toBe(0);
    const match = /지금 통과 (\d+) · 지금도 실패 (\d+) · 골 문서 없음 (\d+) · 대상 시험 없음 (\d+) · 시험 실행 불가 (\d+)/u.exec(parked.stdout);
    expect(match).not.toBeNull();
    expect(weekly.error).toBeUndefined();
    expect(weekly.stdout).toContain('parked-still-broken');
    expect(weekly.stdout).toContain(`통과 ${match![1]} · 실패 ${match![2]} · 문서 없음 ${match![3]} · 시험 없음 ${match![4]} · 실행 불가 ${match![5]}`);
  }, 120_000);

  test('새 감사자가 실행 불가여도 이름과 실패를 기록하고 기존 세 감사자를 끝까지 실행한다', () => {
    const calls: string[] = [], lines: string[] = [];
    const summaries = runWeeklyAudit(path => {
      calls.push(path);
      return path === 'scripts/parked-still-broken.ts'
        ? { status: null, stdout: '', stderr: 'new audit unavailable', error: 'new audit unavailable' }
        : { status: 0, stdout: '', stderr: '' };
    }, line => lines.push(line));
    expect(calls).toEqual(AUDITORS.map(auditor => auditor.path));
    expect(summaries.filter(summary => !summary.failed).map(summary => summary.name)).toEqual(['goal-marker-population', 'commit-claim-audit', 'goal-method-audit', 'open-pr-staleness', 'graph-declaration-loss', 'ad-reader-no-writer']);
    expect(lines.find(line => line.includes('parked-still-broken'))).toContain('실패: new audit unavailable');
  });
});
