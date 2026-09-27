// Behavior tests for the `elanous agent` logs.db sink initializer.
//
// `elanous agent` is a standalone process that does not inherit the nexus StoreSink,
// so it must register its own log sink or core-turn debug.log events (e.g.
// capability.resolve) never reach logs.db. These tests exercise the initializer's
// contract directly (via an injected register fn) rather than grepping source, so
// they actually verify: the 'agent' surface, single-flight on concurrent entries,
// and no-failure-caching (retry) semantics.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentCliLogSinkInitializer } from '../src/chat/agent-cli-entry.ts';

describe('agent CLI log sink initializer', () => {
  test('registers the standalone sink with the "agent" surface', async () => {
    const surfaces: string[] = [];
    const init = createAgentCliLogSinkInitializer(async (s) => {
      surfaces.push(s);
    });

    await init();

    expect(surfaces).toEqual(['agent']);
  });

  test('single-flights concurrent entries into one registration', async () => {
    let registrations = 0;
    const init = createAgentCliLogSinkInitializer(async () => {
      registrations += 1;
      await Promise.resolve();
    });

    await Promise.all([init(), init(), init()]);

    expect(registrations).toBe(1);

    // A subsequent call after resolution also shares the cached success.
    await init();
    expect(registrations).toBe(1);
  });

  test('does not cache a failed registration — a later entry retries', async () => {
    let attempts = 0;
    const init = createAgentCliLogSinkInitializer(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
    });

    // First attempt rejects (caller is responsible for fail-open).
    await expect(init()).rejects.toThrow('boom');

    // Failure was not cached, so the next entry retries and succeeds.
    await init();
    expect(attempts).toBe(2);
  });
});

// Wiring regression guard — complements the behavior tests above. The behavior
// tests prove the initializer's contract; this guard proves the `elanous agent`
// command action actually invokes it before dispatching the turn (the whole
// point — an unwired initializer is dead code, per the first review). The full
// end-to-end path (agent turn -> capability.resolve -> logs.db) is verified
// manually and documented in the PR; an automated e2e would require spawning a
// process + an LLM call, which does not belong in the unit suite.
describe('elanous agent action wires the log sink initializer', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SOURCE = readFileSync(resolve(HERE, '..', 'src', 'cli', 'agent-cli.ts'), 'utf8');

  test('the `agent <text...>` action calls initializeAgentCliLogSink before runChatTurnCli', () => {
    const agentAction = SOURCE.match(
      /\.command\('agent <text\.\.\.>'\)[\s\S]*?\.action\(async \(parts[\s\S]*?await runChatTurnCli\(/,
    )?.[0];
    expect(agentAction).toBeDefined();
    expect(agentAction).toContain('initializeAgentCliLogSink()');
    // The call must precede the turn dispatch (registration before core-turn work).
    const initIdx = agentAction!.indexOf('initializeAgentCliLogSink()');
    const turnIdx = agentAction!.indexOf('await runChatTurnCli(');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeLessThan(turnIdx);
  });
});
