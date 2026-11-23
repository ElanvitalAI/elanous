// ELS-SEAT-MODEL-DECLARE: a seat keeps its declared provider/model across open, `els up` and migration,
// and the footer names the model the next request uses. Expectations are literals, not product constants.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceConfig } from './workspace-config.js';
import { openSeat, seatLaunchCommand } from './seat-open.js';
import type { ElsRequest } from './server.js';
import { planTuiRestartArgv, runTuiSelfRestartOnStaleBuild } from '../index.js';
import { clearSessionProvider, parseSessionProvider, setSessionProvider } from '../tui-client/session-provider.js';
import { nextTuiFooterModel, readNextTuiStatusModel } from '../tui/chat/status-model.js';

const FEDERATION = `version: 1
root: /hq
roles:
  hand: { runtime: eln, provider: openrouter, model: z-ai/glm-5 }
seats:
  OP: { runtime: eln, provider: openai-codex, model: gpt-6.1-terra }
  TC: { role: hand }
  UX: { runtime: eln }
spaces:
  OP: { coordinator: OP }
`;

describe('federation declares seat provider and model', () => {
  test('seat and role provider/model are parsed', () => {
    const parsed = parseWorkspaceConfig(FEDERATION, '/hq/.elanous/federation.yaml', '/home');
    expect(parsed.errors).toEqual([]);
    expect(parsed.config!.seats.OP).toMatchObject({ provider: 'openai-codex', model: 'gpt-6.1-terra' });
    expect(parsed.config!.seats.TC).toMatchObject({ provider: 'openrouter', model: 'z-ai/glm-5' });
    expect(parsed.config!.seats.UX!.provider).toBeUndefined();
  });

  test('eln launch argv carries the declaration; other runtimes stay bare', () => {
    expect(seatLaunchCommand('eln', { provider: 'openai-codex', model: 'gpt-6.1-terra' }))
      .toEqual({ command: ['eln', '--provider', 'openai-codex', '--model', 'gpt-6.1-terra'] });
    expect(seatLaunchCommand('eln', {})).toEqual({ command: ['eln'] });
    expect(seatLaunchCommand('codex', {})).toEqual({ command: ['codex'] });
    expect(seatLaunchCommand('codex', { provider: 'openai-codex', model: 'gpt-6.1-terra' })).toEqual({ error: 'provider/model is declared but runtime codex cannot take it' });
    expect(seatLaunchCommand('eln', { model: 'gpt-6.1-terra' })).toEqual({ error: 'model is declared without provider; eln needs both' });
  });

  test('els seat OP spawns eln --provider openai-codex --model gpt-6.1-terra', async () => {
    const root = mkdtempSync(join(tmpdir(), 'els-seat-model-'));
    try {
      const state = join(root, 'seat-state'); mkdirSync(state);
      mkdirSync(join(root, 'seats', 'OP'), { recursive: true });
      mkdirSync(join(root, '.elanous'));
      writeFileSync(join(root, '.elanous', 'federation.yaml'), FEDERATION.replace('root: /hq', `root: ${root}`));
      const requests: ElsRequest[] = [];
      const result = await openSeat('op', state, async r => {
        requests.push(r);
        return r.op === 'ls' ? { exitCode: 0, message: '{"panes":[],"workspaces":[]}' } : { exitCode: 0, message: '{"pane":"p1"}' };
      });
      expect(result.exitCode).toBe(0);
      expect(requests[1]).toEqual({ op: 'new', ws: 'OP', cwd: join(root, 'seats', 'OP'), title: 'OP',
        command: ['eln', '--provider', 'openai-codex', '--model', 'gpt-6.1-terra'], uniqueSeat: 'OP' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('migration keeps the session provider', () => {
  test('a /provider override replaces the launch flags in the relaunch argv', () => {
    expect(planTuiRestartArgv({ scriptPath: '/opt/elanous.mjs', args: ['--provider', 'glm', '--model=glm-5.3', '--tui', 'next'], sessionId: 's1',
      provider: { provider: 'openai-codex', model: 'gpt-6.1-terra' } }))
      .toEqual(['/opt/elanous.mjs', '--provider', 'openai-codex', '--model', 'gpt-6.1-terra', '--tui', 'next', '--resume', 's1']);
    expect(planTuiRestartArgv({ scriptPath: '/opt/elanous.mjs', args: ['--provider', 'openai-codex', '--model', 'gpt-6.1-terra'], sessionId: 's1' }))
      .toEqual(['/opt/elanous.mjs', '--provider', 'openai-codex', '--model', 'gpt-6.1-terra', '--resume', 's1']);
  });

  test('seat migrate relaunch carries the live session selection', async () => {
    const session = 'seat-model-declare-s1';
    setSessionProvider(session, parseSessionProvider('openai-codex', 'gpt-6.1-terra'));
    const spawned: (readonly string[])[] = [];
    try {
      const result = await runTuiSelfRestartOnStaleBuild({
        scriptPath: '/opt/elanous.mjs', args: ['--provider', 'auto'], migrateSessionId: session,
        stale: () => ({ stale: false, reason: 'current' }), owned: () => ({ sessionId: session, at: Date.now() }),
        liveActiveSessionId: () => session, sessionExists: () => true, globalLatestSessionId: () => null,
        retireCurrentTui: () => {}, spawnChild: async (_command, argv) => { spawned.push(argv); return 0; }, log: () => {},
      });
      expect(result.outcome).toBe('relaunch');
      expect(spawned).toEqual([['/opt/elanous.mjs', '--provider', 'openai-codex', '--model', 'gpt-6.1-terra', '--resume', session]]);
    } finally { clearSessionProvider(session); }
  });
});

describe('footer shows the active model', () => {
  test('a session selection wins over the previous route badge', () => {
    const session = 'seat-model-declare-footer';
    setSessionProvider(session, parseSessionProvider('openai-codex', 'gpt-6.1-terra'));
    try {
      // The same resolver the footer render feeds in (entry.ts statusInput.model), not a hand-built string.
      expect(nextTuiFooterModel(session, readNextTuiStatusModel(session), 'glm-5.3')).toBe('openai-codex/gpt-6.1-terra');
    } finally { clearSessionProvider(session); }
    expect(nextTuiFooterModel(session, 'auto/auto', 'glm-5.3')).toBe('glm-5.3');
    expect(nextTuiFooterModel(undefined, 'auto/auto', undefined)).toBe('auto/auto');
  });
});
