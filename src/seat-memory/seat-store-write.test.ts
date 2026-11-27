// SEAT-MEMORY-SYNC — `memory add --seat` authority and the daily CLAUDE-OP session entry (same day replaces · MEMORY.md
// upserted once · `source: CLAUDE-OP` front matter). Independent literals.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { proxySessionName, seatWriteAuthority, syncProxySession } from './seat-store-write.js';
import { listSeatMemories, saveSeatMemory, seatMemoryDir } from './seat-memory.js';
import { registerMemoryCommands } from '../cli/memory-cli.js';

const dirs: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'seat-store-write-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('seatWriteAuthority', () => {
  test('own seat · CLAUDE-OP → OP pass; another seat, CLAUDE-OP → TC, no caller refused', () => {
    expect(seatWriteAuthority({ target: 'tc', caller: 'TC' })).toEqual({ ok: true, seat: 'TC', via: 'own' });
    expect(seatWriteAuthority({ target: 'OP', caller: 'claude-op' })).toEqual({ ok: true, seat: 'OP', via: 'proxy' });
    expect(seatWriteAuthority({ target: 'OP', caller: 'TC' })).toEqual({ ok: false, line: 'memory: TC may not write the OP seat store (own seat only · CLAUDE-OP may also write OP)' });
    expect(seatWriteAuthority({ target: 'TC', caller: 'CLAUDE-OP' }).ok).toBe(false);
    expect(seatWriteAuthority({ target: 'OP', caller: null }).ok).toBe(false);
  });
  test('path parts, the common layer and bad ids are refused', () => {
    for (const bad of ['../OP', 'OP/..', '..', 'seats/OP', '_common', '', 'O P', '/OP', 'OP\n']) {
      expect(seatWriteAuthority({ target: bad, caller: bad.trim() || 'OP' }).ok).toBe(false);
    }
  });
});

describe('syncProxySession', () => {
  const day = new Date(2026, 10, 26, 21, 5);
  test('name is the local day; a second sync the same day replaces; the index holds one line; source front matter', () => {
    const dir = temp();
    expect(proxySessionName(day)).toBe('proxy-session-2026-11-26');
    const a = syncProxySession({ body: 'CEO asked: proxy lane → PR 40270 open', now: day, dir });
    expect(a.ok && [a.action, a.file]).toEqual(['created', 'proxy-session-2026-11-26.md']);
    const b = syncProxySession({ body: 'CEO asked: proxy lane → PR 40270 Terra r2 running', now: new Date(2026, 10, 26, 23, 40), dir });
    expect(b.ok && b.action).toBe('updated');
    expect(readdirSync(dir).sort()).toEqual(['MEMORY.md', 'proxy-session-2026-11-26.md']);
    const text = readFileSync(join(dir, 'proxy-session-2026-11-26.md'), 'utf8');
    expect(text).toContain('\nsource: CLAUDE-OP\n');
    expect(text).toContain('Terra r2 running');
    expect(text).not.toContain('PR 40270 open');
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('\n').filter((l) => l.includes('proxy-session-2026-11-26')).length).toBe(1);
    expect(listSeatMemories(dir).map((e) => [e.name, e.type, e.source])).toEqual([['proxy-session-2026-11-26', 'project', 'CLAUDE-OP']]);
  });
  test('a plain seat memory carries no source line; a bad source is refused', () => {
    const dir = temp();
    expect(saveSeatMemory({ name: 'n1', description: 'd', type: 'project', body: 'b' }, dir, 'OP').ok).toBe(true);
    expect(readFileSync(join(dir, 'n1.md'), 'utf8')).not.toContain('source:');
    expect(saveSeatMemory({ name: 'n2', description: 'd', type: 'project', body: 'b', source: '../x' }, dir, 'OP').ok).toBe(false);
  });
});

describe('SEAT-MEMORY-SYNC sim (seeds 1–3 · a day of syncs and writes)', () => {
  function rng(seed: number): () => number { let x = seed * 2654435761 >>> 0; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); }
  for (const seed of [1, 2, 3]) {
    test(`seed ${seed}`, () => {
      const r = rng(seed);
      const dir = temp();
      let syncs = 0; let refusedOther = 0; let refusedPath = 0;
      for (let i = 0; i < 30; i++) {
        const roll = r();
        if (roll < 0.5) {
          const res = syncProxySession({ body: `summary ${seed}-${i}`, now: new Date(2026, 10, 26, 8 + Math.floor(i / 3), i % 60), dir });
          expect(res.ok).toBe(true);
          syncs += 1;
        } else if (roll < 0.75) {
          const caller = ['TC', 'UX', 'MK', 'JUD'][Math.floor(r() * 4)]!;
          if (!seatWriteAuthority({ target: 'OP', caller }).ok) refusedOther += 1;
        } else {
          const target = ['../OP', 'OP/../TC', '_common', 'seats/OP'][Math.floor(r() * 4)]!;
          if (!seatWriteAuthority({ target, caller: 'CLAUDE-OP' }).ok) refusedPath += 1;
        }
      }
      // invariants: one file for the day, one index line, newest body wins, every foreign/path write refused
      const files = readdirSync(dir).filter((f) => f !== 'MEMORY.md');
      expect(files.length).toBe(syncs > 0 ? 1 : 0);
      if (syncs > 0) expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('\n').filter((l) => l.includes('proxy-session-2026-11-26')).length).toBe(1);
      expect(refusedOther + refusedPath + syncs).toBe(30);
    });
  }
});

describe('CLI — memory add --seat', () => {
  let prevState: string | undefined; let prevTrack: string | undefined; let state = '';
  beforeAll(() => { prevState = process.env.ELANOUS_STATE_DIR; prevTrack = process.env.ELANOUS_TRACK; state = temp(); process.env.ELANOUS_STATE_DIR = state; });
  afterEach(() => { if (prevTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = prevTrack; });
  afterAll(() => { if (prevState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prevState; });
  test('CLAUDE-OP writes the OP seat store with source front matter', async () => {
    process.env.ELANOUS_TRACK = 'CLAUDE-OP';
    const program = new Command();
    registerMemoryCommands(program);
    await program.parseAsync(['memory', 'add', 'project', 'ceo-ask-1126', 'CEO wants the proxy lane', '--seat', 'OP'], { from: 'user' });
    const dir = seatMemoryDir('OP');
    expect(dir.startsWith(state)).toBe(true);
    expect(existsSync(join(dir, 'ceo-ask-1126.md'))).toBe(true);
    expect(readFileSync(join(dir, 'ceo-ask-1126.md'), 'utf8')).toContain('\nsource: CLAUDE-OP\n');
  });
});

describe('Terra r1 — strict source · strict --from · sync-proxy through the CLI', () => {
  let prevState: string | undefined; let prevTrack: string | undefined; let state = '';
  beforeAll(() => { prevState = process.env.ELANOUS_STATE_DIR; prevTrack = process.env.ELANOUS_TRACK; state = temp(); process.env.ELANOUS_STATE_DIR = state; });
  afterEach(() => { if (prevTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = prevTrack; });
  afterAll(() => { if (prevState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prevState; });
  async function cli(...args: string[]): Promise<{ exit: number | null }> {
    const program = new Command();
    registerMemoryCommands(program);
    const origExit = process.exit;
    let exit: number | null = null;
    (process as { exit: unknown }).exit = (code?: number) => { exit = code ?? 0; throw new Error('exit'); };
    try { await program.parseAsync(['memory', ...args], { from: 'user' }); } catch (error) { if ((error as Error).message !== 'exit') throw error; }
    finally { (process as { exit: unknown }).exit = origExit; }
    return { exit };
  }
  test('a source with a trailing newline is refused', () => {
    expect(saveSeatMemory({ name: 'n3', description: 'd', type: 'project', body: 'b', source: 'OP\n' }, temp(), 'OP').ok).toBe(false);
  });
  test('an invalid explicit --from is refused even when ELANOUS_TRACK is CLAUDE-OP', async () => {
    process.env.ELANOUS_TRACK = 'CLAUDE-OP';
    expect((await cli('add', 'project', 'x1', 'd', '--seat', 'OP', '--from', '../OP')).exit).toBe(1);
    expect((await cli('sync-proxy', '--body', 'summary', '--from', 'CLAUDE-OP/x')).exit).toBe(1);
  });
  test('sync-proxy: --file writes the daily entry; empty, unreadable or a non-proxy caller is refused', async () => {
    const src = join(temp(), 'summary.md');
    writeFileSync(src, 'CEO asked: context bus → PR 4 in progress');
    process.env.ELANOUS_TRACK = 'CLAUDE-OP';
    expect((await cli('sync-proxy', '--file', src)).exit).toBeNull();
    const files = readdirSync(seatMemoryDir('OP')).filter((f) => f.startsWith('proxy-session-'));
    expect(files.length).toBe(1);
    expect(readFileSync(join(seatMemoryDir('OP'), files[0]!), 'utf8')).toContain('context bus → PR 4 in progress');
    expect((await cli('sync-proxy', '--body', '   ')).exit).toBe(1);
    expect((await cli('sync-proxy', '--file', join(state, 'missing.md'))).exit).toBe(1);
    process.env.ELANOUS_TRACK = 'TC';
    expect((await cli('sync-proxy', '--body', 'summary')).exit).toBe(1);
  });
});
