import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPty } from '../../src/pty-shell/registry.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const encoder = new TextEncoder();
const repoRoot = join(import.meta.dir, '..', '..');
let server: ReturnType<typeof Bun.serve> | undefined;
let tempDir: string | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('TUI RunShell task-unit grouping E2E', () => {
  test('groups consecutive RunShell calls without moving streaming input or status', async () => {
    let handle: ReturnType<typeof startPty> | undefined;
    let lastScreen = '';
    let toolRequested = false;
    let followupStreaming = false;
    let followupDone = false;
    let streamTimer: ReturnType<typeof setInterval> | undefined;
    const baseUrl = () => `http://127.0.0.1:${server?.port}/v1`;
    const pollScreen = async (predicate: (screen: string) => boolean, description: string) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        lastScreen = await handle!.renderScreen();
        if (predicate(lastScreen)) return lastScreen;
        await sleep(100);
      }
      throw new Error(`Timed out waiting for ${description}\nfull screen:\n${lastScreen}`);
    };

    try {
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const { pathname } = new URL(request.url);
          if (pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'test-model', object: 'model' }] });
          if (pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
          const body = await request.json() as { messages?: Array<{ role?: string }> };
          if (!body.messages?.some(message => message.role === 'tool')) {
            toolRequested = true;
            const frames = [
              { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_heredoc', type: 'function', function: { name: 'RunShell', arguments: JSON.stringify({ command: ['sh', '-c', "cat <<'EOF'\nfirst\nEOF"], approval: 'none' }) } }, { index: 1, id: 'call_second', type: 'function', function: { name: 'RunShell', arguments: JSON.stringify({ command: ['sh', '-c', 'printf second'], approval: 'none' }) } }] }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            ];
            return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', {
              headers: { 'content-type': 'text/event-stream' },
            });
          }
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              followupStreaming = true;
              let count = 0;
              streamTimer = setInterval(() => {
                if (count++ < 100) controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"stream ${count} "}}]}\n\n`));
                else { clearInterval(streamTimer); streamTimer = undefined; followupDone = true; controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
              }, 100);
            },
            cancel() { if (streamTimer) clearInterval(streamTimer); streamTimer = undefined; },
          }), { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      tempDir = mkdtempSync(join(tmpdir(), 'tui-heredoc-header-e2e-'));
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify({
        llm: { provider: 'local', model: 'test-model', baseUrl: baseUrl() },
        onboarding: { completed: true, version: 1 },
        skillRouter: { llmFallback: false },
        mcp: { enabled: false },
        shell: { allowDashboardRunShell: true },
      }));
      handle = startPty({
        cmd: 'bun', args: ['bin/elanous.mjs', '--config-dir', tempDir, '--test-state-dir', tempDir],
        cols: 160, rows: 40, workdir: repoRoot,
        env: {
          ...process.env, ELANOUS_DRIVE_TUI: '1', ELANOUS_STATE_DIR: tempDir,
          LOCAL_LLM_URL: baseUrl(), LOCAL_LLM_MODEL: 'test-model',
          ELANOUS_LLM_PROVIDER: 'local', ELANOUS_LLM_MODEL: 'test-model', ELANOUS_LLM_BASE_URL: baseUrl(),
        },
      });
      const bootScreen = await pollScreen(screen => screen.includes('❯'), 'TUI boot prompt');
      handle.write('run heredoc\r');
      const screen = await pollScreen(screen => followupStreaming && screen.includes('stream 1') && screen.includes('RunShell'), 'heredoc header in streaming PTY');
      const rowOf = (snapshot: string, predicate: (line: string) => boolean) => snapshot.split('\n').findIndex(predicate);
      // A submitted prompt remains in the log. Locate the *last* prompt
      // row so the visible input composer is compared across snapshots.
      const inputRow = (snapshot: string) => {
        const rows = snapshot.split('\n');
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.trimStart().startsWith('❯')) return i;
        }
        return -1;
      };
      const statusRow = (snapshot: string) => rowOf(snapshot, line => line.includes('│ local:test-model │'));
      expect(toolRequested).toBe(true);
      expect(screen).toContain('… (2 RunShell)');
      expect(screen.split('\n').filter(line => line.includes('RunShell('))).toHaveLength(0);
      expect(inputRow(bootScreen)).toBeGreaterThan(0);
      expect(statusRow(bootScreen)).toBeGreaterThan(0);
      expect(rowOf(screen, line => line.trimStart().startsWith('❯'))).toBeGreaterThanOrEqual(0);
      expect(rowOf(screen, line => line.includes('│ local:test-model │'))).toBeGreaterThanOrEqual(0);
      expect(inputRow(screen)).toBe(inputRow(bootScreen));
      expect(statusRow(screen)).toBe(statusRow(bootScreen));
      expect(rowOf(screen, line => line.includes('esc 중단'))).toBe(inputRow(screen) - 2);
      handle.write('abc');
      const typedScreen = await pollScreen(screen => screen.split('\n').some(line => line.trimStart().startsWith('❯ abc')), 'typeahead input after heredoc header');
      expect(rowOf(typedScreen, line => line.includes('│ local:test-model │'))).toBeGreaterThanOrEqual(0);
      expect(inputRow(typedScreen)).toBe(inputRow(bootScreen));
      expect(statusRow(typedScreen)).toBe(statusRow(bootScreen));
      const completedScreen = await pollScreen(snapshot => followupDone && !snapshot.includes('Streaming…') && snapshot.includes('❯ abc'), 'completed response after heredoc');
      expect(inputRow(completedScreen)).toBe(inputRow(bootScreen));
      expect(statusRow(completedScreen)).toBe(statusRow(bootScreen));
    } finally {
      handle?.kill();
      if (streamTimer) clearInterval(streamTimer);
    }
  }, 60_000);
});
