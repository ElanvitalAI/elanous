// TUI-NL-ROUTE — the daemon ACP entry point (createDaemonRunTurn) never opts into TUI routing:
// a lookup sentence gets the same tools as a coding sentence and no «라우팅:» line.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as coreTurn from '../core-turn/index.js';
import { debug } from '../debug/log.js';
import { createSession } from '../session/index.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { DaemonSessionHistory, createDaemonRunTurn } from './daemon-runtime.js';
import type { AcpTurnContext } from '../acp/server.js';

afterEach(() => { spyOn(coreTurn, 'runCoreTurn').mockRestore(); });

test('daemon ACP turns keep every tool and show no route line for a lookup sentence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-tui-route-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  const routeLog = spyOn(debug, 'log');
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const session = createSession();
    const toolSets: string[][] = [];
    spyOn(coreTurn, 'runCoreTurn').mockImplementation(async (ctx) => {
      toolSets.push(ctx.tools.map((tool) => tool.name));
      return { stopReason: 'end_turn', finalText: 'ok' };
    });
    const run = createDaemonRunTurn(new DaemonSessionHistory(), { tools: 'readonly', toolCwd: root, systemPrompt: 'Base' });
    const pushes: string[] = [];
    for (const text of ['나한테 온 결정 카드 있어?', 'src/acp/server.ts 의 승인 정책 고쳐줘']) {
      const noop = async () => {};
      await run({
        sessionId: session.id, cwd: root, codexArgs: [], userText: text, promptBlocks: [{ type: 'text', text }],
        isAborted: () => false, push: async (delta: string) => { pushes.push(delta); }, pushWithMeta: noop,
        pushToolCall: noop, pushToolResult: noop, pushSessionUpdate: noop, pushUsage: noop,
        requestApproval: async () => 'allow-once',
      } as AcpTurnContext);
    }
    expect(toolSets).toHaveLength(2);
    expect(toolSets[0]!.length).toBeGreaterThan(0);
    expect(toolSets[0]).toEqual(toolSets[1]!);
    expect(pushes.some((delta) => delta.startsWith('라우팅:'))).toBe(false);
    expect(routeLog.mock.calls.some(([category]) => category === 'chat.route')).toBe(false);
  } finally {
    routeLog.mockRestore();
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    rmSync(root, { recursive: true, force: true });
  }
});
