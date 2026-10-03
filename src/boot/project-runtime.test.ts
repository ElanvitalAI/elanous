import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as coreTurn from '../core-turn/index.js';
import { ProjectStore } from '../project/project-store.js';
import { createSession } from '../session/index.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { DaemonSessionHistory, createDaemonRunTurn } from './daemon-runtime.js';
import type { AcpTurnContext } from '../acp/server.js';

function turnFor(sessionId: string, cwd: string, userText: string): AcpTurnContext {
  const noop = async () => {};
  return {
    sessionId, cwd, codexArgs: [], userText, promptBlocks: [{ type: 'text', text: userText }],
    isAborted: () => false, push: noop, pushWithMeta: noop, pushToolCall: noop,
    pushToolResult: noop, pushSessionUpdate: noop, pushUsage: noop,
    requestApproval: async () => 'allow-once',
  };
}

afterEach(() => { spyOn(coreTurn, 'runCoreTurn').mockRestore(); });

test('ACP tool dispatch resolves relative files from the assigned project and preserves the default without it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-tool-project-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const folder = join(root, 'project');
    mkdirSync(folder);
    writeFileSync(join(folder, 'context.txt'), 'project content');
    writeFileSync(join(root, 'context.txt'), 'default content');
    const project = new ProjectStore(join(root, 'config')).create({ name: 'demo', primaryFolder: folder });
    const assigned = createSession({ projectId: project.id });
    const plain = createSession();
    const observations: string[] = [];
    spyOn(coreTurn, 'runCoreTurn').mockImplementation(async ctx => {
      observations.push(JSON.stringify(await ctx.dispatchTool?.('Read', { file_path: 'context.txt' })));
      return { stopReason: 'end_turn', finalText: 'ok' };
    });
    const run = createDaemonRunTurn(new DaemonSessionHistory(), { tools: 'readonly', toolCwd: root, systemPrompt: 'Base instructions' });
    for (const sessionId of [assigned.id, plain.id]) {
      await run(turnFor(sessionId, root, 'read'));
    }
    expect(observations[0]).toContain('project content');
    expect(observations[1]).toContain('default content');
    expect(observations[1]).not.toContain('project content');
  } finally {
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an ACP session cwd given explicitly wins over the assigned project folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-tool-explicit-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const folder = join(root, 'project');
    const explicit = join(root, 'explicit');
    mkdirSync(folder); mkdirSync(explicit);
    writeFileSync(join(folder, 'context.txt'), 'project content');
    writeFileSync(join(explicit, 'context.txt'), 'explicit content');
    const project = new ProjectStore(join(root, 'config')).create({ name: 'demo', primaryFolder: folder });
    const assigned = createSession({ projectId: project.id });
    const observations: string[] = [];
    spyOn(coreTurn, 'runCoreTurn').mockImplementation(async ctx => {
      observations.push(JSON.stringify(await ctx.dispatchTool?.('Read', { file_path: 'context.txt' })));
      return { stopReason: 'end_turn', finalText: 'ok' };
    });
    const run = createDaemonRunTurn(new DaemonSessionHistory(), { tools: 'readonly', toolCwd: root, systemPrompt: 'Base', acpSessionCwd: true });
    await run(turnFor(assigned.id, explicit, 'read'));
    expect(observations[0]).toContain('explicit content');
    expect(observations[0]).not.toContain('project content');
  } finally {
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test('ACP turns use assigned project instructions while unassigned turns retain system context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-project-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const folder = join(root, 'project');
    mkdirSync(folder);
    writeFileSync(join(folder, 'AGENTS.md'), 'Project conventions.');
    const project = new ProjectStore(join(root, 'config')).create({ name: 'demo', primaryFolder: folder });
    const assigned = createSession({ projectId: project.id });
    const plain = createSession();
    const observations: string[] = [];
    spyOn(coreTurn, 'runCoreTurn').mockImplementation(async ctx => {
      observations.push(JSON.stringify(ctx.messages));
      return { stopReason: 'end_turn', finalText: 'ok' };
    });
    const run = createDaemonRunTurn(new DaemonSessionHistory(), { tools: 'none', toolCwd: root, systemPrompt: 'Base instructions' });
    for (const sessionId of [assigned.id, plain.id]) {
      await run(turnFor(sessionId, root, 'hello'));
    }
    expect(observations).toHaveLength(2);
    expect(observations[0]).toContain('Base instructions');
    expect(observations[0]).toContain('Project conventions.');
    expect(observations[1]).toContain('Base instructions');
    expect(observations[1]).not.toContain('Project conventions.');
  } finally {
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    rmSync(root, { recursive: true, force: true });
  }
});
