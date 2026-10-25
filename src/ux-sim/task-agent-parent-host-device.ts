import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRunLedgerEntry, loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { launchRemoteParent, preflightParentHost, resolveParentHosts, type ParentHostSetting, type SshRunner } from '../task-agent/parent-host.js';

/**
 * L2 가짜 ssh 장치 — HARNESS-PARENT-ON-MSB1 의 부모-호스트 사건(호스트 목록 해석 · 발사 전 점검 gap 통과/차단 ·
 * 원격 부모 발사)을 고정 입력으로 주입해, 생산 함수 `resolveParentHosts`·`preflightParentHost`·`launchRemoteParent`
 * (`src/task-agent/parent-host.ts`)를 «운영 코드 변경 0»으로 mock 무대에서 돌려 관찰한다.
 * 장치는 운영 코드가 아니다 — 생산 함수의 질의(ssh 스크립트)에만 스크립트대로 답한다.
 *
 * 관측 공백(장치가 메운다): 운영 발사 경로에는 원장 기록이 없다 — 장치가 사건마다 `parent-host-run`(시작) ⊕
 * `parent-host-evidence`(증거) 관찰 줄과 incident row 한 줄을 임시 ELANOUS_STATE_DIR 하나에만 쓰고 지운다.
 *
 * 현재 계약(RED 기록 대상): 원격 부모 PR 은 게이트 PASS ⊕ 리뷰 must-fix 0 이어도 HQ 에 착지 노드가 없어
 * draft 로 남는다(10-14 06:2x 120건) — `settleHqLandingProposals` 가 «자격 PR 은 제안 1건, 미충족 PR 은
 * 제안 0건» 경계를 HQ 착지 제안 원장에 고정한다. 실제 원장 결속이 운영 코드에 들어오면 이 시험이 그 착지의
 * 회귀가 된다.
 */
export type ParentHostDeviceEventKind =
  | 'resolve-parent-hosts'
  | 'preflight-gap-clear'
  | 'preflight-gap-blocked'
  | 'launch-remote-parent';

export interface ParentHostDeviceEvent {
  kind: ParentHostDeviceEventKind;
  host: string;
  cwd: string;
  /** E1 — resolveParentHosts 에 주입할 `taskAgent.parentHost` 설정(목록). */
  config?: ParentHostSetting;
  /** E1 — env 축(`ELANOUS_TA_PARENT_HOST`). */
  env?: Record<string, string>;
  /** E2/E3 — preflight 판 기준(HQ 판). */
  localVersion?: string;
  /** E2/E3 — HQ 발사 동결 칸. */
  launchHoldActive?: boolean;
  /** E2/E3 — 스크립트 장치가 발사 전 점검 질문에 답하는 key=value 사실 줄. */
  facts?: string;
}

export interface ParentHostDeviceCall { host: string; script: string; stdin?: string }

export interface ScriptedSshDevice {
  ssh: SshRunner;
  calls: ParentHostDeviceCall[];
}

/** 부모-호스트 고정 사건 넷 — E4(launch-remote-parent)는 로컬 sh 실제 spawn 으로 돈다. */
export const PARENT_HOST_DEVICE_EVENTS: readonly ParentHostDeviceEvent[] = [
  {
    kind: 'resolve-parent-hosts', host: 'node-b', cwd: '/Users/me/source/elanous',
    config: [{ host: 'node-b', cwd: '/Users/me/source/elanous', approvalCapacity: 2 }, { host: 'node-c', cwd: '/srv/elanous' }], env: {},
  },
  {
    kind: 'preflight-gap-clear', host: 'node-b', cwd: '/Users/me/source/elanous', localVersion: '0.2.20-dev.0',
    facts: 'version=0.2.20-dev.0\nconfig=1\npodPool=1\nrepo=1\nkubectl=1\ncodexAccounts=3\ngrok=1\nopenrouter=1\n',
  },
  {
    kind: 'preflight-gap-blocked', host: 'node-c', cwd: '/srv/elanous', localVersion: '0.2.20-dev.0', launchHoldActive: true,
    facts: 'version=0.2.19\n',
  },
  { kind: 'launch-remote-parent', host: 'node-b', cwd: '/Users/me/source/elanous' },
];

export function makeScriptedSshDevice(events: readonly ParentHostDeviceEvent[]): ScriptedSshDevice {
  const calls: ParentHostDeviceCall[] = [];
  const ssh: SshRunner = (host, script, _timeoutMs, stdin) => {
    calls.push({ host, script, ...(stdin !== undefined ? { stdin } : {}) });
    // 발사 전 점검 사건만 답한다 — 같은 호스트의 다른 사건(E1 해석 · E4 발사)은 점검 질문에 답하지 않는다.
    const fixture = events.find((candidate) => candidate.host === host && candidate.facts !== undefined);
    if (!fixture?.facts) return { status: 1, stdout: '', stderr: `no preflight fixture for host ${host}` };
    // 점검 질문(preflightScript)에만 사실 줄로 답한다 — 그 밖의 스크립트는 조용히 성공(빈 출력).
    if (script.includes('--version')) return { status: 0, stdout: fixture.facts, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { ssh, calls };
}

// ── HQ 착지 제안 결속(완료 경계 · RED 조각) ─────────────────────────────────────────────

/** HQ 착지 제안 원장 이벤트 — 자격 PR 마다 정확히 한 줄(제안 1건)이고 미충족 PR 은 줄이 없다(= 0건). */
export const HQ_LANDING_PROPOSAL_EVENT = 'hq-landing-proposal';

/** 같은 PR 에 대한 무대 관측 — gate 결과와 self review(must-fix 목록)가 나란히 있다. */
export interface ParentPrObservation {
  pr: number;
  gate: 'PASS' | 'FAIL';
  review: { verdict: 'pass' | 'fail'; mustFix: readonly string[] };
}

/** HQ 무대가 관측한 부모 PR 고정 입력 — 26101 만 자격, 나머지는 미충족 축(gate FAIL · must-fix > 0)마다 하나씩. */
export const PARENT_PR_OBSERVATIONS: readonly ParentPrObservation[] = [
  { pr: 26101, gate: 'PASS', review: { verdict: 'pass', mustFix: [] } },
  { pr: 26102, gate: 'FAIL', review: { verdict: 'pass', mustFix: [] } },
  { pr: 26103, gate: 'PASS', review: { verdict: 'fail', mustFix: ['같은 must-fix 서명의 재발사는 같은 수로 하지 않는다'] } },
  { pr: 26104, gate: 'PASS', review: { verdict: 'pass', mustFix: ['좁혀 재발사할 must-fix 하나', '남은 must-fix 둘'] } },
];

export interface HqLandingProposal {
  pr: number;
  /** 자격 PR 의 제안 수는 정확히 1이다. */
  proposals: 1;
  gate: 'PASS';
  mustFix: 0;
}

/** 이 리뷰의 must-fix 수 — 목록이 없으면 «0이 아니라 못 쟀다»(-1)로, 자격 판정에 통과로 접히지 않게 한다. */
function mustFix(review: { mustFix?: readonly string[] }): number {
  if (!Array.isArray(review.mustFix)) return -1;
  return review.mustFix.filter((finding) => typeof finding === 'string' && finding.trim() !== '').length;
}

export interface HqLandingProposalSettleOptions {
  /** 제안 원장을 쓸 런 원장 디렉터리(ux-sim mock 무대). 주어지면 제안마다 원장 줄을 쓴다. */
  dir?: string;
  /** 제안 원장 줄의 runId. */
  runId?: string;
}

/**
 * 완료 경계 코드: 게이트 PASS ⊕ 리뷰 must-fix 0 인 부모 PR 은 HQ 착지 제안 «한 건»으로 결속하고 조건을
 * 충족하지 않은 PR(gate FAIL 또는 must-fix > 0)은 제안 0건이다. 원격 부모 PR 이 draft 로 남는 현재 계약을
 * 닫는 결속 규칙 — 장치(mock 무대)가 운영 코드 변경 0으로 이 경계를 원장에 고정한다.
 */
export function settleHqLandingProposals(observations: readonly ParentPrObservation[], options: HqLandingProposalSettleOptions = {}): readonly HqLandingProposal[] {
  const proposals: HqLandingProposal[] = [];
  for (const observation of observations) {
    if (!Number.isSafeInteger(observation.pr) || observation.pr <= 0) throw new Error(`invalid parent PR number: ${String(observation.pr)}`);
    if (observation.gate !== 'PASS') continue;
    if (observation.review.verdict !== 'pass') continue;
    if (mustFix(observation.review) !== 0) continue;
    proposals.push({ pr: observation.pr, proposals: 1, gate: observation.gate, mustFix: 0 });
  }
  if (options.dir !== undefined) {
    if (!options.runId) throw new Error('runId is required to record HQ landing proposals');
    for (const proposal of proposals) {
      appendRunLedgerEntry({ runId: options.runId, event: HQ_LANDING_PROPOSAL_EVENT,
        data: { pr: proposal.pr, proposals: proposal.proposals, gate: proposal.gate, mustFix: proposal.mustFix } }, options.dir);
    }
  }
  return proposals;
}

/** 제안 원장을 PR 번호 → 제안 수로 접는다(완료 경계 실물 비교의 읽기). 줄이 없는 PR 은 맵에 없다(= 0건). */
export function hqLandingProposalCountByPr(entries: readonly { event: string; data: Record<string, unknown> }[]): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const entry of entries) {
    if (entry.event !== HQ_LANDING_PROPOSAL_EVENT) continue;
    const pr = entry.data.pr;
    const proposals = entry.data.proposals;
    if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || typeof proposals !== 'number' || !Number.isSafeInteger(proposals) || proposals < 1) continue;
    counts.set(pr, (counts.get(pr) ?? 0) + proposals);
  }
  return counts;
}

// ── E사다리: 사건 하나를 «생산 경로 그대로» 돌린다 ───────────────────────────────────────

export interface ParentHostIncidentObservation {
  readonly injectionId: string;
  readonly kind: ParentHostDeviceEventKind;
  readonly host: string;
  /** 이 사건이 실제 운영 경로에서 관측한 결과(호스트 목록 · preflight 판정 · 발사 영수증). */
  readonly observed: Readonly<Record<string, unknown>>;
  /** 장치가 임시 원장에 쓴 관찰 이벤트 이름(`parent-host-run` ⊕ `parent-host-evidence`). */
  readonly ledgerEvents: readonly string[];
  /** 이 런의 `incidents/YYYY-MM-DD.jsonl` 줄 원문. */
  readonly incidentLine: string;
  readonly incidentRows: number;
}

/** E4 실제 spawn — 원격 발사 스크립트를 진짜 셸(ssh 대신 로컬 sh · HOME = 임시 원격 홈)에서 돈다. */
function realShellSsh(remoteHome: string): SshRunner {
  return (_host, script, timeoutMs, stdin) => {
    // ProcessEnv 의 ambient NODE_ENV 요구는 이 원격 홈의 몫이 아니다(pod-device 패턴: `{} as NodeJS.ProcessEnv`).
    const result = spawnSync('sh', ['-c', script], {
      encoding: 'utf8', timeout: timeoutMs, ...(stdin !== undefined ? { input: stdin } : {}),
      env: Object.assign({} as NodeJS.ProcessEnv, { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: remoteHome }),
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

/** 임시 원격 홈 — 설치본 경로(`$HOME/.local/share/elanous/bin/elanous`)에 살아 있는 부모 흉내 스크립트. */
function fakeRemoteHome(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), 'ux-sim-parent-host-remote-'));
  const bin = join(home, '.local/share/elanous/bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'elanous'), '#!/bin/sh\necho "args: $*"; echo "run=$ELANOUS_RUN_ID"; sleep 5\n');
  chmodSync(join(bin, 'elanous'), 0o755);
  const cwd = join(home, 'repo');
  mkdirSync(cwd);
  return { home, cwd };
}

/** incident row 한 줄 — 임시 무대의 `incidents/YYYY-MM-DD.jsonl` 에 붙인다(운영 incidents 저장소 무접촉). */
function recordParentHostIncident(root: string, row: Record<string, unknown>): void {
  const dir = join(root, 'incidents');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8');
}

/**
 * 한 사건을 «생산 경로 그대로» 돌린다: 진짜 `resolveParentHosts` · 진짜 `preflightParentHost`(ssh = 이 장치) ·
 * 진짜 `launchRemoteParent`(ssh = 로컬 sh 실제 spawn) → 장치가 쓴 관찰 원장(`parent-host-run` ⊕
 * `parent-host-evidence`) → incident JSONL 한 줄. 실 ssh·원격 호스트·LLM·네트워크 0 · 쓰기는 임시
 * ELANOUS_STATE_DIR 하나에만 가고 지운다.
 */
export async function simParentHostIncident(kind: ParentHostDeviceEventKind): Promise<ParentHostIncidentObservation> {
  const fixture = PARENT_HOST_DEVICE_EVENTS.find((event) => event.kind === kind);
  if (!fixture) throw new Error(`no device event: ${kind}`);
  const suffix = randomBytes(4).toString('hex');
  const runId = `run-sim-parent-host-${suffix}`;
  const injectionId = `parent-host:${kind}:${suffix}`;
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-parent-host-'));
  const ledgerDir = runLedgerDir(root);
  let remote: { home: string; cwd: string } | undefined;
  let launchedPid: number | undefined;
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    let observed: Record<string, unknown>;
    if (kind === 'resolve-parent-hosts') {
      // ProcessEnv 의 ambient NODE_ENV 요구는 이 사건 env 의 몫이 아니다(pod-device 패턴).
      observed = { hosts: resolveParentHosts(fixture.config, Object.assign({} as NodeJS.ProcessEnv, fixture.env ?? {})).map((target) => target.host) };
    } else if (kind === 'preflight-gap-clear' || kind === 'preflight-gap-blocked') {
      const device = makeScriptedSshDevice([fixture]);
      const preflight = preflightParentHost({ target: { host: fixture.host, cwd: fixture.cwd },
        localVersion: fixture.localVersion ?? '0.2.20-dev.0', launchHoldActive: fixture.launchHoldActive ?? false, ssh: device.ssh });
      observed = { ok: preflight.ok, gaps: preflight.gaps, warnings: preflight.warnings };
    } else {
      remote = fakeRemoteHome();
      const launched = launchRemoteParent({ host: fixture.host, cwd: remote.cwd },
        ['harness', 'say', '--merge-by-host', `ux-sim ${injectionId}`], { ELANOUS_RUN_ID: runId }, realShellSsh(remote.home));
      launchedPid = launched.pid;
      const log = readFileSync(join(remote.home, '.elanous', 'remote-parents', `${runId}.log`), 'utf8');
      observed = { pid: launched.pid,
        argsRewritten: log.includes('--no-auto-merge') && !log.includes('--merge-by-host'),
        runIdEchoed: log.includes(`run=${runId}`) };
    }
    appendRunLedgerEntry({ runId, event: 'parent-host-run', data: { kind, host: fixture.host, feature: `ux-sim ${injectionId}` } }, ledgerDir);
    appendRunLedgerEntry({ runId, event: 'parent-host-evidence', data: { kind, host: fixture.host, observed } }, ledgerDir);
    recordParentHostIncident(root, { at: new Date().toISOString(), runId, reason: `ux-sim ${injectionId}`,
      parentHost: { kind, host: fixture.host, ...observed } });
    const ledgerEvents = (loadRunLedger(runId, ledgerDir) ?? []).map((entry) => entry.event);
    const incidents = join(root, 'incidents');
    const lines = (existsSync(incidents) ? readdirSync(incidents) : []).flatMap((file) => readFileSync(join(incidents, file), 'utf8').split('\n')).filter(Boolean);
    return { injectionId, kind, host: fixture.host, observed, ledgerEvents,
      incidentLine: lines.find((line) => line.includes(runId)) ?? '', incidentRows: lines.length };
  } finally {
    if (launchedPid !== undefined) {
      // 살아 있던 부모 흉내(sleep 5)는 여기서 끈다 — 임시 무대 밖 프로세스를 남기지 않는다.
      try { process.kill(launchedPid); } catch { /* 이미 끝남 */ }
    }
    if (remote) rmSync(remote.home, { recursive: true, force: true });
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    rmSync(root, { recursive: true, force: true });
  }
}
