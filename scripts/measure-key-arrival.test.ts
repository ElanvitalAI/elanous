import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKeyArrivalMeasurer,
  createRealKeyArrivalAdapters,
  DEFAULT_KEY_ARRIVAL_LOG_LIMIT,
  DEFAULT_KEY_ARRIVAL_LOG_SINCE,
  DEFAULT_ELANOUS_COMMAND,
  DISPLAY_KEY_ARRIVAL_EVENTS,
  DISPLAY_KEY_CATEGORY,
  KEY_ARRIVAL_ADAPTER_NAMES,
  measureKeyArrival,
  missingAdapterNames,
  planKeyArrival,
  runMeasureKeyArrival,
  type KeyArrivalAdapters,
  type MeasureKeyArrivalCliDeps,
  type MeasureKeyArrivalRequest,
  type ElanousCommandResult,
  type ElanousCommandRunner,
} from './measure-key-arrival.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

type OptionalKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never;
}[keyof T];
type AdapterOptionals = OptionalKeys<KeyArrivalAdapters>;
type NoOptionalAdapters = [AdapterOptionals] extends [never] ? true : false;

const SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'measure-key-arrival.ts');

function adapters(overrides: Partial<KeyArrivalAdapters> = {}): KeyArrivalAdapters {
  return {
    captureCursor: () => 'cursor-1',
    confirmScreen: () => true,
    resetScreen: () => undefined,
    sendKey: () => undefined,
    wait: () => undefined,
    ...overrides,
  };
}

function request(
  overrides: Partial<MeasureKeyArrivalRequest> & Pick<MeasureKeyArrivalRequest, 'keys' | 'screenRef'>,
): MeasureKeyArrivalRequest {
  return {
    adapters: adapters(),
    queryDisplayKey: () => '[]',
    ...overrides,
  };
}

function displayKeyRecord(event: string, key: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    category: DISPLAY_KEY_CATEGORY,
    event,
    data: { key, ...extra },
  }]);
}

describe('measure-key-arrival — plan mode ordering', () => {
  test('each key captures the cursor and resets before sending that one key, and two keys do not interleave', async () => {
    const calls: string[] = [];
    const report = await measureKeyArrival(request({
      keys: ['C-n', '/'],
      screenRef: 'screen-a',
      plan: true,
      adapters: adapters({
        captureCursor: () => { calls.push('captureCursor'); return 'cursor'; },
        confirmScreen: () => { calls.push('confirmScreen'); return true; },
        resetScreen: () => { calls.push('resetScreen'); },
        sendKey: (key) => { calls.push(`sendKey:${key}`); },
        wait: () => { calls.push('wait'); },
      }),
      queryDisplayKey: () => { calls.push('queryDisplayKey'); return '[]'; },
    }));

    expect(calls).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.results).toEqual([]);
    expect(report.formatted.split('\n')).toEqual([
      'C-n: capture-cursor',
      'C-n: confirm-screen screen-a',
      'C-n: reset-screen screen-a',
      'C-n: send-key C-n',
      'C-n: wait',
      'C-n: query-display-key display.key',
      '/: capture-cursor',
      '/: confirm-screen screen-a',
      '/: reset-screen screen-a',
      '/: send-key /',
      '/: wait',
      '/: query-display-key display.key',
    ]);
    const firstKeyEnd = report.formatted.indexOf('/: capture-cursor');
    const firstSend = report.formatted.indexOf('C-n: send-key C-n');
    const firstCursor = report.formatted.indexOf('C-n: capture-cursor');
    const firstReset = report.formatted.indexOf('C-n: reset-screen');
    expect(firstCursor).toBeLessThan(firstReset);
    expect(firstReset).toBeLessThan(firstSend);
    expect(firstSend).toBeLessThan(firstKeyEnd);
    expect(planKeyArrival(['C-n', '/'], 'screen-a').map((step) => step.key)).toEqual([
      'C-n', 'C-n', 'C-n', 'C-n', 'C-n', 'C-n',
      '/', '/', '/', '/', '/', '/',
    ]);
  });
});

describe('measure-key-arrival — independent live order', () => {
  test('measures each key as cursor → screen confirm/reset → one send → wait → display.key query', async () => {
    const calls: string[] = [];
    let n = 0;
    const report = await measureKeyArrival(request({
      keys: ['C-n', '/'],
      screenRef: 'screen-a',
      adapters: adapters({
        captureCursor: () => { const cursor = `c${n += 1}`; calls.push(`capture:${cursor}`); return cursor; },
        confirmScreen: (screenRef) => { calls.push(`confirm:${screenRef}`); return true; },
        resetScreen: (screenRef) => { calls.push(`reset:${screenRef}`); },
        sendKey: (key) => { calls.push(`send:${key}`); },
        wait: () => { calls.push('wait'); },
      }),
      queryDisplayKey: (cursor) => {
        calls.push(`query:${cursor}`);
        return cursor === 'c1' ? displayKeyRecord('no-match', 'C-n') : '[]';
      },
    }));

    expect(calls).toEqual([
      'capture:c1', 'confirm:screen-a', 'reset:screen-a', 'send:C-n', 'wait', 'query:c1',
      'capture:c2', 'confirm:screen-a', 'reset:screen-a', 'send:/', 'wait', 'query:c2',
    ]);
    expect(report.results.map((result) => result.status)).toEqual(['arrived', 'not-arrived']);
    expect(report.exitCode).toBe(0);
  });
});

describe('measure-key-arrival — arrival and non-arrival', () => {
  test('no-match for the first key is arrival; empty valid records for the second key are not-arrival', async () => {
    let calls = 0;
    const report = await measureKeyArrival(request({
      keys: ['C-n', '/'],
      screenRef: 'screen-a',
      adapters: adapters({
        captureCursor: () => 'after-1',
        sendKey: () => undefined,
      }),
      queryDisplayKey: () => {
        calls += 1;
        return calls === 1 ? displayKeyRecord('no-match', 'C-n') : '[]';
      },
    }));
    expect(report.results).toEqual([
      { key: 'C-n', status: 'arrived', event: 'no-match' },
      { key: '/', status: 'not-arrived' },
    ]);
    expect(report.formatted).toContain('C-n: arrived no-match');
    expect(report.formatted).toContain('/: not-arrived');
    expect(report.exitCode).toBe(0);
  });

  test('when-false, chord-armed, and selected are arrival, including no-match', () => {
    expect(DISPLAY_KEY_ARRIVAL_EVENTS).toEqual(['no-match', 'when-false', 'chord-armed', 'selected']);
  });

  test.each([...DISPLAY_KEY_ARRIVAL_EVENTS] as const)('%s with matching data.key is arrived', async (event) => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => displayKeyRecord(event, 'C-n', event === 'selected' ? { id: 'binding' } : {}),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'arrived', event }]);
    expect(report.exitCode).toBe(0);
  });

  test('key.route records are not treated as arrival', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => JSON.stringify([{
        category: 'key.route',
        event: 'selected',
        data: { key: 'C-n' },
      }]),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'not-arrived' }]);
  });

  test('records without category are not arrival even when event and data.key match', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => JSON.stringify([{
        event: 'no-match',
        data: { key: 'C-n' },
      }]),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'not-arrived' }]);
    expect(report.exitCode).toBe(0);
  });

  test('records with a different category are ignored rather than treated as arrival', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => JSON.stringify([{
        category: 'display.other',
        event: 'selected',
        data: { key: 'C-n' },
      }]),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'not-arrived' }]);
  });

  test('does not query key.route in source', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(source).toContain(`'${DISPLAY_KEY_CATEGORY}'`);
    expect(source).not.toMatch(/exact-category['"]\s*,\s*['"]key\.route/);
    expect(source).not.toMatch(/category:\s*['"]key\.route['"]/);
  });
});

describe('measure-key-arrival — modifier-form key matching', () => {
  test('matches C/S/A hyphen prefixes exactly against data.key', async () => {
    let calls = 0;
    const report = await measureKeyArrival(request({
      keys: ['C-S-A-x', 'C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => {
        calls += 1;
        return calls === 1
          ? displayKeyRecord('selected', 'C-S-A-x')
          : displayKeyRecord('no-match', 'n');
      },
    }));
    expect(report.results[0]).toEqual({ key: 'C-S-A-x', status: 'arrived', event: 'selected' });
    expect(report.results[1]).toEqual({ key: 'C-n', status: 'not-arrived' });
  });
});

describe('measure-key-arrival — query failure is not non-arrival', () => {
  test('empty string query output is query-failed with nonzero exit and no not-arrived', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n', '/'],
      screenRef: 'screen-a',
      queryDisplayKey: () => '',
    }));
    expect(report.results.every((result) => result.status !== 'not-arrived')).toBe(true);
    expect(report.results.every((result) => result.status !== 'arrived')).toBe(true);
    expect(report.results.map((result) => result.status)).toEqual(['query-failed', 'query-failed']);
    expect(report.formatted).toContain('query-failed');
    expect(report.exitCode).not.toBe(0);
  });

  test('malformed query output is query-failed', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => 'not-json {',
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'query-failed' }]);
    expect(report.exitCode).not.toBe(0);
  });

  test('unexpected record shape is query-failed, not empty observation', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => JSON.stringify([{ category: DISPLAY_KEY_CATEGORY, data: { key: 'C-n' } }]),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'query-failed' }]);
    expect(report.exitCode).not.toBe(0);
  });

  test.each([
    {
      name: 'data: null',
      payload: JSON.stringify([{ category: DISPLAY_KEY_CATEGORY, event: 'no-match', data: null }]),
    },
    {
      name: 'data as array',
      payload: JSON.stringify([{ category: DISPLAY_KEY_CATEGORY, event: 'no-match', data: ['C-n'] }]),
    },
    {
      name: 'display.key without data.key',
      payload: JSON.stringify([{ category: DISPLAY_KEY_CATEGORY, event: 'no-match', data: { other: 'C-n' } }]),
    },
    {
      name: 'record itself is an array',
      payload: JSON.stringify([[{ category: DISPLAY_KEY_CATEGORY, event: 'no-match', data: { key: 'C-n' } }]]),
    },
  ])('$name is query-failed, not not-arrived', async ({ payload }) => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => payload,
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'query-failed' }]);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.exitCode).not.toBe(0);
  });

  test('synchronous throw from queryDisplayKey is query-failed with nonzero exit', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => {
        throw new Error('query exploded');
      },
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'query-failed' }]);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.exitCode).not.toBe(0);
  });

  test('rejected queryDisplayKey promise is query-failed with nonzero exit', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => Promise.reject(new Error('query rejected')),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'query-failed' }]);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.exitCode).not.toBe(0);
  });
});

describe('measure-key-arrival — missing dependencies and failure statuses', () => {
  test('omitting any of the five adapters is rejected and does not yield not-arrived', () => {
    for (const name of KEY_ARRIVAL_ADAPTER_NAMES) {
      const partial: Partial<KeyArrivalAdapters> = { ...adapters() };
      delete partial[name];
      expect(missingAdapterNames(partial)).toEqual([name]);
      expect(() => createKeyArrivalMeasurer(partial as KeyArrivalAdapters)).toThrow(`missing-adapter: ${name}`);
    }
  });

  test('measureKeyArrival names a missing adapter and does not answer arrived/not-arrived', async () => {
    const partial = { ...adapters() } as Partial<KeyArrivalAdapters>;
    delete partial.sendKey;
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      adapters: partial as KeyArrivalAdapters,
    }));
    expect(report.exitCode).not.toBe(0);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.results.some((result) => result.status === 'arrived')).toBe(false);
    expect(report.results).toEqual([{ key: '*', status: 'missing-adapter', missing: 'sendKey' }]);
    expect(report.formatted).toContain('missing-adapter sendKey');
  });

  test('plan mode still names a missing adapter and returns nonzero exit instead of a plan', async () => {
    const partial = { ...adapters() } as Partial<KeyArrivalAdapters>;
    delete partial.captureCursor;
    const report = await measureKeyArrival(request({
      keys: ['C-n', '/'],
      screenRef: 'screen-a',
      plan: true,
      adapters: partial as KeyArrivalAdapters,
    }));
    expect(report.exitCode).not.toBe(0);
    expect(report.plan).toEqual([]);
    expect(report.results).toEqual([{ key: '*', status: 'missing-adapter', missing: 'captureCursor' }]);
    expect(report.formatted).toContain('missing-adapter captureCursor');
    expect(report.formatted).not.toContain('capture-cursor');
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.results.some((result) => result.status === 'arrived')).toBe(false);
  });

  test('missing cursor does not send the key and is not not-arrived', async () => {
    const calls: string[] = [];
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      adapters: adapters({
        captureCursor: () => { calls.push('capture'); return null; },
        confirmScreen: () => { calls.push('confirm'); return true; },
        resetScreen: () => { calls.push('reset'); },
        sendKey: (key) => { calls.push(`send:${key}`); },
        wait: () => { calls.push('wait'); },
      }),
      queryDisplayKey: () => { calls.push('query'); return '[]'; },
    }));
    expect(calls).toEqual(['capture']);
    expect(report.results).toEqual([{ key: 'C-n', status: 'missing-cursor' }]);
    expect(report.exitCode).not.toBe(0);
  });

  test('missing screen is named, nonzero, and not counted as not-arrived', async () => {
    const calls: string[] = [];
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      adapters: adapters({
        captureCursor: () => { calls.push('capture'); return 'c1'; },
        confirmScreen: () => { calls.push('confirm'); return false; },
        resetScreen: () => { calls.push('reset'); },
        sendKey: (key) => { calls.push(`send:${key}`); },
      }),
    }));
    expect(calls).toEqual(['capture', 'confirm']);
    expect(report.results).toEqual([{ key: 'C-n', status: 'missing-screen' }]);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.exitCode).not.toBe(0);
  });

  test('the five adapter names are required in the exported contract', () => {
    expect(KEY_ARRIVAL_ADAPTER_NAMES).toEqual([
      'captureCursor',
      'confirmScreen',
      'resetScreen',
      'sendKey',
      'wait',
    ]);
    const source = readFileSync(SOURCE_PATH, 'utf8');
    for (const name of KEY_ARRIVAL_ADAPTER_NAMES) {
      expect(source).toMatch(new RegExp(`${name}: `));
      expect(source).not.toMatch(new RegExp(`${name}\\?:`));
    }
    const adaptersHaveNoOptionalFields: NoOptionalAdapters = true;
    expect(adaptersHaveNoOptionalFields).toBe(true);
  });
});

function cliDeps(overrides: Partial<MeasureKeyArrivalCliDeps> & { adapters?: KeyArrivalAdapters } = {}): MeasureKeyArrivalCliDeps {
  return {
    adapters: adapters(),
    queryDisplayKey: () => '[]',
    ...overrides,
  };
}

function queryPayload(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

const OPENED_STORES = { _meta: { type: 'log-query-opened-stores', stores: [] } };
const MULTI_SURFACE = { _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0 } };
const LIMIT_REACHED = { _meta: { type: 'log-query-limit', limitReached: true, effectiveLimit: 1 } };

describe('measure-key-arrival — query truncation vs absence vs failure', () => {
  test('log-query-limit with limitReached is truncated, not not-arrived', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => queryPayload([OPENED_STORES, MULTI_SURFACE, LIMIT_REACHED]),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'truncated' }]);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.exitCode).not.toBe(0);
  });

  test('opened-stores and duplicate metas without log-query-limit are not-arrived', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => queryPayload([OPENED_STORES, MULTI_SURFACE]),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'not-arrived' }]);
    expect(report.exitCode).toBe(0);
  });

  test('log-query-limit without a reached verdict is unmeasurable, not query-failed', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => queryPayload([{ _meta: { type: 'log-query-limit' } }]),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'unmeasurable' }]);
    expect(report.results.some((result) => result.status === 'query-failed')).toBe(false);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
  });

  test('log-query-limit with limitReached false is not-arrived because the query was complete', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => queryPayload([
        OPENED_STORES,
        MULTI_SURFACE,
        { _meta: { type: 'log-query-limit', limitReached: false, effectiveLimit: 50 } },
      ]),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'not-arrived' }]);
    expect(report.results.some((result) => result.status === 'unmeasurable')).toBe(false);
    expect(report.results.some((result) => result.status === 'truncated')).toBe(false);
    expect(report.exitCode).toBe(0);
  });

  test('log-query-limit with a non-boolean limitReached is unmeasurable', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      queryDisplayKey: () => queryPayload([{ _meta: { type: 'log-query-limit', limitReached: 'yes' } }]),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'unmeasurable' }]);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.exitCode).not.toBe(0);
  });

  test('queries the cursor once per key and does not page', async () => {
    const cursors: string[] = [];
    const report = await measureKeyArrival(request({
      keys: ['C-n', '/'],
      screenRef: 'screen-a',
      adapters: adapters({ captureCursor: () => 'after-1' }),
      queryDisplayKey: (cursor) => {
        cursors.push(cursor);
        return '[]';
      },
    }));
    expect(cursors).toEqual(['after-1', 'after-1']);
    expect(report.results.map((result) => result.status)).toEqual(['not-arrived', 'not-arrived']);
    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(source).not.toMatch(/afterId/);
    expect(source).not.toMatch(/while\s*\(/);
  });
});

describe('measure-key-arrival — injectable CLI seam', () => {
  test('missing screen ref is one readable sentence with nonzero exit and no stack', async () => {
    const result = await runMeasureKeyArrival(['--key', 'C-n'], cliDeps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('화면 참조가 없습니다.');
    expect(result.human).toBe('화면 참조가 없습니다.');
    expect(JSON.parse(result.machine)).toEqual({ error: '화면 참조가 없습니다.' });
    expect(result.stdout).not.toMatch(/\n\s+at /);
    expect(result.stdout).not.toContain('Error:');
  });

  test('missing key list is one readable sentence with nonzero exit and no stack', async () => {
    const result = await runMeasureKeyArrival(['--screen', 'screen-a'], cliDeps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('키 목록이 없습니다.');
    expect(result.human).toBe('키 목록이 없습니다.');
    expect(JSON.parse(result.machine)).toEqual({ error: '키 목록이 없습니다.' });
    expect(result.stdout).not.toMatch(/\n\s+at /);
  });

  test('plan mode with two keys never sends keys and prints the strike order', async () => {
    const calls: string[] = [];
    const result = await runMeasureKeyArrival(
      ['--screen', 'screen-a', '--plan', 'C-n', '/'],
      cliDeps({
        adapters: adapters({
          captureCursor: () => { calls.push('captureCursor'); return 'c'; },
          confirmScreen: () => { calls.push('confirmScreen'); return true; },
          resetScreen: () => { calls.push('resetScreen'); },
          sendKey: (key) => { calls.push(`sendKey:${key}`); },
          wait: () => { calls.push('wait'); },
        }),
        queryDisplayKey: () => { calls.push('queryDisplayKey'); return '[]'; },
      }),
    );
    expect(calls).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('C-n\tcapture-cursor');
    expect(result.stdout).toContain('C-n\tsend-key C-n');
    expect(result.stdout).toContain('/\tsend-key /');
    expect(result.stdout.indexOf('C-n\tsend-key C-n')).toBeLessThan(result.stdout.indexOf('/\tcapture-cursor'));
  });

  test('machine output has no color bytes and parses as structured JSON', async () => {
    const result = await runMeasureKeyArrival(
      ['--screen', 'screen-a', '--json', 'C-n'],
      cliDeps({ queryDisplayKey: () => displayKeyRecord('no-match', 'C-n') }),
    );
    expect(result.machine).not.toMatch(/\x1b\[|\u001b/);
    expect(result.machine).not.toMatch(/^안내|^note:|^hint:/i);
    expect(result.stdout).toBe(result.machine);
    const parsed = JSON.parse(result.machine) as { exitCode: number; results: unknown[]; plan: unknown[] };
    expect(parsed.exitCode).toBe(0);
    expect(parsed.results).toEqual([{ key: 'C-n', status: 'arrived', event: 'no-match' }]);
    expect(Array.isArray(parsed.plan)).toBe(true);
    expect(result.exitCode).toBe(parsed.exitCode);
  });

  test('query failure is named, never counted as not-arrived, and exits nonzero', async () => {
    const result = await runMeasureKeyArrival(
      ['--screen', 'screen-a', '--json', 'C-n', '/'],
      cliDeps({
        queryDisplayKey: () => {
          throw new Error('store down');
        },
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.machine).not.toMatch(/\x1b\[|\u001b/);
    expect(result.stdout).toBe(result.machine);
    const parsed = JSON.parse(result.machine) as { results: Array<{ status: string }> };
    expect(parsed.results.every((row) => row.status !== 'not-arrived')).toBe(true);
    expect(parsed.results.map((row) => row.status)).toEqual(['query-failed', 'query-failed']);
    expect(result.human).toBe('조회 실패');
    expect(result.human).not.toContain('안 닿았다');
  });

  test('human query-failed is one sentence, not a table, and machine still parses', async () => {
    const result = await runMeasureKeyArrival(
      ['--screen', 'screen-a', 'C-n', '/'],
      cliDeps({
        queryDisplayKey: () => {
          throw new Error('store down');
        },
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('조회 실패');
    expect(result.human).toBe('조회 실패');
    expect(result.stdout.split('\n')).toEqual(['조회 실패']);
    expect(result.stdout).not.toContain('\t');
    expect(result.stdout).not.toMatch(/\n\s+at /);
    const parsed = JSON.parse(result.machine) as { results: Array<{ status: string }> };
    expect(parsed.results.map((row) => row.status)).toEqual(['query-failed', 'query-failed']);
    expect(parsed.results.every((row) => row.status !== 'not-arrived')).toBe(true);
  });

  test('human missing-screen during measure is one sentence, not a table', async () => {
    const result = await runMeasureKeyArrival(
      ['--screen', 'screen-a', 'C-n'],
      cliDeps({ adapters: adapters({ confirmScreen: () => false }) }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('화면 참조 부재');
    expect(result.human).toBe('화면 참조 부재');
    expect(result.stdout.split('\n')).toEqual(['화면 참조 부재']);
    expect(result.stdout).not.toContain('\t');
    expect(result.stdout).not.toMatch(/\n\s+at /);
    const parsed = JSON.parse(result.machine) as { results: Array<{ key: string; status: string }> };
    expect(parsed.results).toEqual([{ key: 'C-n', status: 'missing-screen' }]);
    expect(parsed.results.some((row) => row.status === 'not-arrived')).toBe(false);
  });

  test.each([
    {
      status: 'truncated' as const,
      sentence: '잘렸다',
      deps: (): MeasureKeyArrivalCliDeps => cliDeps({
        queryDisplayKey: () => queryPayload([OPENED_STORES, MULTI_SURFACE, LIMIT_REACHED]),
      }),
    },
    {
      status: 'unmeasurable' as const,
      sentence: '측정 불가',
      deps: (): MeasureKeyArrivalCliDeps => cliDeps({
        queryDisplayKey: () => queryPayload([{ _meta: { type: 'log-query-limit' } }]),
      }),
    },
    {
      status: 'missing-cursor' as const,
      sentence: '커서 부재',
      deps: (): MeasureKeyArrivalCliDeps => cliDeps({
        adapters: adapters({ captureCursor: () => null }),
      }),
    },
    {
      status: 'could-not-send' as const,
      sentence: '못 보냈다',
      deps: (): MeasureKeyArrivalCliDeps => cliDeps({
        adapters: adapters({
          sendKey: () => {
            throw new Error('unknown PTY special key: zzz');
          },
        }),
      }),
    },
    {
      status: 'could-not-reset' as const,
      sentence: '되돌리지 못했다',
      deps: (): MeasureKeyArrivalCliDeps => cliDeps({
        adapters: adapters({
          resetScreen: () => {
            throw new Error('pty key 실패');
          },
        }),
      }),
    },
  ])('human $status is one sentence, not a table, with nonzero exit', async ({ status, sentence, deps }) => {
    const result = await runMeasureKeyArrival(['--screen', 'screen-a', 'C-n'], deps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe(sentence);
    expect(result.human).toBe(sentence);
    expect(result.stdout.split('\n')).toEqual([sentence]);
    expect(result.stdout).not.toContain('키\t판정');
    expect(result.stdout).not.toContain('\t');
    expect(result.stdout).not.toMatch(/\n\s+at /);
    expect(result.stdout).not.toContain('Error:');
    const parsed = JSON.parse(result.machine) as { results: Array<{ key: string; status: string }> };
    expect(parsed.results).toEqual([{ key: 'C-n', status }]);
    expect(parsed.results.some((row) => row.status === 'not-arrived')).toBe(false);
  });

  test('first key arrives and second does not, with zero exit in both human and machine output', async () => {
    const firstArrivesSecondDoesNot = (): MeasureKeyArrivalCliDeps => {
      let n = 0;
      return cliDeps({
        adapters: adapters({
          captureCursor: () => `c${n += 1}`,
        }),
        queryDisplayKey: (cursor) => (
          cursor === 'c1'
            ? displayKeyRecord('no-match', 'C-n')
            : queryPayload([OPENED_STORES, MULTI_SURFACE])
        ),
      });
    };
    const human = await runMeasureKeyArrival(['--screen', 'screen-a', 'C-n', '/'], firstArrivesSecondDoesNot());
    const machine = await runMeasureKeyArrival(['--screen', 'screen-a', '--json', 'C-n', '/'], firstArrivesSecondDoesNot());
    expect(human.exitCode).toBe(0);
    expect(machine.exitCode).toBe(0);
    expect(human.stdout).toContain('C-n\t닿았다');
    expect(human.stdout).toContain('/\t안 닿았다');
    expect(machine.stdout).toBe(machine.machine);
    const parsed = JSON.parse(machine.machine) as { results: Array<{ key: string; status: string; event?: string }> };
    expect(parsed.results).toEqual([
      { key: 'C-n', status: 'arrived', event: 'no-match' },
      { key: '/', status: 'not-arrived' },
    ]);
    expect(JSON.parse(human.machine)).toEqual(parsed);
  });

  test('missing required adapter is named and not judged not-arrived', async () => {
    const partial = { ...adapters() } as Partial<KeyArrivalAdapters>;
    delete partial.sendKey;
    const result = await runMeasureKeyArrival(
      ['--screen', 'screen-a', 'C-n'],
      cliDeps({ adapters: partial as KeyArrivalAdapters }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('어댑터가 없습니다: sendKey');
    expect(result.stdout).not.toContain('안 닿았다');
    expect(result.stdout).not.toMatch(/\n\s+at /);
  });

  test('direct entry calls the existing CLI seam with the real adapter', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(source).toContain('export async function runMeasureKeyArrival');
    expect(source).toContain('if (import.meta.main)');
    expect(source).toContain('runMeasureKeyArrival(');
    expect(source).toContain('process.argv.slice(2)');
    expect(source).toContain('createRealKeyArrivalAdapters(');
    expect(source).toContain("export const DISPLAY_KEY_CATEGORY = 'display.key'");
    expect(source).toContain('export const DISPLAY_KEY_ARRIVAL_EVENTS');
    expect(source).toContain('export const KEY_ARRIVAL_ADAPTER_NAMES');
    expect(source).toContain('export interface KeyArrivalAdapters');
    expect(source).toContain('export type KeyArrivalStatus');
    expect(source).toContain('export interface KeyArrivalResult');
    expect(source).toContain('export type KeyArrivalPlanActionName');
    expect(source).toContain('export interface KeyArrivalPlanAction');
    expect(source.match(/export async function runMeasureKeyArrival/g)).toHaveLength(1);
  });
});

const REPO_ROOT = join(dirname(SOURCE_PATH), '..');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runScript(args: readonly string[], env: NodeJS.ProcessEnv = process.env): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const child = Bun.spawnSync({
    cmd: [process.execPath, SOURCE_PATH, ...args],
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  return {
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    exitCode: child.exitCode ?? 1,
  };
}

function displayKeyRow(id: number, event: string, key: string): Record<string, unknown> {
  return { id, category: DISPLAY_KEY_CATEGORY, event, data: { key } };
}

function fakeElanous(
  handler: (argv: readonly string[], calls: string[][]) => ElanousCommandResult,
): { run: ElanousCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (argv) => {
      calls.push([...argv]);
      return handler(argv, calls);
    },
  };
}

function okLogs(rows: unknown[]): ElanousCommandResult {
  return { exitCode: 0, stdout: rows.map((row) => JSON.stringify(row)).join('\n'), stderr: '' };
}

function okPty(): ElanousCommandResult {
  return { exitCode: 0, stdout: 'ok', stderr: '' };
}

describe('measure-key-arrival — real elanous adapter', () => {
  test('defaults to bun bin/elanous.mjs and only the observed pty/logs commands', async () => {
    const { run, calls } = fakeElanous((argv) => {
      if (argv.includes('logs')) return okLogs([displayKeyRow(4, 'no-match', 'other')]);
      return okPty();
    });
    const deps = createRealKeyArrivalAdapters({ run });
    const report = await measureKeyArrival({
      keys: ['C-n'],
      screenRef: 'screen-a',
      adapters: deps.adapters,
      queryDisplayKey: deps.queryDisplayKey,
    });
    expect([...DEFAULT_ELANOUS_COMMAND]).toEqual(['bun', 'bin/elanous.mjs']);
    expect(calls.every((argv) => argv[0] === 'bun' && argv[1] === 'bin/elanous.mjs')).toBe(true);
    expect(calls.map((argv) => argv.slice(2, 4))).toEqual([
      ['logs', '--exact-category'],
      ['pty', 'snapshot'],
      ['pty', 'key'],
      ['logs', '--exact-category'],
      ['pty', 'key'],
      ['logs', '--exact-category'],
    ]);
    expect(calls[0]).toEqual([
      'bun', 'bin/elanous.mjs', 'logs',
      '--exact-category', DISPLAY_KEY_CATEGORY,
      '--since', DEFAULT_KEY_ARRIVAL_LOG_SINCE,
      '--limit', String(DEFAULT_KEY_ARRIVAL_LOG_LIMIT),
      '--json', '--json-data', '--all', '--include-test',
    ]);
    expect(calls[2]).toEqual(['bun', 'bin/elanous.mjs', 'pty', 'key', 'screen-a', 'ctrl+u']);
    expect(calls[4]).toEqual(['bun', 'bin/elanous.mjs', 'pty', 'key', 'screen-a', 'ctrl+n']);
    expect(calls.some((argv) => argv.includes('text'))).toBe(false);
    expect(calls.flat().includes('--before')).toBe(false);
    expect(calls.flat().includes('--after')).toBe(false);
    expect(calls.filter((argv) => argv.includes('logs'))).toHaveLength(3);
    expect(report.results).toEqual([{ key: 'C-n', status: 'not-arrived' }]);
  });

  test('command runner is injectable and does not invent pagination options', async () => {
    const logs = fakeElanous((argv) => {
      if (argv.includes('logs')) return okLogs([]);
      return okPty();
    });
    const deps = createRealKeyArrivalAdapters({ command: ['custom-elanous'], run: logs.run });
    await measureKeyArrival({
      keys: ['/'],
      screenRef: 'pane-1',
      adapters: deps.adapters,
      queryDisplayKey: deps.queryDisplayKey,
    });
    expect(logs.calls.every((argv) => argv[0] === 'custom-elanous')).toBe(true);
    expect(logs.calls.some((argv) => argv.slice(1, 3).join(' ') === 'pty text' && argv.includes('/'))).toBe(true);
    expect(logs.calls.some((argv) => argv.includes('--before') || argv.includes('--after') || argv.includes('afterId'))).toBe(false);
    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(source).not.toMatch(/--after\b/);
    expect(source).not.toMatch(/\bafterId\b/);
  });

  test('rows at or below the captured id are not this key even when event and data.key match', async () => {
    let logs = 0;
    const { run } = fakeElanous((argv) => {
      if (argv.includes('logs')) {
        logs += 1;
        return okLogs([
          displayKeyRow(10, 'no-match', 'C-n'),
          displayKeyRow(11, 'selected', 'C-n'),
        ]);
      }
      return okPty();
    });
    const deps = createRealKeyArrivalAdapters({ run });
    const report = await measureKeyArrival({
      keys: ['C-n'],
      screenRef: 'screen-a',
      adapters: deps.adapters,
      queryDisplayKey: deps.queryDisplayKey,
    });
    expect(logs).toBe(3);
    expect(report.results).toEqual([{ key: 'C-n', status: 'not-arrived' }]);
    expect(report.results.some((result) => result.status === 'arrived')).toBe(false);
  });

  test('only rows with id greater than the captured baseline count as this key', async () => {
    let logs = 0;
    const { run } = fakeElanous((argv) => {
      if (!argv.includes('logs')) return okPty();
      logs += 1;
      if (logs <= 2) {
        return okLogs([displayKeyRow(11, 'no-match', 'C-n')]);
      }
      return okLogs([
        displayKeyRow(11, 'no-match', 'C-n'),
        displayKeyRow(12, 'selected', 'C-n'),
      ]);
    });
    const deps = createRealKeyArrivalAdapters({ run });
    const report = await measureKeyArrival({
      keys: ['C-n'],
      screenRef: 'screen-a',
      adapters: deps.adapters,
      queryDisplayKey: deps.queryDisplayKey,
    });
    expect(report.results).toEqual([{ key: 'C-n', status: 'arrived', event: 'selected' }]);
  });

  test('C-n is sent as pty key ctrl+n and never as pty text', async () => {
    const { run, calls } = fakeElanous((argv) => {
      if (argv.includes('logs')) return okLogs([displayKeyRow(4, 'no-match', 'other')]);
      return okPty();
    });
    const deps = createRealKeyArrivalAdapters({ run });
    await deps.adapters.confirmScreen('screen-a');
    await deps.adapters.sendKey('C-n');
    const sendCalls = calls.filter((argv) => argv.includes('pty') && !argv.includes('snapshot'));
    expect(sendCalls).toEqual([['bun', 'bin/elanous.mjs', 'pty', 'key', 'screen-a', 'ctrl+n']]);
    expect(calls.some((argv) => argv.includes('text'))).toBe(false);
    expect(calls.some((argv) => argv.includes('ctrl+n'))).toBe(true);
    expect(calls.some((argv) => argv.includes('key'))).toBe(true);
  });

  test('ordinary text still uses pty text', async () => {
    const { run, calls } = fakeElanous(() => okPty());
    const deps = createRealKeyArrivalAdapters({ run });
    await deps.adapters.confirmScreen('pane-1');
    await deps.adapters.sendKey('/');
    expect(calls.some((argv) => argv.includes('pty') && argv.includes('text') && argv.includes('/'))).toBe(true);
    expect(calls.some((argv) => argv.includes('ctrl+/'))).toBe(false);
  });

  test('a pty key rejection is could-not-send, not not-arrived, with nonzero exit', async () => {
    const { run, calls } = fakeElanous((argv) => {
      if (argv.includes('logs')) return okLogs([displayKeyRow(4, 'no-match', 'other')]);
      if (argv.includes('pty') && argv.includes('key') && argv.includes('A-n')) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'unknown PTY special key: A-n; available names: up, down, ctrl+a..ctrl+z',
        };
      }
      return okPty();
    });
    const deps = createRealKeyArrivalAdapters({ run });
    const report = await measureKeyArrival({
      keys: ['A-n'],
      screenRef: 'screen-a',
      adapters: deps.adapters,
      queryDisplayKey: deps.queryDisplayKey,
    });
    expect(report.results).toEqual([{ key: 'A-n', status: 'could-not-send' }]);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.exitCode).not.toBe(0);
    expect(calls.some((argv) => argv.includes('pty') && argv.includes('key') && argv.includes('A-n'))).toBe(true);
    expect(calls.some((argv) => argv.includes('text') && argv.includes('A-n'))).toBe(false);
    expect(calls.filter((argv) => argv.includes('logs'))).toHaveLength(2);
  });

  test('resetScreen clears the input buffer with pty key and does not only snapshot', async () => {
    const { run, calls } = fakeElanous((argv) => {
      if (argv.includes('logs')) return okLogs([]);
      return okPty();
    });
    const deps = createRealKeyArrivalAdapters({ run });
    await deps.adapters.resetScreen('screen-a');
    expect(calls[0]).toEqual(['bun', 'bin/elanous.mjs', 'pty', 'key', 'screen-a', 'ctrl+u']);
    expect(calls[1]?.slice(2, 4)).toEqual(['logs', '--exact-category']);
    expect(calls.some((argv) => argv.includes('snapshot'))).toBe(false);
    expect(calls.some((argv) => argv.includes('pty') && argv.includes('key') && argv.includes('ctrl+u'))).toBe(true);
  });

  test('reset ctrl+u display-key log is not counted as C-u arrival', async () => {
    let logs = 0;
    const { run, calls } = fakeElanous((argv) => {
      if (!argv.includes('logs')) return okPty();
      logs += 1;
      if (logs === 1) return okLogs([displayKeyRow(10, 'no-match', 'other')]);
      return okLogs([
        displayKeyRow(10, 'no-match', 'other'),
        displayKeyRow(11, 'selected', 'C-u'),
      ]);
    });
    const deps = createRealKeyArrivalAdapters({ run });
    const report = await measureKeyArrival({
      keys: ['C-u'],
      screenRef: 'screen-a',
      adapters: deps.adapters,
      queryDisplayKey: deps.queryDisplayKey,
    });
    expect(calls.filter((argv) => argv.includes('pty') && argv.includes('key') && argv.includes('ctrl+u'))).toHaveLength(2);
    expect(logs).toBe(3);
    expect(report.results).toEqual([{ key: 'C-u', status: 'not-arrived' }]);
    expect(report.results.some((result) => result.status === 'arrived')).toBe(false);
    expect(report.exitCode).toBe(0);
  });

  test('C-u arrival counts only the post-reset send, not the reset event', async () => {
    let logs = 0;
    const { run } = fakeElanous((argv) => {
      if (!argv.includes('logs')) return okPty();
      logs += 1;
      if (logs === 1) return okLogs([displayKeyRow(10, 'no-match', 'other')]);
      if (logs === 2) {
        return okLogs([
          displayKeyRow(10, 'no-match', 'other'),
          displayKeyRow(11, 'selected', 'C-u'),
        ]);
      }
      return okLogs([
        displayKeyRow(10, 'no-match', 'other'),
        displayKeyRow(11, 'selected', 'C-u'),
        displayKeyRow(12, 'no-match', 'C-u'),
      ]);
    });
    const deps = createRealKeyArrivalAdapters({ run });
    const report = await measureKeyArrival({
      keys: ['C-u'],
      screenRef: 'screen-a',
      adapters: deps.adapters,
      queryDisplayKey: deps.queryDisplayKey,
    });
    expect(report.results).toEqual([{ key: 'C-u', status: 'arrived', event: 'no-match' }]);
    expect(report.exitCode).toBe(0);
  });

  test('failed cursor recapture after reset is could-not-reset, not arrived', async () => {
    let logs = 0;
    const { run } = fakeElanous((argv) => {
      if (argv.includes('logs')) {
        logs += 1;
        if (logs === 1) return okLogs([displayKeyRow(10, 'no-match', 'other')]);
        return { exitCode: 1, stdout: '', stderr: 'store down' };
      }
      return okPty();
    });
    const deps = createRealKeyArrivalAdapters({ run });
    const report = await measureKeyArrival({
      keys: ['C-u'],
      screenRef: 'screen-a',
      adapters: deps.adapters,
      queryDisplayKey: deps.queryDisplayKey,
    });
    expect(report.results).toEqual([{ key: 'C-u', status: 'could-not-reset' }]);
    expect(report.results.some((result) => result.status === 'arrived')).toBe(false);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.exitCode).not.toBe(0);
  });

  test('reset failure is named could-not-reset, does not send, and is not not-arrived', async () => {
    const calls: string[] = [];
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      adapters: adapters({
        captureCursor: () => { calls.push('capture'); return 'c1'; },
        confirmScreen: () => { calls.push('confirm'); return true; },
        resetScreen: () => { calls.push('reset'); throw new Error('pty key 실패'); },
        sendKey: (key) => { calls.push(`send:${key}`); },
        wait: () => { calls.push('wait'); },
      }),
      queryDisplayKey: () => { calls.push('query'); return '[]'; },
    }));
    expect(calls).toEqual(['capture', 'confirm', 'reset']);
    expect(report.results).toEqual([{ key: 'C-n', status: 'could-not-reset' }]);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.exitCode).not.toBe(0);
  });

  test('sendKey throw is could-not-send with nonzero exit and is not not-arrived', async () => {
    const report = await measureKeyArrival(request({
      keys: ['C-n'],
      screenRef: 'screen-a',
      adapters: adapters({
        sendKey: () => {
          throw new Error('unknown PTY special key: zzz');
        },
      }),
    }));
    expect(report.results).toEqual([{ key: 'C-n', status: 'could-not-send' }]);
    expect(report.results.some((result) => result.status === 'not-arrived')).toBe(false);
    expect(report.formatted).toContain('could-not-send');
    expect(report.exitCode).not.toBe(0);
  });

  test('limitReached meta is truncated; missing meta is not-arrived; failed query is query-failed', async () => {
    const cases: Array<{
      name: string;
      query: ElanousCommandResult;
      status: 'truncated' | 'not-arrived' | 'query-failed';
    }> = [
      {
        name: 'truncated',
        query: okLogs([OPENED_STORES, MULTI_SURFACE, LIMIT_REACHED]),
        status: 'truncated',
      },
      {
        name: 'not-arrived',
        query: okLogs([OPENED_STORES, MULTI_SURFACE, displayKeyRow(3, 'no-match', 'C-n')]),
        status: 'not-arrived',
      },
      {
        name: 'query-failed',
        query: { exitCode: 1, stdout: '', stderr: 'store down' },
        status: 'query-failed',
      },
    ];
    for (const item of cases) {
      let logs = 0;
      const { run } = fakeElanous((argv) => {
        if (!argv.includes('logs')) return okPty();
        logs += 1;
        if (logs <= 2) return okLogs([displayKeyRow(9, 'no-match', 'other')]);
        return item.query;
      });
      const deps = createRealKeyArrivalAdapters({ run });
      const report = await measureKeyArrival({
        keys: ['C-n'],
        screenRef: 'screen-a',
        adapters: deps.adapters,
        queryDisplayKey: deps.queryDisplayKey,
      });
      expect(report.results).toEqual([{ key: 'C-n', status: item.status }]);
    }
  });
});

describe('measure-key-arrival — direct execution', () => {
  test('--help lists the observed option names, exits zero, and is not an unknown-option error', () => {
    const result = runScript(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('알 수 없는 옵션');
    expect(result.stderr).not.toContain('알 수 없는 옵션');
    for (const option of [
      '--help',
      '--screen',
      '--screen-ref',
      '--key',
      '--plan',
      '--json',
      '--json-data',
      '--since',
      '--limit',
      '--all',
      '--include-test',
      '--exact-category',
      '--enter',
      '--actor',
    ]) {
      expect(result.stdout).toContain(option);
    }
  });

  test('CLI seam --help is the documented options with zero exit', async () => {
    const result = await runMeasureKeyArrival(['--help'], cliDeps());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('알 수 없는 옵션');
    expect(result.stdout).toContain('--help');
    expect(result.stdout).toContain('--screen');
    expect(result.stdout).toContain('--screen-ref');
    expect(result.stdout).toContain('--key');
    expect(result.stdout).toContain('--plan');
    expect(result.stdout).toContain('--json');
    expect(result.stdout).toContain('--json-data');
    expect(result.stdout).toContain('--since');
    expect(result.stdout).toContain('--limit');
    expect(result.stdout).toContain('--all');
    expect(result.stdout).toContain('--include-test');
    expect(result.stdout).toContain('--exact-category');
    expect(result.stdout).toContain('--enter');
    expect(result.stdout).toContain('--actor');
  });

  test('unknown options remain rejected after help is added', async () => {
    const result = await runMeasureKeyArrival(['--not-a-real-flag'], cliDeps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('알 수 없는 옵션 --not-a-real-flag');
  });

  test('no arguments prints one readable sentence and exits nonzero', () => {
    const result = runScript([]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.trim()).toBe('화면 참조가 없습니다.');
    expect(result.stdout).not.toMatch(/\n\s+at /);
    expect(result.stdout).not.toContain('Error:');
  });

  test('a missing screen ref is named, exits nonzero, and is not counted as not-arrived', () => {
    const dir = mkdtempSync(join(tmpdir(), 'key-arrival-missing-screen-'));
    temporaryRoots.push(dir);
    const fake = join(dir, 'elanous-cmd');
    const screenRef = 'missing-screen-ref-for-key-arrival';
    writeFileSync(fake, `#!/bin/sh
if [ "$1" = pty ] && [ "$2" = snapshot ]; then
  echo "pty snapshot: $3" >&2
  exit 1
fi
if [ "$1" = logs ]; then
  echo '[]'
  exit 0
fi
exit 1
`);
    chmodSync(fake, 0o755);
    const env = { ...process.env, MEASURE_KEY_ARRIVAL_COMMAND: fake };
    const human = runScript(['--screen', screenRef, 'C-n'], env);
    expect(human.exitCode).not.toBe(0);
    expect(human.stdout.trim()).toBe('화면 참조 부재');
    expect(human.stdout).not.toContain('안 닿았다');
    expect(human.stdout).not.toMatch(/\n\s+at /);
    const machine = runScript(['--screen', screenRef, '--json', 'C-n'], env);
    expect(machine.exitCode).not.toBe(0);
    const parsed = JSON.parse(machine.stdout) as { results: Array<{ key: string; status: string }> };
    expect(parsed.results).toEqual([{ key: 'C-n', status: 'missing-screen' }]);
    expect(parsed.results.some((row) => row.status === 'not-arrived')).toBe(false);
  });

  test('plan mode prints strike order and never invokes an external command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'key-arrival-plan-'));
    temporaryRoots.push(dir);
    const marker = join(dir, 'called');
    writeFileSync(join(dir, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${marker}'\nexit 1\n`);
    chmodSync(join(dir, 'bun'), 0o755);
    const result = runScript(
      ['--plan', '--screen', 'screen-a', 'C-n', '/'],
      { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('C-n\tcapture-cursor');
    expect(result.stdout).toContain('C-n\tsend-key C-n');
    expect(result.stdout).toContain('/\tsend-key /');
    expect(result.stdout.indexOf('C-n\tsend-key C-n')).toBeLessThan(result.stdout.indexOf('/\tcapture-cursor'));
    expect(() => readFileSync(marker, 'utf8')).toThrow();
  });

  test('json mode has no color bytes and parses as structured JSON', () => {
    const result = runScript(['--json', '--plan', '--screen', 'screen-a', 'C-n', '/']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/\x1b\[|\u001b/);
    const parsed = JSON.parse(result.stdout) as { exitCode: number; results: unknown[]; plan: unknown[] };
    expect(parsed.exitCode).toBe(0);
    expect(parsed.results).toEqual([]);
    expect(Array.isArray(parsed.plan)).toBe(true);
    expect(parsed.plan.length).toBeGreaterThan(0);
  });
});
