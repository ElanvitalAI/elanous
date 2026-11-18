import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence, type SeatPtyStep } from '../ux-sim/mock-seat-pty-sequence.js';

async function runGraphTurn(graphView?: string, after: (screen: () => string) => SeatPtyStep[] = () => []) {
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
    let finalScreen = '';
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'P5-DONE',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'P5-FIXTURE', name: 'ToolSearch',
          args: { query: 'route:이 기사 스크랩해줘' }, after: { name: 'scrap_add', args: { kind: 'text', text: 'P5 sample' } } }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root, ...(graphView ? { ELANOUS_NEXT_TUI_GRAPH_VIEW: graphView } : {}) },
      // The footer is English since #37922; either language reads as booted.
      ready: { label: 'boot', until: screen => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [{ label: 'finished', text: 'P5-FIXTURE 이 기사 스크랩해줘', until: screen => {
        finalScreen = screen;
        return /턴 완료|Worked for/.test(screen) && screen.includes('P5-DONE');
      } }, ...after(() => finalScreen)],
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
    const output = chunks.join('');
    expect(output).not.toContain(token);
    return { output, finalScreen };
  } finally { nexus.stop(true); rmSync(root, { recursive: true, force: true }); }
}

test('verified plugin graph draws the inline block in the conversation and folds it when the turn ends (개정 4 default)', async () => {
  const { output, finalScreen } = await runGraphTurn();
  // Live: the block head «⎇ kind · run» updated in place; the old footer hint is not repeated under it.
  expect(output).toContain('⎇ absorb-ingest');
  expect(output).not.toMatch(/(그래프|Graph) absorb-ingest/);
  // Settled: one folded line stays in the transcript, the live block is gone.
  const folded = finalScreen.split('\n').filter((row) => /^\s*✓ absorb-ingest · \S+ · (\d+)\/\1 stages · /.test(row));
  expect(folded).toHaveLength(1);
  expect(finalScreen).not.toContain('⎇ absorb-ingest');
}, 120_000);

test('ELANOUS_NEXT_TUI_GRAPH_VIEW=off keeps the footer hint only (the pre-graph-view behavior)', async () => {
  const { output, finalScreen } = await runGraphTurn('off');
  expect(output).toMatch(/(그래프|Graph) absorb-ingest/);
  expect(output).not.toContain('⎇ absorb-ingest');
  expect(finalScreen).not.toContain('✓ absorb-ingest ·');
}, 120_000);

test('개정 5 detail: Ctrl+click on the folded line opens the graph detail; ↓ moves the node log; Esc closes; Ctrl+G and /graph are the keyboard way', async () => {
  const seen: Record<string, string> = {};
  const look = (label: string, check: (screen: string) => boolean) => (screen: string) => { seen[label] = screen; return check(screen); };
  // SGR mouse report with the Ctrl bit (16): press then release on the folded line's row.
  const ctrlClick = (screen: () => string) => () => {
    const row = screen().split('\n').findIndex((line) => /✓ absorb-ingest · /.test(line)) + 1;
    return `\x1b[<16;3;${row}M\x1b[<16;3;${row}m`;
  };
  await runGraphTurn(undefined, (screen) => [
    { label: 'ctrl-click', text: ctrlClick(screen), enter: false, until: look('open', (current) => current.includes('── log · all nodes ──')) },
    { label: 'down', keys: '\x1b[B', until: look('node', (current) => /── log · \S+ ──/.test(current) && !current.includes('── log · all nodes ──')) },
    { label: 'esc', keys: '\x1b', until: look('closed', (current) => !current.includes('── log ·')) },
    { label: 'ctrl-g', keys: '\x07', until: look('ctrl-g', (current) => current.includes('── log · all nodes ──')) },
    { label: 'ctrl-g-close', keys: '\x07', until: (current) => !current.includes('── log ·') },
    { label: 'slash', text: '/graph absorb-ingest:save', until: look('slash', (current) => current.includes('── log · save ──')) },
  ]);
  // The detail is a panel to the right of the chat: head, edge, every node, then the log.
  const open = seen.open!.split('\n');
  expect(open.some((line) => /│✓ absorb-ingest · \S+ · /.test(line))).toBe(true);
  expect(open.some((line) => line.includes('│✓ docparse ════ ✓ save ════ ✓ done'))).toBe(true);
  expect(seen.node).toMatch(/│▸ ✓ docparse/);
  expect(seen.node).toContain('── log · docparse ──');
  // The inline block in the conversation stays the simple folded line.
  expect(seen.node!.split('\n').some((line) => /^\s*✓ absorb-ingest · .*│/.test(line))).toBe(true);
  expect(seen.slash).toMatch(/│▸ ✓ save/);
}, 120_000);
