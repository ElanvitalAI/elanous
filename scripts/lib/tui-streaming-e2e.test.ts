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

describe('TUI OpenAI-compatible streaming E2E', () => {
  test('renders split local SSE text in the live TUI PTY transcript', async () => {
    let requestPath = '';
    let requestBody: Record<string, unknown> | undefined;
    const responseText = 'TUI stream works';
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        requestBody = await request.json() as Record<string, unknown>;
        const frames = [
          'data: {"choices":[{"delta":{"content":"TUI "}}]}\n',
          '\ndata: {"choices":[{"delta":{"content":"stream"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" works"}}]}\n\n',
          'data: [DONE]\n\n',
        ];
        let index = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            const frame = frames[index++];
            if (frame === undefined) controller.close();
            else controller.enqueue(encoder.encode(frame));
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    tempDir = mkdtempSync(join(tmpdir(), 'tui-streaming-e2e-'));
    const transcriptPath = join(tempDir, 'tui-transcript.txt');
    const promptPath = join(tempDir, 'prompt.txt');
    writeFileSync(promptPath, 'exercise the TUI stream');
    writeFileSync(join(tempDir, 'config.json'), JSON.stringify({
      llm: { provider: 'local', model: 'test-model', baseUrl: `http://127.0.0.1:${server.port}/v1` },
      onboarding: { completed: true, version: 1 },
    }));
    const proc = Bun.spawn({
      cmd: ['bun', 'scripts/drive-tui.ts', '--prompt-file', promptPath, '--test', '--test-dir', tempDir, '--wait', '12', '--transcript', transcriptPath],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        LOCAL_LLM_URL: `http://127.0.0.1:${server.port}/v1`,
        LOCAL_LLM_MODEL: 'test-model',
        ELANOUS_LLM_PROVIDER: 'local',
        ELANOUS_LLM_MODEL: 'test-model',
        ELANOUS_LLM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const transcript = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : '';
    if (exitCode !== 0 || requestPath !== '/v1/chat/completions') {
      throw new Error(`TUI did not reach the local SSE server (exit=${exitCode}, path=${requestPath || 'none'})\nstdout:\n${stdout}\nstderr:\n${stderr}\ntranscript:\n${transcript}`);
    }
    expect(requestBody).toEqual(expect.objectContaining({ model: 'test-model', stream: true }));
    expect(transcript).toContain(responseText);
  }, 30_000);

  test('presses ESC and typeahead while the local SSE stream is still running', async () => {
    let handle: ReturnType<typeof startPty> | undefined;
    let streamTimer: ReturnType<typeof setInterval> | undefined;
    let streamRequested = false;
    let streamOpen = false;
    let chunksSent = 0;
    let lastScreen = '';
    const baseUrl = () => `http://127.0.0.1:${server?.port}/v1`;
    const fail = (message: string) => new Error(`${message}\nfull screen:\n${lastScreen}`);
    const lastPromptLine = (screen: string, scene: string) => {
      const line = [...screen.split('\n')].reverse().find((candidate) => candidate.trimStart().startsWith('❯'));
      if (!line) throw fail(`${scene} did not render an input line`);
      return line.trimStart();
    };
    const streamingTurnLine = (screen: string, scene: string) => {
      const line = screen.split('\n').find((candidate) => candidate.includes('esc 중단') && !candidate.trimStart().startsWith('❯'));
      if (!line) throw fail(`${scene} did not render ESC interruption hint in the streaming turn line`);
      return line;
    };
    const pollScreen = async (predicate: (screen: string) => boolean, timeoutMs: number, description: string) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        lastScreen = await handle!.renderScreen();
        if (predicate(lastScreen)) return lastScreen;
        await sleep(100);
      }
      throw fail(`Timed out waiting for ${description}`);
    };
    const cleanupStream = () => {
      if (streamTimer) clearInterval(streamTimer);
      streamTimer = undefined;
      streamOpen = false;
    };

    try {
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const { pathname } = new URL(request.url);
          if (pathname === '/v1/models') {
            return Response.json({ object: 'list', data: [{ id: 'test-model', object: 'model' }] });
          }
          if (pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
          const body = await request.json() as { stream?: unknown };
          streamRequested = body.stream === true;
          if (!streamRequested) return new Response('stream:true required', { status: 400 });
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              streamOpen = true;
              const close = () => {
                if (!streamOpen) return;
                cleanupStream();
                try { controller.close(); } catch { /* already closed */ }
              };
              request.signal.addEventListener('abort', close, { once: true });
              streamTimer = setInterval(() => {
                if (chunksSent >= 400) {
                  try { controller.enqueue(encoder.encode('data: [DONE]\n\n')); } finally { close(); }
                  return;
                }
                controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"청크${chunksSent++} "}}]}\n\n`));
              }, 150);
            },
            cancel() {
              cleanupStream();
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      tempDir = mkdtempSync(join(tmpdir(), 'tui-streaming-control-e2e-'));
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify({
        llm: { provider: 'local', model: 'test-model', baseUrl: baseUrl() },
        onboarding: { completed: true, version: 1 },
        skillRouter: { llmFallback: false },
        mcp: { enabled: false },
      }));
      handle = startPty({
        cmd: 'bun',
        args: ['bin/elanous.mjs', '--config-dir', tempDir, '--test-state-dir', tempDir],
        cols: 160,
        rows: 40,
        workdir: repoRoot,
        env: {
          ...process.env,
          ELANOUS_DRIVE_TUI: '1',
          ELANOUS_STATE_DIR: tempDir,
          LOCAL_LLM_URL: baseUrl(),
          LOCAL_LLM_MODEL: 'test-model',
          ELANOUS_LLM_PROVIDER: 'local',
          ELANOUS_LLM_MODEL: 'test-model',
          ELANOUS_LLM_BASE_URL: baseUrl(),
        },
      });

      await pollScreen((screen) => screen.includes('❯'), 40_000, 'TUI boot prompt');
      handle.write('hello world\r');
      const s1 = await pollScreen((screen) => screen.includes('Streaming…') && chunksSent > 0 && screen.includes('청크'), 15_000, 'S1 streamed response');
      if (!streamRequested) throw fail('S1 did not send stream:true to the local server');
      if (!streamOpen) throw fail('S1 stream ended before the typeahead scene');
      const s1Prompt = lastPromptLine(s1, 'S1');
      if (s1Prompt.includes('hello world')) throw fail(`S1 input line retained submitted text: ${s1Prompt}`);
      if (!streamingTurnLine(s1, 'S1').includes('esc 중단')) throw fail('S1 did not render the ESC interruption hint in the streaming turn line');
      if (s1Prompt.includes('esc 중단')) throw fail(`S1 input line repeats the ESC hint already shown in the turn line: ${s1Prompt}`);
      if (!s1Prompt.includes('입력하면')) throw fail(`S1 input line lost the typeahead hint: ${s1Prompt}`);

      handle.write('abc');
      const s2 = await pollScreen((screen) => lastPromptLine(screen, 'S2').startsWith('❯ abc'), 5_000, 'S2 typeahead input');
      if (!streamOpen || chunksSent === 0) throw fail('S2 was not observed while the SSE stream was running');
      if (!lastPromptLine(s2, 'S2').startsWith('❯ abc')) throw fail('S2 did not preserve typeahead in the last input line');

      if (!streamOpen) throw fail('S3 ESC was sent after the SSE stream ended');
      handle.write('\x1b');
      const s3 = await pollScreen((screen) => screen.includes('중단됨') && lastPromptLine(screen, 'S3').startsWith('❯ abc'), 5_000, 'S3 interruption with preserved input');
      if (!s3.includes('중단됨') || !lastPromptLine(s3, 'S3').startsWith('❯ abc')) throw fail('S3 did not show interruption and the preserved last input line');
    } finally {
      try { handle?.kill(); } finally {
        cleanupStream();
        try { server?.stop(true); } finally {
          server = undefined;
          if (tempDir) rmSync(tempDir, { recursive: true, force: true });
          tempDir = undefined;
        }
      }
    }
  }, 90_000);

  test('shows running background agents in the essential status line and clears them after completion', async () => {
    let handle: ReturnType<typeof startPty> | undefined;
    let lastScreen = '';
    let childDone = 0;
    let parentSpawned = false;
    const timers = new Set<ReturnType<typeof setInterval>>();
    const baseUrl = () => `http://127.0.0.1:${server?.port}/v1`;
    const fail = (message: string) => new Error(`${message}\nfull screen:\n${lastScreen}`);
    const statusLine = (screen: string) => [...screen.split('\n')].reverse().find((line) => line.trim().length > 0) ?? '';
    const pollScreen = async (predicate: (screen: string) => boolean, timeoutMs: number, description: string) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        lastScreen = await handle!.renderScreen();
        if (predicate(lastScreen)) return lastScreen;
        await sleep(100);
      }
      throw fail(`Timed out waiting for ${description}`);
    };
    const sse = (frames: unknown[]) => new Response(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );

    try {
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const { pathname } = new URL(request.url);
          if (pathname === '/v1/models') {
            return Response.json({ object: 'list', data: [{ id: 'test-model', object: 'model' }] });
          }
          if (pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
          const body = await request.json() as {
            stream?: unknown;
            tools?: Array<{ function?: { name?: string } }>;
            messages?: Array<{ role?: string }>;
          };
          if (body.stream !== true) return new Response('stream:true required', { status: 400 });
          const hasAgentTool = (body.tools ?? []).some((tool) => tool.function?.name === 'Agent');
          const lastRole = body.messages?.at(-1)?.role;
          if (hasAgentTool && lastRole !== 'tool') {
            parentSpawned = true;
            return sse([
              {
                choices: [{
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [1, 2].map((i) => ({
                      index: i - 1,
                      id: `call_agent_${i}`,
                      type: 'function',
                      function: {
                        name: 'Agent',
                        arguments: JSON.stringify({ description: `worker ${i}`, name: `worker-${i}`, prompt: 'CHILD', run_in_background: true }),
                      },
                    })),
                  },
                  finish_reason: null,
                }],
              },
              { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            ]);
          }
          if (hasAgentTool) {
            return sse([{ choices: [{ index: 0, delta: { content: 'spawned' }, finish_reason: null }] }]);
          }
          let sent = 0;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              const timer = setInterval(() => {
                if (sent >= 40) {
                  clearInterval(timer);
                  timers.delete(timer);
                  childDone += 1;
                  try { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); } catch { /* closed */ }
                  return;
                }
                try {
                  controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"child${sent++} "}}]}\n\n`));
                } catch {
                  clearInterval(timer);
                  timers.delete(timer);
                }
              }, 100);
              timers.add(timer);
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      tempDir = mkdtempSync(join(tmpdir(), 'tui-background-agents-e2e-'));
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify({
        llm: { provider: 'local', model: 'test-model', baseUrl: baseUrl() },
        onboarding: { completed: true, version: 1 },
        skillRouter: { llmFallback: false },
        mcp: { enabled: false },
      }));
      handle = startPty({
        cmd: 'bun',
        args: ['bin/elanous.mjs', '--config-dir', tempDir, '--test-state-dir', tempDir],
        cols: 160,
        rows: 40,
        workdir: repoRoot,
        env: {
          ...process.env,
          ELANOUS_DRIVE_TUI: '1',
          ELANOUS_STATE_DIR: tempDir,
          LOCAL_LLM_URL: baseUrl(),
          LOCAL_LLM_MODEL: 'test-model',
          ELANOUS_LLM_PROVIDER: 'local',
          ELANOUS_LLM_MODEL: 'test-model',
          ELANOUS_LLM_BASE_URL: baseUrl(),
        },
      });

      await pollScreen((screen) => screen.includes('❯'), 40_000, 'TUI boot prompt');
      handle.write('AGENTS 둘\r');
      await pollScreen((screen) => statusLine(screen).includes('◇ 2 agents'), 15_000, 'A1 status line running agents');
      if (!parentSpawned) throw fail('A1 parent never issued the Agent tool calls');

      await pollScreen(() => childDone >= 2, 20_000, 'A2 both child streams finished');
      const a2 = await pollScreen((screen) => !statusLine(screen).includes('agents'), 10_000, 'A2 status line agents segment cleared');
      if (/● worker-/.test(a2)) throw fail('A3 a stale running worker line remained after completion');
    } finally {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      try { handle?.kill(); } finally {
        try { server?.stop(true); } finally {
          server = undefined;
          if (tempDir) rmSync(tempDir, { recursive: true, force: true });
          tempDir = undefined;
        }
      }
    }
  }, 90_000);
});
