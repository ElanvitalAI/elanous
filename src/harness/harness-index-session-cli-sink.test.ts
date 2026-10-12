import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import * as ui from '../ui.js';
import * as realLogSink from '../domains/standalone-log-sink.js';
import * as realSessionQueryTool from '../domains/session-query-tool.js';
import { appendMessage, createSession, listSessions } from '../session/index.js';

const calls: string[] = [];
const sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-session-list-json-'));
let sinkShouldFail = false;
let federationArgs: Record<string, unknown> | undefined;

mock.module('../domains/standalone-log-sink.js', () => ({
  ...realLogSink,
  registerStandaloneLogSink: async (surface: string) => {
    calls.push(`sink:${surface}`);
    if (sinkShouldFail) throw new Error('logs.db unavailable');
  },
}));

// mock 은 실제 모듈의 export 표면 전체를 페스스루 한다 — factory 가 내보내는
// 객체가 원본 named export(SESSION_MANAGE_SPEC 등)를 빠뜨리면, 같은 Bun 프로세스
// 샤드에서 뒤에 로드되는 시험(autopilot tool-registry 등)의 ESM 링크가
// `SyntaxError: Export named 'SESSION_MANAGE_SPEC' not found` 로 깨진다(실측).
mock.module('../domains/session-query-tool.js', () => ({
  ...realSessionQueryTool,
  dispatchSessionQuery: async (args: Record<string, unknown>) => {
    federationArgs = args;
    return {
      sessions: [{ id: 'federated-session', createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:01:00.000Z', messageCount: 3, title: 'federated', instance: 'other' }],
      instances: ['other'],
      count: 1,
    };
  },
}));

let program: Command;
let infoSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  process.env.ELANOUS_SESSION_ROOT = sessionRoot;
  process.env.ELANOUS_STATE_DIR = sessionRoot;
  ({ program } = await import('../index.js'));
  program.exitOverride();
});

beforeEach(() => {
  calls.length = 0;
  federationArgs = undefined;
  sinkShouldFail = true;
  infoSpy = spyOn(ui, 'info').mockImplementation(((message: string) => {
    calls.push(`action:${message}`);
  }) as never);
});

afterEach(() => infoSpy.mockRestore());
afterAll(() => {
  delete process.env.ELANOUS_SESSION_ROOT;
  delete process.env.ELANOUS_STATE_DIR;
  rmSync(sessionRoot, { recursive: true, force: true });
});

describe('production session CLI sink wiring', () => {
  test('the actual index session actions continue after a failed first registration and register once', async () => {
    await program.parseAsync(['node', 'elanous', 'session', 'list']);
    await program.parseAsync(['node', 'elanous', 'session', 'list']);

    expect(calls[0]).toBe('sink:session-cli');
    expect(calls.filter((call) => call === 'sink:session-cli')).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('action:'))).toHaveLength(2);
  });

  test('emits filtered local SessionMeta rows as a pure JSON array', async () => {
    const cli = createSession({ source: 'cli', title: 'cli row' }, sessionRoot);
    appendMessage(cli.id, { role: 'user', content: 'one', ts: '2026-08-13T00:00:00.000Z' }, sessionRoot);
    appendMessage(cli.id, { role: 'assistant', content: 'two', ts: '2026-08-13T00:01:00.000Z' }, sessionRoot);
    const telegram = createSession({ source: 'telegram', title: 'telegram row' }, sessionRoot);
    appendMessage(telegram.id, { role: 'user', content: 'three', ts: '2026-08-13T00:02:00.000Z' }, sessionRoot);
    const empty = createSession({ source: 'cli', title: 'empty row' }, sessionRoot);
    const output: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((line: string, callback?: (error?: Error | null) => void) => {
      output.push(line);
      callback?.();
      return true;
    }) as never);
    try {
      await program.parseAsync(['node', 'elanous', 'session', 'list', '--json', '--limit', '1', '--source', 'cli', '--min-msg', '2', '--instance', cli.originInstance!]);
      const rows = JSON.parse(output.join(''));
      expect(rows).toEqual([listSessions({ source: 'cli', minMessages: 2, originInstance: cli.originInstance, excludeSourceKinds: ['scheduled'] }, sessionRoot)[0]]);
      expect(rows[0]).toEqual(expect.objectContaining({ id: cli.id, createdAt: expect.any(String), updatedAt: expect.any(String), messageCount: 2 }));
      expect(output.join('')).toBe(`${JSON.stringify(rows, null, 2)}\n`);
      expect(output.join('')).not.toContain('Sessions (');

      output.length = 0;
      await program.parseAsync(['node', 'elanous', 'session', 'list', '--json', '--exclude-source', 'telegram', '--all']);
      const excluded = JSON.parse(output.join(''));
      expect(excluded.map((row: { id: string }) => row.id)).toContain(empty.id);
      expect(excluded.map((row: { id: string }) => row.id)).not.toContain(telegram.id);
    } finally {
      write.mockRestore();
    }
  });

  test('emits federated JSON without widening dispatchSessionQuery arguments', async () => {
    const output: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((line: string, callback?: (error?: Error | null) => void) => {
      output.push(line);
      callback?.();
      return true;
    }) as never);
    try {
      await program.parseAsync(['node', 'elanous', 'session', 'list', '--all-instances', '--json', '--source', 'cli', '--min-msg', '2', '--all', '--include-test', '--limit', '4', '--exclude-source', 'telegram', '--instance', 'prod']);
      const rows = JSON.parse(output.join(''));
      expect(rows).toEqual([{ id: 'federated-session', createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:01:00.000Z', messageCount: 3, title: 'federated', instance: 'other' }]);
      expect(output.join('')).toBe(`${JSON.stringify(rows, null, 2)}\n`);
      expect(federationArgs).toEqual({ action: 'list', allInstances: true, source: 'cli', minMessages: 2, all: true, includeTest: true, limit: 4 });
      expect(federationArgs).not.toHaveProperty('excludeSource');
      expect(federationArgs).not.toHaveProperty('instance');
    } finally {
      write.mockRestore();
    }
  });

  test('awaits local JSON stdout completion before parseAsync returns', async () => {
    let completed = false;
    const write = spyOn(process.stdout, 'write').mockImplementation(((line: string, callback?: (error?: Error | null) => void) => {
      setTimeout(() => { completed = true; callback?.(); }, 10);
      return false;
    }) as never);
    try {
      await program.parseAsync(['node', 'elanous', 'session', 'list', '--json']);
      expect(completed).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  test('awaits federated JSON stdout completion before parseAsync returns', async () => {
    let completed = false;
    const write = spyOn(process.stdout, 'write').mockImplementation(((line: string, callback?: (error?: Error | null) => void) => {
      setTimeout(() => { completed = true; callback?.(); }, 10);
      return false;
    }) as never);
    try {
      await program.parseAsync(['node', 'elanous', 'session', 'list', '--all-instances', '--json']);
      expect(completed).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  test('keeps the non-JSON Sessions header', async () => {
    const output: string[] = [];
    const header = spyOn(ui, 'header').mockImplementation((line: string) => output.push(line));
    try {
      await program.parseAsync(['node', 'elanous', 'session', 'list', '--limit', '1']);
      expect(output.some((line) => line.startsWith('Sessions ('))).toBe(true);
    } finally {
      header.mockRestore();
    }
  });
});
