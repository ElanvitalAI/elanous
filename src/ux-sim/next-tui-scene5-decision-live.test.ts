import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';
import { NEXT_TUI_TITLE } from '../tui/core/render.js';

test('Scene 5 Next TUI rejects tampered packet then retries N and y without an unearned decision', async () => {
  const keptRoot = process.env.ELANOUS_SCENE5_NEXT_OUT?.trim();
  if (keptRoot) mkdirSync(resolve(keptRoot), { recursive: true });
  const root = mkdtempSync(join(keptRoot ? resolve(keptRoot) : tmpdir(), 'next-scene5-decision-'));
  const repo = resolve(import.meta.dir, '..', '..');
  let failureNeedsLogView = false;
  const token = `aps_${'e'.repeat(40)}`;
  const nexus = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/v1/members/owner'
      || request.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
    return Response.json({ memberId: 'scene5-member' });
  } });
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    writeFileSync(join(root, 'next-member-session.test.json'), JSON.stringify({ nexusUrl: `http://127.0.0.1:${nexus.port}`, sessionToken: token }));
    const designPath = join(root, 'ticket-design.json');
    writeFileSync(designPath, JSON.stringify({ service: 'ticketing', concurrentUsers: 100000 }));
    const designSha256 = createHash('sha256').update(readFileSync(designPath)).digest('hex');
    const runId = '11111111-1111-4111-8111-111111111111';
    const attachments = [
      ['diagram-source', 'architecture.excalidraw', 'application/json'],
      ['diagram', 'architecture.png', 'image/png'],
      ['pdf', 'architecture.pdf', 'application/pdf'],
      ['html', 'architecture.html', 'text/html'],
    ].map(([kind, title, mime]) => {
      const url = join(root, title);
      writeFileSync(url, `${kind}: verified Scene 5 artifact`);
      return { kind, title, mime, url, sha256: createHash('sha256').update(readFileSync(url)).digest('hex') };
    });
    const packetBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1, graphId: 'gcp-architect-expand', runId, pendingNode: 'approve', approvalRequired: true,
      designSha256, proposalId: 'proposal-kcb-1', shortageAxes: ['CPU', 'queue'], signalSource: 'synthetic-demo-fixture',
      architecture: 'batch-spot', region: 'asia-northeast3',
      estimate: { formula: 'usage × SKU', skuSource: 'GCP price list', price: 'unpriced' },
      savings: ['idle TTL'], security: { grade: 'internal', controls: ['least privilege'] },
      attachments, realGcpCalls: 0,
    }));
    writeFileSync(join(root, 'next-scene5-decision.test.json'), Buffer.from(JSON.stringify({ ...JSON.parse(packetBytes.toString()), proposalId: 'TAMPERED' })));
    writeFileSync(join(root, 'next-graph-results.test.json'), JSON.stringify({
      'gcp-architect-expand': { graphId: 'gcp-architect-expand', runId, status: 'awaiting-approval',
        pendingNode: 'approve', designSha256,
        packetSha256: createHash('sha256').update(packetBytes).digest('hex') },
    }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 35, cols: 110,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] done',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'SCENE5-PACKET', name: 'ToolSearch',
          args: { query: 'route:GCP 확장안' }, after: { name: 'gcp_architect_expand', args: { ticketDesignPath: designPath } } }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: 'boot', until: screen => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [
        { label: 'tampered proposal', text: 'SCENE5-PACKET 티켓팅 GCP 확장안',
          until: screen => screen.includes('GCP 확장 설계 그래프를 실행할까요?') },
        { label: 'tampered turn complete', keys: 'y', until: screen => {
          if (!screen.includes('턴 완료')) return false;
          failureNeedsLogView = !screen.includes('packet bytes do not match');
          return true;
        } },
        // The Next basic chat hides tool payloads; use its real detailed log view.
        { label: 'tampered failure', get keys() { return failureNeedsLogView ? '\x1b[5~' : ''; },
          until: screen => screen.includes('packet bytes do not match') },
        { label: 'retry input', get keys() { return failureNeedsLogView ? '\x1b' : ''; },
          until: screen => !screen.includes('턴 로그') && !screen.includes('로그 탐색') && screen.includes('턴 완료') },

        { label: 'N proposal', text: () => {
          expect(existsSync(join(root, 'next-graph-calls.test.jsonl'))).toBe(false);
          writeFileSync(join(root, 'next-scene5-decision.test.json'), packetBytes);
          return 'SCENE5-PACKET 티켓팅 GCP 확장안';
        },
          until: screen => screen.includes('GCP 확장 설계 그래프를 실행할까요?') },
        { label: 'N packet', keys: 'y', until: screen => screen.includes('proposal-kcb-1') && screen.includes('비용: usage × SKU') },
        { label: 'N complete', keys: 'n', until: screen => screen.includes('턴 완료') },
        { label: 'y proposal', text: 'SCENE5-PACKET 티켓팅 GCP 확장안',
          until: screen => screen.includes('GCP 확장 설계 그래프를 실행할까요?') },
        { label: 'y packet', keys: 'y', until: screen => screen.includes('proposal-kcb-1') && screen.includes('절감: idle TTL') },
        { label: 'y complete', keys: 'y', until: screen => screen.includes('턴 완료') },
      ],
      ...(keptRoot ? { artifactPath: join(root, 'pty.json') } : {}),
    });
    const calls = readFileSync(join(root, 'next-graph-calls.test.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => call.result.decision)).toEqual(['rejected', 'approved']);
    expect(calls.every(call => call.graphId === 'gcp-architect-expand' && call.result.runId === runId
      && call.verifiedOwner === 'scene5-member' && call.result.realGcpCalls === 0)).toBe(true);
    expect(run.frames.find(frame => frame.label === 'N packet')?.screen).toContain('보안: internal');
    expect(run.frames.find(frame => frame.label === 'tampered failure')?.screen).toContain('packet bytes do not match');
    expect(run.exitCode).toBe(0);
    if (keptRoot) console.log(`Scene 5 Next TUI decision receipt: ${root}`);
  } finally {
    nexus.stop(true);
    if (!keptRoot) rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
