import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { resolve } from 'node:path';
import { classifyMakeRequest, registerMakeCommand } from './make-cli.js';

const workflowRequest = '노션에 매일 요약 올려 줘';
const pluginRequest = 'hwp 읽는 기능';

async function run(request: string, decision: 'plugin' | 'workflow' | null) {
  const calls: Array<{ kind: string; request: string }> = [];
  const lines: string[] = [];
  const oldLog = console.log;
  const oldExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    const program = new Command();
    registerMakeCommand(program, {
      decide: async () => decision,
      pluginMake: async text => { calls.push({ kind: 'plugin', request: text }); },
      workflowMake: async text => { calls.push({ kind: 'workflow', request: text }); return 0; },
    });
    await program.parseAsync(['node', 'elanous', 'make', request]);
    return { calls, lines, exitCode: process.exitCode };
  } finally {
    console.log = oldLog;
    process.exitCode = oldExitCode;
  }
}

test('isolated public CLI exposes elanous make', async () => {
  const repo = resolve(import.meta.dir, '../..');
  const child = Bun.spawn([process.execPath, 'bin/elanous.mjs', '--test', 'make', '--help'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  expect(output).toContain('Usage: elanous make [options] <request>');
});

test('fake classify judge routes daily Notion summary to existing workflow builder', async () => {
  let model = '';
  const kind = await classifyMakeRequest(workflowRequest, async ({ prompt, provider, model: picked }) => {
    expect(prompt).toContain(workflowRequest);
    expect(provider).toBeTruthy();
    model = picked;
    return { text: '{"kind":"workflow"}' };
  });
  expect(model).toBeTruthy();
  expect(await run(workflowRequest, kind)).toEqual({ calls: [{ kind: 'workflow', request: workflowRequest }], lines: [], exitCode: 0 });
});

test('fake classify judge routes hwp reading capability to existing plugin make', async () => {
  const kind = await classifyMakeRequest(pluginRequest, async () => ({ text: '{"kind":"plugin"}' }));
  expect(await run(pluginRequest, kind)).toEqual({ calls: [{ kind: 'plugin', request: pluginRequest }], lines: [], exitCode: 0 });
});

test('judge failure and ambiguous decisions ask one question without making anything', async () => {
  for (const call of [async () => { throw new Error('offline'); }, async () => ({ text: '{"kind":"unclear"}' }), async () => ({ text: '{"kind":"unsupported"}' })]) {
    const kind = await classifyMakeRequest('무언가 해 줘', call);
    expect(await run('무언가 해 줘', kind)).toEqual({
      calls: [], lines: ['플러그인(커넥터·스킬)을 만들까요, 워크플로(잡)를 만들까요?'], exitCode: 1,
    });
  }
});
