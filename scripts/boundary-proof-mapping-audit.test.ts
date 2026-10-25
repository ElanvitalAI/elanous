import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditBoundaryMappings } from './boundary-proof-mapping-audit.js';

describe('boundary proof mapping audit', () => {
  test('a runnable test command is review-required, never proof or green', () => {
    const rows = auditBoundaryMappings({ version: '0.2.37', items: [{ id: 'LIVE', owner: 'TC', status: 'yellow',
      title: '완료 경계 실물: add 뒤 다른 프로세스 list 확인\n완료 경계 증거 명령: bun test src/cli/org-cli.test.ts' }] });
    expect(rows).toEqual([{ id: 'LIVE', owner: 'TC', state: 'test-run-review-required',
      liveBoundary: 'add 뒤 다른 프로세스 list 확인', evidenceCommand: 'bun test src/cli/org-cli.test.ts',
      reason: 'test-command-syntax-only-live-assertion-unproven' }]);
  });

  test('shell syntax, missing command, and ambiguous live lines stay unverified', () => {
    const rows = auditBoundaryMappings({ version: '0.2.37', items: [
      { id: 'SHELL', status: 'yellow', title: '완료 경계 실물: CLI 검증\n완료 경계 증거 명령: bun test x.test.ts; rm x' },
      { id: 'MISSING', status: 'yellow', title: '완료 경계 실물: 실물 관찰' },
      { id: 'DUP', status: 'yellow', title: '완료 경계 실물: A\n완료 경계 실물: B' },
      { id: 'GREEN', status: 'green', title: '완료 경계 실물: 완료' },
    ] });
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ['SHELL', 'manual-verifier-required'], ['MISSING', 'manual-verifier-required'],
      ['DUP', 'invalid-boundary'],
    ]);
  });

  test('typed mapping stays unverified until a production replay', () => {
    const rows = auditBoundaryMappings({ version: '0.2.37', items: [{ id: 'MAPPED', status: 'yellow',
      title: '완료 경계 실물: graph output\n완료 경계 실물 검증: [{"kind":"graph-run"}]' }] });
    expect(rows[0]).toMatchObject({ id: 'MAPPED', state: 'mapped-unverified',
      reason: 'typed-mapping-needs-production-replay' });
  });

  test('CLI reads a supplied snapshot and rejects unknown arguments or malformed inventory', () => {
    const root = mkdtempSync(join(tmpdir(), 'boundary-audit-'));
    const snapshot = join(root, 'status.json');
    const run = (...args: string[]) => Bun.spawnSync([process.execPath,
      join(import.meta.dir, 'boundary-proof-mapping-audit.ts'), ...args],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    try {
      writeFileSync(snapshot, JSON.stringify({ version: '0.2.37', items: [
        { id: 'LIVE', status: 'yellow', title: '완료 경계 실물: observed output' },
      ] }));
      const good = run('--version', '0.2.37', '--snapshot', snapshot, '--json');
      expect(good.exitCode).toBe(0);
      expect(JSON.parse(good.stdout.toString())).toMatchObject({ yellowTotal: 1, yellowLive: 1,
        yellowWithoutLive: 0,
        byState: { 'manual-verifier-required': 1 } });
      expect(run('garbage', '--version', '0.2.37', '--snapshot', snapshot, '--json').exitCode).toBe(2);
      writeFileSync(snapshot, JSON.stringify({ version: '0.2.37', items: [{ id: 'BROKEN', status: 'yellow' }] }));
      const bad = run('--version', '0.2.37', '--snapshot', snapshot, '--json');
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr.toString()).toContain('invalid inventory');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
