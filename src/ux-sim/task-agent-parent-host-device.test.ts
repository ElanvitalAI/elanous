import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { preflightParentHost, resolveParentHosts } from '../task-agent/parent-host.js';
import {
  HQ_LANDING_PROPOSAL_EVENT,
  PARENT_HOST_DEVICE_EVENTS,
  PARENT_PR_OBSERVATIONS,
  hqLandingProposalCountByPr,
  makeScriptedSshDevice,
  settleHqLandingProposals,
  simParentHostIncident,
} from './task-agent-parent-host-device.js';

const event = (kind: (typeof PARENT_HOST_DEVICE_EVENTS)[number]['kind']) => PARENT_HOST_DEVICE_EVENTS.find((e) => e.kind === kind)!;

describe('parent-host production functions over the fake ssh device (HARNESS-PARENT-ON-MSB1 · 운영 코드 변경 0)', () => {
  test('E1 resolveParentHosts: 고정 호스트 목록이 설정 그대로 · env off 는 []', () => {
    const fixture = event('resolve-parent-hosts');
    expect(resolveParentHosts(fixture.config, fixture.env ?? {})).toEqual([
      { host: 'node-b', cwd: '/Users/me/source/elanous', approvalCapacity: 2 },
      { host: 'node-c', cwd: '/srv/elanous' },
    ]);
    expect(resolveParentHosts(fixture.config, { ELANOUS_TA_PARENT_HOST: 'off' })).toEqual([]);
  });

  test('E2 preflightParentHost: 사실이 다 맞으면 통과 — preflight 질문 한 번, 발사 스크립트 없음', () => {
    const fixture = event('preflight-gap-clear');
    const device = makeScriptedSshDevice(PARENT_HOST_DEVICE_EVENTS);
    const result = preflightParentHost({ target: { host: fixture.host, cwd: fixture.cwd },
      localVersion: fixture.localVersion!, launchHoldActive: false, ssh: device.ssh });
    expect(result).toMatchObject({ ok: true, gaps: [], warnings: [] });
    expect(device.calls).toHaveLength(1);
    expect(device.calls[0]!.host).toBe('node-b');
    expect(device.calls[0]!.script).toContain('--version');
    expect(device.calls.every((call) => !call.script.includes('nohup') && !call.script.includes('rm '))).toBe(true);
  });

  test('E3 preflightParentHost: 판 차이 · 설정 없음 · 발사 동결이 막는다', () => {
    const fixture = event('preflight-gap-blocked');
    const device = makeScriptedSshDevice([fixture]);
    const result = preflightParentHost({ target: { host: fixture.host, cwd: fixture.cwd },
      localVersion: fixture.localVersion!, launchHoldActive: true, ssh: device.ssh });
    expect(result.ok).toBe(false);
    expect(result.gaps).toEqual([
      'version-mismatch: remote 0.2.19 ≠ HQ 0.2.20-dev.0',
      'remote-config-missing', 'remote-pod-pool-unset', 'remote-repo-missing', 'remote-kubectl-missing', 'hq-launch-freeze-active',
    ]);
  });

  test('E4: 네 고정 사건이 실제 운영 경로를 돈다 → parent-host-run ⊕ parent-host-evidence · 사건마다 incident row 정확히 1건', async () => {
    const rows: Record<string, Record<string, unknown>> = {};
    for (const e of PARENT_HOST_DEVICE_EVENTS) {
      const observed = await simParentHostIncident(e.kind);
      expect(observed.incidentRows).toBe(1);
      // 관찰 원장 줄은 장치가 쓴다 — 운영 발사 경로(parent-host.ts)에는 오늘 원장 기록이 없다(이 장치가 메우는 관측 공백).
      expect(observed.ledgerEvents).toContain('parent-host-run');
      expect(observed.ledgerEvents).toContain('parent-host-evidence');
      const line = JSON.parse(observed.incidentLine) as { parentHost?: Record<string, unknown> };
      expect(line.parentHost).toMatchObject({ kind: e.kind, host: observed.host, ...observed.observed });
      rows[e.kind] = line.parentHost!;
    }
    expect(rows['resolve-parent-hosts']).toMatchObject({ hosts: ['node-b', 'node-c'] });
    expect(rows['preflight-gap-clear']).toMatchObject({ ok: true, gaps: [] });
    const blocked = rows['preflight-gap-blocked']!;
    expect(blocked.ok).toBe(false);
    expect(blocked.gaps).toEqual([
      'version-mismatch: remote 0.2.19 ≠ HQ 0.2.20-dev.0',
      'remote-config-missing', 'remote-pod-pool-unset', 'remote-repo-missing', 'remote-kubectl-missing', 'hq-launch-freeze-active',
    ]);
    const launched = rows['launch-remote-parent']!;
    expect(Number(launched.pid)).toBeGreaterThan(0);
    expect(launched.argsRewritten).toBe(true);
    expect(launched.runIdEchoed).toBe(true);
  }, 120_000);

  test('DEVICE-FIRST-STAGE: parent-host device — gate PASS ⊕ review mustFix 0 부모 PR은 HQ 착지 제안 1건, 미충족 PR은 0건', () => {
    const root = mkdtempSync(join(tmpdir(), 'ux-sim-parent-host-hq-'));
    const runId = `run-sim-parent-hq-${randomBytes(4).toString('hex')}`;
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    try {
      // 완료 경계 실물: 같은 PR 의 gate·review 결과(무대 관측)와 HQ 착지 제안 원장의 PR 번호·제안 수를 나란히 비교한다.
      const expectedByPr: Readonly<Record<number, number>> = { 26101: 1, 26102: 0, 26103: 0, 26104: 0 };
      const proposals = settleHqLandingProposals(PARENT_PR_OBSERVATIONS, { runId, dir: runLedgerDir(root) });
      const ledger = loadRunLedger(runId, runLedgerDir(root)) ?? [];
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.event).toBe(HQ_LANDING_PROPOSAL_EVENT);
      const byPr = hqLandingProposalCountByPr(ledger);
      for (const observation of PARENT_PR_OBSERVATIONS) {
        expect([observation.pr, observation.gate, observation.review.mustFix.length, byPr.get(observation.pr) ?? 0])
          .toEqual([observation.pr, observation.gate, observation.review.mustFix.length, expectedByPr[observation.pr]!]);
      }
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toEqual({ pr: 26101, proposals: 1, gate: 'PASS', mustFix: 0 });
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
