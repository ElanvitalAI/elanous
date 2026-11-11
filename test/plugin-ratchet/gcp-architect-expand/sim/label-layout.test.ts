import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyArchitectureOutput } from '../../../../src/ux-sim/gcp-architect-expand/output-contract.js';

test('long Solar component names wrap and abbreviate inside the editable diagram box', () => {
  const root = mkdtempSync(join(tmpdir(), 'gcpx-long-label-'));
  const repo = resolve(import.meta.dir, '../../../..');
  try {
    const proposal = JSON.parse(readFileSync(join(repo, 'plugins/gcp-architect-expand/sim/sample-output/proposal.json'), 'utf8'));
    proposal.ticketDesign.localComponents = [
      '구매 주문을 멱등 처리하고 장애 시 재시도하는 고객 요청 API 서비스',
      '좌석 재고를 선점하고 중복 확정을 막는 PostgreSQL 트랜잭션 원장',
      '결제 승인·웹훅·환불 상태를 대사하는 외부 결제 연동 서비스',
    ];
    const proposalPath = join(root, 'proposal.json');
    writeFileSync(proposalPath, JSON.stringify(proposal));
    const out = join(root, 'out');
    const python = join(repo, 'skills/diagram-master/references/.venv/bin/python');
    const result = Bun.spawnSync([python, join(repo, 'scripts/gcp-architect-expand/sim/build-sample.py'), '--proposal', proposalPath,
      '--output', out], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    const diagram = JSON.parse(readFileSync(join(out, 'architecture.excalidraw'), 'utf8'));
    const border = diagram.elements.find((item: {id:string}) => item.id === 'ticket-local-app');
    const label = diagram.elements.find((item: {id:string}) => item.id === 'ticket-local-components');
    expect(label.text.split('\n')).toHaveLength(2);
    expect(label.text).toContain('…');
    expect(label.x).toBeGreaterThan(border.x);
    expect(label.y).toBeGreaterThan(border.y);
    expect(label.x + label.width).toBeLessThan(border.x + border.width);
    expect(label.y + label.height).toBeLessThan(border.y + border.height);
    expect(verifyArchitectureOutput(out)).toEqual({ ok: true, errors: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
