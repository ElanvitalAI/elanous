import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OP #90409 후속 — codex 계정 기본값 'team' → 'default' 계약.
 * 크레딧 장부의 team 소비(−6,526) 원인과 같은 꼴: CLI 경로는 account 를 늘 채우지만
 * 미지정 경로의 기본값이 'team' 이면 team 크레딧이 소모된다.
 * 세 지점 모두 explicit account 없으면 'default' 로 떨어져야 한다.
 * (pod-child-providers.ts 는 #38646 에서 이미 수리됨 — 이 시험은 잔여 3곳을 건다)
 */
const surfaces = {
  warmHost: join(import.meta.dir, '../src/task-orchestrator/surfaces/pod-si-warm-host.ts'),
  selfImpl: join(import.meta.dir, '../src/task-orchestrator/surfaces/self-implement-pod.ts'),
} as const;

describe('codex account 기본값 = default (OP #90409)', () => {
  test('pod-si-warm-host: plannedAccount 폴백이 default 이다', () => {
    const src = readFileSync(surfaces.warmHost, 'utf8');
    expect(src).toContain("?? options.account ?? 'default'");
    expect(src).not.toContain("?? 'team'");
  });

  test('self-implement-pod: roleChild provider 폴백이 default 이다', () => {
    const src = readFileSync(surfaces.selfImpl, 'utf8');
    expect(src).toContain("options.accountBroker?.() ?? options.account ?? 'default'");
    expect(src).not.toContain("?? 'team'");
  });

  test('self-implement-pod: roleCodexAccount 폴백이 default 이다', () => {
    const src = readFileSync(surfaces.selfImpl, 'utf8');
    expect(src).toContain("const roleCodexAccount = options.account ?? 'default'");
  });
});
