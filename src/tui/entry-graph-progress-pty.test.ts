import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

test('verified plugin graph emits native Next TUI progress and the same supervisor observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-graph-p5-'));
  const token = 'aps_' + 'p'.repeat(40);
  const nexus = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/v1/members/owner'
      || request.headers.get('authorization') !== `Bearer ${token}`)
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    return Response.json({ memberId: 'member-p5' });
  } });
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    writeFileSync(join(root, 'next-member-session.test.json'), JSON.stringify({
      nexusUrl: `http://127.0.0.1:${nexus.port}`, sessionToken: token }));
    const chunks: string[] = [];
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'P5-DONE',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'P5-FIXTURE', name: 'ToolSearch',
          args: { query: 'route:이 기사 스크랩해줘' }, after: { name: 'scrap_add', args: { kind: 'text', text: 'P5 sample' } } }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: 'boot', until: screen => screen.includes('Ctrl+Q 종료') },
      steps: [{ label: 'finished', text: 'P5-FIXTURE 이 기사 스크랩해줘', until: screen => screen.includes('턴 완료') }],
      onOutput: chunk => chunks.push(chunk),
    });
    expect(run.exitCode).toBe(0);
    const sessionFile = readdirSync(join(root, 'sessions')).find(name => name.endsWith('.jsonl'));
    if (!sessionFile) throw new Error('missing session transcript');
    const tool = readFileSync(join(root, 'sessions', sessionFile), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { toolName?: string; toolResult?: string })
      .find(row => row.toolName === 'scrap_add');
    if (!tool?.toolResult?.startsWith('{')) throw new Error(`unexpected graph result: ${tool?.toolResult?.slice(0, 300)}`);
    expect(tool.toolResult).toContain('"graphId":"absorb-ingest"');
    expect(chunks.join('')).toContain('그래프 absorb-ingest');
    expect(chunks.join('')).not.toContain(token);
  } finally { nexus.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 120_000);
