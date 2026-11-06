import { describe, expect, it } from 'bun:test';
import { debug } from '../debug/log.js';
import {
  createAsideRemoteRouter,
  setAsideRemoteRouter,
  setAsideRemoteTargetsConfigured,
  type AsideRemoteTarget,
} from '../aside/remote-targets.js';
import { createAsideSelectionRuntime } from './aside-selection-runtime.js';

const selectionReply = {
  content: [{ type: 'text', text: 'ELANOUS_CURRENT_SELECTION:{"text":"selected passage tokenization ghp_0123456789abcdefghijklmnopqrstuvwxyzAB","url":"https://example.test/page/abcdefghijklmnopQRSTUVWX01234567"}' }],
};

describe('Aside selection runtime remote target routing', () => {
  it('applies context defaults and lets explicit target_id win through the production runtime', async () => {
    const owner = {};
    const targets: AsideRemoteTarget[] = [
      { id: 'mac-a', host: 'minim5', command: ['aside', 'mcp'], capabilities: ['repl', 'selection'] },
      { id: 'mac-b', host: 'node-b', command: ['aside', 'mcp'], capabilities: ['repl', 'selection'] },
    ];
    const calls: string[] = [];
    const observations: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      observations.push({ category, event, data });
    }) as typeof debug.log;
    const router = createAsideRemoteRouter({
      targets,
      preferences: { defaultTargetId: 'mac-b', contextDefaults: { research: 'mac-a' } },
      health: () => new Map(targets.map(target => [target.id, { online: true, authenticated: true }])),
      clients: new Map(targets.map(target => [target.id, { callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${target.id}:${name}:${String(args.code).includes('ELANOUS_CURRENT_SELECTION')}`);
        return selectionReply;
      } }])),
    });
    setAsideRemoteTargetsConfigured(true, owner);
    setAsideRemoteRouter(router, undefined, owner);
    try {
      const runtime = createAsideSelectionRuntime(async () => { throw new Error('local dispatch must not run'); });
      const contextual = await runtime.run({ context: 'research' }, { surface: 'tui' });
      const explicit = await runtime.run({ target_id: 'mac-b', context: 'research' }, { surface: 'tui' });
      expect(contextual.selection.text).toBe('selected passage tokenization ghp_***');
      expect(contextual.selection.url).toBe('https://example.test/page/abcdefghijklmnopQRSTUVWX01234567');
      expect(explicit.selection.text).toBe('selected passage tokenization ghp_***');
      expect(calls).toEqual(['mac-a:exec:true', 'mac-b:exec:true']);
      const observationText = JSON.stringify(observations);
      expect(observationText).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
      expect(observationText).not.toContain('https://example.test');
      expect(observationText).not.toContain('selected passage');
      expect(observationText).toContain('selectedTextLength');
      expect(observationText).toContain('sourceUrlSha256');
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
      setAsideRemoteTargetsConfigured(false, owner);
      setAsideRemoteRouter(undefined, router, owner);
    }
  });

  it('fails closed during bootstrap before consulting the local dispatcher', async () => {
    const owner = {};
    let localCalls = 0;
    setAsideRemoteTargetsConfigured(true, owner);
    try {
      const runtime = createAsideSelectionRuntime(async () => { localCalls += 1; return selectionReply; });
      await expect(runtime.run({}, { surface: 'tui' })).rejects.toThrow('Aside targets are initializing');
      expect(localCalls).toBe(0);
    } finally {
      setAsideRemoteTargetsConfigured(false, owner);
    }
  });
});
