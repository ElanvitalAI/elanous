import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('ticket design becomes an unpriced single-GCP proposal; purchase path stays local', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcp-ticket-demo-'));
  try {
    const input = join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json');
    const pressure = join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/pressure.json');
    const output = join(dir, 'proposal.json');
    const result = spawnSync('bun', [join(import.meta.dir, '../../../../scripts/gcp-architect-expand/demo/propose.ts'), '--ticket-design', input,
      '--pressure', pressure, '--output', output], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const proposal = JSON.parse(readFileSync(output, 'utf8'));
    expect(proposal.architecture).toBe('batch-spot');
    expect(proposal.region).toBe('asia-northeast3');
    expect(proposal.comparisonRegion).toBe('us-central1');
    expect(proposal.estimate.price).toBe('unpriced');
    expect(proposal.security.grade).toBe('internal');
    expect(proposal.ticketDesign.localComponents).toContain('결제');
    expect(proposal.realGcpCalls).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Korean ticketing design without a region defaults to Seoul', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcp-ticket-region-'));
  try {
    const design = JSON.parse(readFileSync(join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json'), 'utf8'));
    delete design.region;
    const input = join(dir, 'design.json');
    const output = join(dir, 'proposal.json');
    writeFileSync(input, JSON.stringify(design));
    const result = spawnSync('bun', [join(import.meta.dir, '../../../../scripts/gcp-architect-expand/demo/propose.ts'), '--ticket-design', input,
      '--pressure', join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/pressure.json'), '--output', output], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8')).region).toBe('asia-northeast3');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sensitive or non-retryable ticketing workload fails before proposal output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcp-ticket-deny-'));
  try {
    const input = join(dir, 'design.json');
    const design = JSON.parse(readFileSync(join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json'), 'utf8'));
    design.containsPii = true;
    design.retryable = false;
    writeFileSync(input, JSON.stringify(design));
    const output = join(dir, 'proposal.json');
    const result = spawnSync('bun', [join(import.meta.dir, '../../../../scripts/gcp-architect-expand/demo/propose.ts'), '--ticket-design', input,
      '--pressure', join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/pressure.json'), '--output', output], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ticketing purchase or sensitive path cannot be moved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('structured architect JSON plus existing measured pressure produces an attributed proposal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcp-ticket-measured-'));
  try {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json'), 'utf8'));
    const input = join(dir, 'design-result.json');
    writeFileSync(input, JSON.stringify({ source: { sessionId: 'test-session' }, runId: 'test-graph-run', ticketDesign: fixture }));
    const pressure = join(dir, 'pressure.json');
    writeFileSync(pressure, JSON.stringify({ observedAt: '2026-11-10T10:00:00.000Z', shortage: true,
      cpu: { status: 'shortage', observed: 1.2, source: 'self-dev/shard-run:load1/cores' },
      memory: { status: 'sufficient', observed: 8, source: 'self-dev/shard-run:freeMemoryGiB' },
      disk: { status: 'sufficient', observed: 20, source: 'self-dev/shard-run:freeTmpGiB' },
      queue: { status: 'sufficient', observed: 0, source: 'harness/queue:queued' } }));
    const output = join(dir, 'proposal.json');
    const result = spawnSync('bun', [join(import.meta.dir, '../../../../scripts/gcp-architect-expand/demo/propose.ts'), '--ticket-design', input,
      '--pressure', pressure, '--output', output], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const proposal = JSON.parse(readFileSync(output, 'utf8'));
    expect(proposal.ticketDesign.sourceSessionId).toBe('test-session');
    expect(proposal.ticketDesign.sourceGraphRunId).toBe('test-graph-run');
    expect(proposal.signalSource).toBe('existing-self-dev-and-harness-queue');
    expect(proposal.shortageAxes).toEqual(['cpu']);
    expect(proposal.signal.cpu.observed).toBe(1.2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
