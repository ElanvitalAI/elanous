import { describe, expect, test } from 'bun:test';
import { debug } from '../../src/debug/log';

// JUD #91844 must 1 — vendored skill copies (skills/*/src/llm-network-fetch.ts)
// emit `llm.call` ledger rows through `globalThis.__elanousDebugLog`. The
// production DebugLog module must install that hook so in-repository skill
// runs keep producing ledger rows through the production tracer.
describe('SKILL-LITE1 __elanousDebugLog bridge', () => {
  test('production log.ts installs the hook in-repository skill copies emit through', () => {
    const hooks = globalThis as unknown as Record<string, unknown>;
    expect(typeof hooks['__elanousDebugLog']).toBe('function');
  });

  test('bridge forwards llm.call rows into the production tracer (ledger row lands)', () => {
    const rows: Array<{ category: string; event: string; data: unknown }> = [];
    const stop = debug.registerSink({
      name: 'skill-ledger-bridge-test',
      emit: (record) => {
        if (record.category === 'llm.call') {
          rows.push({ category: record.category, event: record.event, data: record.data });
        }
      },
    });
    try {
      const emit = (globalThis as unknown as {
        __elanousDebugLog?: (c: string, e: string, d?: unknown) => void;
      }).__elanousDebugLog;
      expect(emit).toBeDefined();
      emit?.('llm.call', 'attempt', { model: 'bridge-probe', url: 'https://example.invalid/v1' });
      const row = rows.find((r) => r.event === 'attempt');
      expect(row).toBeDefined();
      expect((row?.data as { model?: string })?.model).toBe('bridge-probe');
    } finally {
      stop();
    }
  });
});
