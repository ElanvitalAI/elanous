import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { getModelWatchProposalPath, runModelIntelligenceWatch } from './model-watch-mission.js';

function temporaryHome(): { home: string; dispose: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'model-watch-'));
  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

function writeCatalog(home: string, models: unknown[]): void {
  const dir = join(home, '.elanous');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ version: 1, updated: 0, models }));
}

describe('runModelIntelligenceWatch', () => {
  test('appends per-source diagnosis while preserving proposal ledger keys', async () => {
    const temp = temporaryHome();
    try {
      writeCatalog(temp.home, [{ id: 'new-model', provider: 'openai', classification: { source: 'manual' } }]);
      await runModelIntelligenceWatch({
        fetchPages: async () => [
          { source: 'completed-source', text: 'completed' },
          { source: 'deadline-source', text: 'deadline' },
          { source: 'error-source', text: 'error' },
        ],
        runLlm: async (messages) => {
          const text = messages.at(-1)?.content;
          if (text === 'deadline') return new Promise<string>(() => {});
          if (text === 'error') throw new Error('classifier disconnected');
          return JSON.stringify({ models: [{ id: 'new-model', provider: 'openai' }] });
        },
        log: () => {},
      }, { home: temp.home, now: Date.UTC(2026, 8, 9), classifyTimeoutMs: 10 });

      const path = getModelWatchProposalPath(temp.home);
      expect(existsSync(path)).toBe(true);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      expect(record).toMatchObject({
        ts: Date.UTC(2026, 8, 9),
        added: [],
        updated: ['new-model'],
        candidates: [{ id: 'new-model' }],
        perSource: {
          'completed-source': { candidateCount: 1, status: 'completed' },
          'deadline-source': { candidateCount: 0, status: 'deadline' },
          'error-source': { candidateCount: 0, status: 'error', error: 'classifier disconnected' },
        },
      });
    } finally {
      temp.dispose();
    }
  });

  test('names only abnormal zero-candidate sources in the human-readable diagnostic line', async () => {
    const temp = temporaryHome();
    const events: Array<{ event: string; data: unknown }> = [];
    try {
      await runModelIntelligenceWatch({
        fetchPages: async () => [
          { source: 'completed-empty', text: 'completed empty' },
          { source: 'deadline-source', text: 'deadline' },
          { source: 'error-source', text: 'error' },
        ],
        runLlm: async (messages) => {
          const text = messages.at(-1)?.content;
          if (text === 'deadline') return new Promise<string>(() => {});
          if (text === 'error') throw new Error('classifier disconnected');
          return JSON.stringify({ models: [] });
        },
        log: (_category, event, data) => { events.push({ event, data }); },
      }, { home: temp.home, classifyTimeoutMs: 10 });

      const diagnostic = events.find(({ event }) => event === 'incomplete-classification');
      expect(diagnostic?.data).toMatchObject({
        sources: ['deadline-source', 'error-source'],
        line: 'Classification incomplete for zero-candidate sources: deadline-source, error-source',
      });
    } finally {
      temp.dispose();
    }
  });

  test('omits the human-readable diagnostic line when zero candidates completed normally', async () => {
    const temp = temporaryHome();
    const events: Array<{ event: string }> = [];
    try {
      await runModelIntelligenceWatch({
        fetchPages: async () => [{ source: 'empty-source', text: 'no release' }],
        runLlm: async () => JSON.stringify({ models: [] }),
        log: (_category, event) => { events.push({ event }); },
      }, { home: temp.home });

      expect(events.some(({ event }) => event === 'incomplete-classification')).toBe(false);
    } finally {
      temp.dispose();
    }
  });

  test('reports a catalog price change as a log line while the ledger record keeps its keys', async () => {
    const temp = temporaryHome();
    const events: Array<{ event: string; data: unknown }> = [];
    try {
      writeCatalog(temp.home, [{
        id: 'priced-model', provider: 'openai', family: 'gpt', contextWindow: 1000,
        inputPerMtok: 5, outputPerMtok: 15, local: false, tags: [], bestFor: [],
        classification: { source: 'manual' },
      }]);
      await runModelIntelligenceWatch({
        fetchPages: async () => [{ source: 'pricing', text: 'pricing page' }],
        runLlm: async () => JSON.stringify({
          models: [{ id: 'priced-model', provider: 'openai', inputPerMtok: 2.5, outputPerMtok: 15 }],
        }),
        log: (_category, event, data) => { events.push({ event, data }); },
      }, { home: temp.home });

      const change = events.find(({ event }) => event === 'price-changes');
      expect(change?.data).toMatchObject({
        changes: [{ id: 'priced-model', field: 'inputPerMtok', before: 5, after: 2.5 }],
        line: 'Price changes vs catalog: priced-model input $5→$2.5 /Mtok',
      });
      const record = JSON.parse(readFileSync(getModelWatchProposalPath(temp.home), 'utf8'));
      expect(Object.keys(record)).toEqual(['ts', 'added', 'updated', 'candidates', 'perSource']);
    } finally {
      temp.dispose();
    }
  });

  test('emits no price-changes event for an unpriced catalog entry or an unchanged price', async () => {
    const temp = temporaryHome();
    const events: string[] = [];
    try {
      writeCatalog(temp.home, [
        { id: 'unpriced', provider: 'openai', family: 'gpt', contextWindow: 1, inputPerMtok: 0, outputPerMtok: 0, local: false, tags: [], bestFor: [], classification: { source: 'manual' } },
        { id: 'same', provider: 'openai', family: 'gpt', contextWindow: 1, inputPerMtok: 3, outputPerMtok: 9, local: false, tags: [], bestFor: [], classification: { source: 'manual' } },
      ]);
      await runModelIntelligenceWatch({
        fetchPages: async () => [{ source: 'pricing', text: 'pricing page' }],
        runLlm: async () => JSON.stringify({
          models: [
            { id: 'unpriced', provider: 'openai', inputPerMtok: 1, outputPerMtok: 2 },
            { id: 'same', provider: 'openai', inputPerMtok: 3, outputPerMtok: 9 },
          ],
        }),
        log: (_category, event) => { events.push(event); },
      }, { home: temp.home });

      expect(events).toContain('pass');
      expect(events).not.toContain('price-changes');
    } finally {
      temp.dispose();
    }
  });

  test('isolates synchronous and asynchronous logger failures while returning the intake result', async () => {
    const temp = temporaryHome();
    let calls = 0;
    try {
      const result = await runModelIntelligenceWatch({
        fetchPages: async () => [{ source: 'deadline-source', text: 'deadline' }],
        runLlm: async () => new Promise<string>(() => {}),
        log: () => {
          calls += 1;
          if (calls === 1) throw new Error('synchronous log failure');
          return Promise.reject(new Error('asynchronous log failure'));
        },
      }, { home: temp.home, classifyTimeoutMs: 10 });

      expect(result.perSource['deadline-source']).toMatchObject({
        candidateCount: 0,
        status: 'deadline',
      });
      expect(calls).toBe(2);
    } finally {
      temp.dispose();
    }
  });
});
