import { debug } from '../../../debug/log.js';
import { savingsCallsFromLedger } from '../../../cli/llm-savings-cli.js';
import { streamLLM, type LLMProvider } from '../../../llm.js';
import { summarizeRouterSavings } from '../../../model-tier/router-savings.js';
import { LogStore } from '../../../mss/logging/log-store.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

type Event = { category: string; event: string; data: Record<string, unknown> };
type ProviderMode = 'measured' | 'unmeasured' | 'silent';

function provider(name: string, mode: ProviderMode): LLMProvider {
  return {
    name,
    defaultModel: 'gpt-4o',
    available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat() {
      if (mode === 'silent') {
        await new Promise<void>(() => {});
        return;
      }
      if (mode === 'measured') yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } };
      yield { type: 'text', delta: name };
    },
  };
}

export const simWorldDevices: readonly SimWorldDeviceDef<{ provider: typeof provider }>[] = [{
  id: 'ROUTER-COST-FAKE-PROVIDERS',
  title: 'isolated measured, missing-usage and silent LLM providers',
  create: () => ({ provider }),
}];

const failure = (message: string) => ({ ok: false as const, reason: 'router cost ledger mismatch', diff: message });

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'ROUTER-COST-LEDGER',
  title: 'actual LLM calls account for measured, unmeasured, concurrent, restart and silent providers',
  devices: ['ROUTER-COST-FAKE-PROVIDERS'],
  async run(ctx) {
    const { provider: fake } = ctx.device<{ provider: typeof provider }>('ROUTER-COST-FAKE-PROVIDERS');
    const rows: Event[] = [];
    const original = debug.log;
    debug.log = function (category, event, data, options) {
      if (category === 'llm.usage' || category === 'llm.router.error')
        rows.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
      return original.call(this, category, event, data, options);
    };
    try {
      // Two calls arrive together. A new provider object then simulates a
      // process restart: no in-memory ledger counter may be needed to see it.
      const first = await Promise.all([
        streamLLM([{ role: 'user', content: 'a' }], () => {}, { provider: fake('router-measured-a', 'measured') }),
        streamLLM([{ role: 'user', content: 'b' }], () => {}, { provider: fake('router-no-usage-b', 'unmeasured') }),
      ]);
      ctx.recorder.event('router-cost:concurrent', { replies: first });
      const restarted = await streamLLM([{ role: 'user', content: 'after restart' }], () => {},
        { provider: fake('router-restart-c', 'measured') });
      ctx.recorder.event('router-cost:restart', { reply: restarted });
      let timeout = false;
      try {
        await streamLLM([{ role: 'user', content: 'silent provider' }], () => {}, {
          provider: fake('router-silent-d', 'silent'), streamFirstTokenTimeoutMs: 25, streamTotalTimeoutMs: 25,
        });
      } catch { timeout = true; }
      ctx.recorder.event('router-cost:provider-unresponsive', { timeout });
      const usage = rows.filter(row => row.category === 'llm.usage').map(row => row.data);
      const names = usage.map(row => row.billingProvider).sort();
      const expected = ['router-measured-a', 'router-no-usage-b', 'router-restart-c', 'router-silent-d'];
      if (JSON.stringify(names) !== JSON.stringify(expected)) return failure(`usage rows ${JSON.stringify(names)} != ${JSON.stringify(expected)}`);
      for (const name of ['router-measured-a', 'router-restart-c']) {
        const row = usage.find(item => item.billingProvider === name)!;
        if (row.inputTokens !== 12 || row.outputTokens !== 3 || row.measured === false)
          return failure(`${name} measured usage missing`);
      }
      for (const [name, reason] of [['router-no-usage-b', 'provider-usage-absent'], ['router-silent-d', 'provider-call-failed']]) {
        const row = usage.find(item => item.billingProvider === name)!;
        if (row.measured !== false || row.missingReason !== reason || row.inputTokens !== undefined
          || (row.cost as { kind?: string } | undefined)?.kind !== 'unknown')
          return failure(`${name} unmeasured usage incorrectly priced or classified`);
      }
      if (!timeout || !rows.some(row => row.category === 'llm.router.error' && row.data.provider === 'router-silent-d'))
        return failure('silent provider did not surface a timed failure');
      const now = Date.parse('2026-11-22T00:00:00.000Z');
      const parsed = savingsCallsFromLedger(rows.map((row, id) => ({
        id: id + 1, ts: new Date(now).toISOString(), category: row.category,
        event: row.event, data: JSON.stringify(row.data),
      })), { now });
      const receipt = summarizeRouterSavings({ calls: parsed, premiumModel: 'gpt-4o', priceOf: () => 0.00006 });
      if (receipt.totalCalls !== 4 || receipt.unpricedCalls !== 2 || receipt.savingsPct !== 0)
        return failure(`savings consumer miscounted measured versus unknown calls: ${JSON.stringify(receipt)}`);
      ctx.recorder.event('router-cost:savings-consumed', {
        totalCalls: receipt.totalCalls, unpricedCalls: receipt.unpricedCalls, savingsPct: receipt.savingsPct,
      });
      for (const row of rows) {
        // Wall duration is diagnostic but cannot enter a replayable receipt.
        const { durationMs: _durationMs, ...stableData } = row.data;
        ctx.recorder.event('router-cost:observed', { category: row.category, event: row.event, data: stableData });
      }
      return { ok: true };
    } finally {
      debug.log = original;
    }
  },
}, {
  id: 'ROUTER-COST-LOCK-RECOVERY',
  title: 'usage rows survive a killed SQLite lock holder and a fresh writer connection',
  devices: ['ROUTER-COST-FAKE-PROVIDERS'],
  async run(ctx) {
    const { provider: fake } = ctx.device<{ provider: typeof provider }>('ROUTER-COST-FAKE-PROVIDERS');
    const dbPath = join(ctx.universeRoot, 'cost-ledger.db');
    const priorFile = debug.isFileEnabled();
    const writeCall = async (name: string) => {
      const store = new LogStore(dbPath);
      debug.setFileEnabled(true);
      const unregister = debug.registerSink({ name: `router-cost-${name}`, emit(rec) {
        if (rec.category === 'llm.usage' && rec.event === 'llm-usage') store.insertBatch([{ rec, surface: 'tui' }]);
      } });
      try {
        await streamLLM([{ role: 'user', content: name }], () => {}, { provider: fake(name, 'measured') });
      } finally {
        unregister();
        debug.setFileEnabled(priorFile);
        store.close();
      }
    };
    await writeCall('router-before-lock');
    const ready = join(ctx.universeRoot, 'lock-ready');
    const script = `const { Database } = require('bun:sqlite'); const { writeFileSync } = require('node:fs');
      const db = new Database(process.env.COST_SIM_DB); db.exec('BEGIN IMMEDIATE');
      writeFileSync(process.env.COST_SIM_READY, 'locked'); await new Promise(() => {});`;
    const holder = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, COST_SIM_DB: dbPath, COST_SIM_READY: ready }, stdout: 'ignore', stderr: 'pipe',
    });
    try {
      const deadline = Date.now() + 3_000;
      while (!existsSync(ready) && Date.now() < deadline && holder.exitCode === null) await Bun.sleep(10);
      if (!existsSync(ready)) return failure('SQLite holder did not acquire the write lock');
      ctx.recorder.event('router-cost:lock-holder', { acquired: true });
    } finally {
      holder.kill('SIGKILL');
      await holder.exited;
    }
    await writeCall('router-after-lock');
    const reader = LogStore.openReadOnly(dbPath);
    let raw;
    try { raw = reader.query({ exactCategories: ['llm.usage'], events: ['llm-usage'], limit: 10 }); }
    finally { reader.close(); }
    const calls = savingsCallsFromLedger(raw, { now: Date.now() });
    const names = calls.map(row => row.provider).sort();
    ctx.recorder.event('router-cost:reopened', { count: calls.length, providers: names });
    return JSON.stringify(names) === JSON.stringify(['router-after-lock', 'router-before-lock'])
      && calls.every(row => row.inputTokens === 12 && row.outputTokens === 3)
      ? { ok: true } : failure(`reopened ledger lost a call: ${JSON.stringify(names)}`);
  },
}];
