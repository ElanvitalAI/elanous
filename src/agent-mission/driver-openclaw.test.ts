import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveBackend, runAgentMission, setAgentMissionTimingForTest } from './driver.js';
import { runPtyControlLoop } from '../autopilot/pty-control-loop.js';
import type { PtyHandle } from '../pty-shell/registry.js';

let restoreMissionTiming: (() => void) | undefined;
beforeAll(() => { restoreMissionTiming = setAgentMissionTimingForTest({ readyQuietMs: 20, pollMs: 5, keystrokeGapMs: 0 }); });
afterAll(() => { restoreMissionTiming?.(); });

function startChildPty(opts: { id?: string; kind?: string; nickname?: string; cmd: string; args?: string[]; workdir?: string; env?: Record<string, string> }): PtyHandle {
  const child = spawn(opts.cmd, opts.args ?? [], { cwd: opts.workdir, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let deltaOffset = 0;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  return {
    id: opts.id!, kind: opts.kind!, nickname: opts.nickname ?? 'fake-cli', accessMode: 'auto', pid: child.pid,
    get exitCode() { return child.exitCode; },
    isAlive: () => child.exitCode === null && !child.killed,
    canWrite: () => child.stdin.writable,
    drainDelta: () => { const delta = output.slice(deltaOffset); deltaOffset = output.length; return delta; },
    renderScreen: async () => output,
    renderScreenPng: async () => null,
    write: (text: string) => { child.stdin.write(text.replace(/\r/g, '\n')); },
    kill: () => { child.kill('SIGTERM'); },
  } as unknown as PtyHandle;
}

function setupFixture(repo: string, cmd: string): { fakeCli: string; fakeBin: string; crawlScript: string; inputLog: string; invocationLog: string } {
  const fakeCli = join(repo, 'fake-agent-cli.mjs');
  const fakeBin = join(repo, 'bin');
  const crawlScript = join(repo, 'fake-omni-crawl.mjs');
  const inputLog = join(repo, 'cli-inputs.txt');
  const invocationLog = join(repo, 'cli-args.json');
  const artifact = `${cmd} completed the identical smoke goal`;
  const grounded = 'Official docs: use the documented official account login before selecting the provider';
  mkdirSync(fakeBin);
  writeFileSync(crawlScript, `console.log('---BEGIN_OMNI_CRAWL_JSON---' + JSON.stringify({results:[{engine:'fixture',summary:${JSON.stringify(grounded)}}]}) + '---END_OMNI_CRAWL_JSON---');\n`);
  writeFileSync(fakeCli, `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const workspace = ${JSON.stringify(cmd)} === 'openclaw' ? process.env.OPENCLAW_WORKSPACE_DIR ?? process.cwd() : process.cwd();
writeFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ argv: process.argv.slice(2), workspace }));
console.log('Unknown ${cmd} setup: choose an account and provider');
for await (const input of createInterface({ input: process.stdin })) {
  appendFileSync(${JSON.stringify(inputLog)}, input + '\\n');
  if (input.includes('.mission-context.md')) console.log(readFileSync('.mission-context.md', 'utf8'));
  else if (input.includes('Use documented official account login')) console.log('Provider connection complete');
  else if (input.includes('Confirm provider connection')) {
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'docs', 'fixture-result.md'), ${JSON.stringify(`${artifact}\n`)});
    console.log('MISSION-COMPLETE');
  } else console.log('Waiting for the controller');
}
`);
  const launcher = join(fakeBin, cmd);
  writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCli)} "$@"\n`);
  chmodSync(launcher, 0o755);
  return { fakeCli, fakeBin, crawlScript, inputLog, invocationLog };
}

function initFixtureRepo(repo: string): void {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'AGENT-ENV test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'agent-env-test@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'clean starting tree\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'test fixture'], { cwd: repo });
}

test('AGENT-ENV-OSS: all four backends ground an unfamiliar CLI screen and finish the same mission through the real control loop', async () => {
  const groundedText = 'Official docs: use the documented official account login before selecting the provider';
  const keyNames = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCLAW_API_KEY', 'HERMES_API_KEY'];
  const originalKeys = Object.fromEntries(keyNames.map((key) => [key, process.env[key]]));
  try {
    for (const key of keyNames) process.env[key] = `test-only-${key}`;
    for (const cmd of ['openclaw', 'hermes', 'codex', 'claude'] as const) {
      const backend = resolveBackend(cmd);
      expect(backend.name).toBe(cmd);
      if (cmd === 'openclaw' || cmd === 'hermes') {
        expect(backend.scrubEnv).toContain(`${cmd.toUpperCase()}_API_KEY`);
        expect(backend.scrubEnv).not.toContain('OPENAI_API_KEY');
        expect(backend.scrubEnv).not.toContain('ANTHROPIC_API_KEY');
      }
      const repo = mkdtempSync(join(tmpdir(), `agent-oss-${cmd}-`));
      initFixtureRepo(repo);
      const { fakeBin, crawlScript, inputLog, invocationLog } = setupFixture(repo, cmd);
      const prompts: string[] = [];
      const originalPath = process.env.PATH;
      const originalOpenclawWorkspace = process.env.OPENCLAW_WORKSPACE_DIR;
      try {
        process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ''}`;
        if (cmd === 'openclaw') process.env.OPENCLAW_WORKSPACE_DIR = join(tmpdir(), 'configured-openclaw-default-workspace');
        const result = await runAgentMission({
          mission: 'Connect through official provider setup, then print the backend smoke marker.', repo, branch: `fixture-${cmd}`,
          agent: backend, omniCrawlPath: crawlScript,
          evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture-result/ }, memory: false, commit: false,
          screensDir: join(repo, 'screens'), resources: 'off',
        }, {
          createWorktree: (() => ({ path: repo, branch: `fixture-${cmd}`, base: 'HEAD' })) as never,
          recordWorktreeProvenance: () => {},
          checkClaudeSubscription: (() => ({ ok: true, authMethod: 'subscription', apiProvider: null, reason: null })) as never,
          startPty: startChildPty as never,
          runControlLoop: (brain, controlDeps, opts) => runPtyControlLoop(brain, {
            ...controlDeps,
            settle: async () => new Promise((resolve) => setTimeout(resolve, 10)),
            sleep: async () => new Promise((resolve) => setTimeout(resolve, 5)),
          }, opts),
          controlStream: async (messages) => {
            const screen = String(messages.at(-1)?.content ?? '');
            prompts.push(screen);
            if (screen.includes('MISSION-COMPLETE')) return '{"action":"verify","reason":"The child CLI emitted the required artifact"}';
            if (screen.includes('Provider connection complete')) return '{"action":"send","text":"Confirm provider connection","reason":"Continue using the observed CLI state"}';
            if (screen.includes(groundedText)) return '{"action":"send","text":"Use documented official account login","reason":"Apply the grounded setup instruction"}';
            return '{"action":"search","query":"official provider setup instructions"}';
          },
        });
        if (!result.ok) throw new Error(`real mission failed for ${cmd}: ${JSON.stringify({ result, prompts: prompts.length, inputs: readFileSync(inputLog, 'utf8') })}`);
        expect(result.ok).toBe(true);
        expect(result.evidenceSatisfied).toBe(true);
        expect(result.evidencePath).toBe(join(repo, 'docs', 'fixture-result.md'));
        expect(readFileSync(result.evidencePath!, 'utf8')).toContain(`${cmd} completed the identical smoke goal`);
        const inputs = readFileSync(inputLog, 'utf8');
        expect(inputs).toContain('.mission-context.md');
        expect(inputs).toContain('Use documented official account login');
        expect(inputs).toContain('Confirm provider connection');
        expect(prompts.some((prompt) => prompt.includes(groundedText))).toBe(true);
        const invocation = JSON.parse(readFileSync(invocationLog, 'utf8')) as { argv: string[]; workspace: string };
        expect(invocation.argv.slice(0, backend.args.length)).toEqual(backend.args);
        expect(realpathSync(invocation.workspace)).toBe(realpathSync(repo));
        expect(inputs).toContain('Connect through official provider setup, then print the backend smoke marker.');
      } finally {
        if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
        if (originalOpenclawWorkspace === undefined) delete process.env.OPENCLAW_WORKSPACE_DIR;
        else process.env.OPENCLAW_WORKSPACE_DIR = originalOpenclawWorkspace;
        rmSync(repo, { recursive: true, force: true });
      }
    }
  } finally {
    for (const key of keyNames) {
      const value = originalKeys[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 30_000);

test('AGENT-ENV-OSS: an API key cannot bypass an authentication screen in the real mission control loop', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-oss-key-only-'));
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-not-an-authentication-proof';
  initFixtureRepo(repo);
  const fakeCli = join(repo, 'fake-hermes.mjs');
  const inputLog = join(repo, 'auth-inputs.txt');
  writeFileSync(fakeCli, `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
console.log('Authentication required: sign in with the official Hermes account');
for await (const input of createInterface({ input: process.stdin })) appendFileSync(${JSON.stringify(inputLog)}, input + '\\n');
`);
  try {
    const backend = resolveBackend('hermes');
    const result = await runAgentMission({
      mission: 'Connect the official Hermes account and complete a smoke task.', repo, branch: 'key-only-fixture',
      agent: { ...backend, cmd: process.execPath, args: [fakeCli] },
      evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture/ }, memory: false, commit: false,
      screensDir: join(repo, 'screens'), resources: 'off',
    }, {
      createWorktree: (() => ({ path: repo, branch: 'key-only-fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      startPty: startChildPty as never,
      runControlLoop: (brain, controlDeps, opts) => runPtyControlLoop(brain, {
        ...controlDeps,
        settle: async () => new Promise((resolve) => setTimeout(resolve, 10)),
        sleep: async () => new Promise((resolve) => setTimeout(resolve, 5)),
      }, { ...opts, maxSteps: 2, stuckLimit: 1 }),
      controlStream: async (messages) => {
        expect(String(messages.at(-1)?.content ?? '')).toContain('Authentication required');
        return '{"action":"verify","reason":"The screen claims setup is complete"}';
      },
    });
    expect(result.ok).toBe(false);
    expect(result.evidenceSatisfied).toBe(false);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    rmSync(repo, { recursive: true, force: true });
  }
}, 20_000);
