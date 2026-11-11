import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ptyAvailable, startPty, unregisterPty } from '../pty-shell/registry.js';

// Source: each classic dashboard boot and modal response uses the existing PTY gate's bounded wait.
const CLASSIC_BASH_APPROVAL_TIMEOUT_MS = 90_000;
// Source: each of the two user turns makes one tool request and one receipt request.
const EXPECTED_BASH_APPROVAL_CHAT_REQUESTS = 4;
// Source: the test has two bounded PTY turns plus startup and cleanup overhead.
const CLASSIC_BASH_APPROVAL_TEST_TIMEOUT_MS = 210_000;

test.skipIf(!ptyAvailable())('classic dashboard PTY shows Bash approval and runs rm -rf only after explicit y', async () => {
  const root = mkdtempSync(join(tmpdir(), 'classic-bash-approval-'));
  const state = join(root, 'state');
  const deniedTarget = join(root, 'denied-target');
  const approvedTarget = join(root, 'approved-target');
  mkdirSync(state, { recursive: true });
  mkdirSync(deniedTarget); mkdirSync(approvedTarget);
  writeFileSync(join(deniedTarget, 'keep.txt'), 'default deny');
  writeFileSync(join(approvedTarget, 'remove.txt'), 'explicit y');

  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/v1/models') return Response.json({ data: [{ id: 'classic-bash-approval' }] });
    if (path !== '/v1/chat/completions') return new Response('not found', { status: 404 });
    requests++;
    if (requests === 1 || requests === 3) {
      const target = requests === 1 ? deniedTarget : approvedTarget;
      const toolCall = { index: 0, id: `bash-approval-${requests}`, type: 'function', function: {
        name: 'Bash', arguments: JSON.stringify({ command: `rm -rf '${target}'` }),
      } };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: `Bash approval cycle ${Math.floor(requests / 2)} complete.` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  } });

  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true },
    llm: { provider: 'local', model: 'classic-bash-approval', baseUrl: `http://127.0.0.1:${server.port}/v1` },
    skillRouter: { llmFallback: false }, mcp: { enabled: false },
  }));
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_ENV: 'development',
    HOME: join(root, 'home'), ELANOUS_STATE_DIR: state, ELANOUS_STATE_DIR_SOURCE: 'explicit',
    ELANOUS_DATA_DIR: join(root, 'data'), ELANOUS_SKIP_LOGIN_ENV: '1', TERM: 'xterm-256color', COLUMNS: '120', LINES: '30' };
  mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.ELANOUS_DATA_DIR, { recursive: true });
  for (const key of ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR']) delete env[key];
  const credentialEnv = /(_API_KEY|_TOKEN|_AUTH|_SECRET)$|^(ANTHROPIC|OPENAI|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|CODEX|CLAUDE|AWS|BEDROCK|ELANOUS_CODEX)/i;
  for (const key of Object.keys(env)) if (credentialEnv.test(key)) delete env[key];
  const repoRoot = resolve(import.meta.dir, '../..');
  const pty = startPty({ cmd: 'bun', args: ['bin/elanous.mjs', `--test=${root}`, '--config-dir', root, '--legacy'],
    workdir: repoRoot, cols: 120, rows: 30, env,
    unsetEnv: ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR'] });
  const waitFor = async (predicate: (screen: string) => boolean, label: string) => {
    const deadline = Date.now() + CLASSIC_BASH_APPROVAL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const screen = await pty.renderScreen();
      if (predicate(screen)) return screen;
      await Bun.sleep(100);
    }
    throw new Error(`classic Bash approval timeout (${label}); requests=${requests}; screen=${(await pty.renderScreen()).slice(-1400)}`);
  };
  try {
    await waitFor(screen => screen.split('\n').some(line => line.trim() === '❯'), 'initial prompt');
    pty.write('Run the Bash tool to remove the denied fixture.\r');
    await waitFor(screen => screen.includes('Approve risky Bash command?') && screen.includes('Deny (n)'), 'approval modal');
    const denyScreen = await pty.renderScreen();
    expect(denyScreen).toContain(`rm -rf '${deniedTarget}'`);
    pty.write('\r');
    await waitFor(screen => requests >= 2 && screen.includes('Bash approval cycle 1 complete.'), 'default denial result');
    expect(existsSync(join(deniedTarget, 'keep.txt'))).toBe(true);

    await waitFor(screen => screen.split('\n').some(line => line.trim() === '❯'), 'prompt after denial');
    pty.write('Run the Bash tool to remove the approved fixture.\r');
    await waitFor(screen => screen.includes('Approve risky Bash command?') && screen.includes('Run command (y)'), 'second approval modal');
    pty.write('y');
    await waitFor(screen => requests >= 4 && screen.includes('Bash approval cycle 2 complete.'), 'approved result');
    expect(existsSync(approvedTarget)).toBe(false);
    expect(requests).toBeGreaterThanOrEqual(EXPECTED_BASH_APPROVAL_CHAT_REQUESTS);
  } finally {
    pty.kill(); unregisterPty(pty.id); server.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, { timeout: CLASSIC_BASH_APPROVAL_TEST_TIMEOUT_MS });
