import { describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { listChecklist, devVersion } from '../release-loop/checklist.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { isPrerelease, isReleaseVersion, planPublish, publishRelease, registerReleaseCommands, tagRelease, verifyChecksums, verifyRelease, releaseNotesPageUrl, type ReleaseManifest, type Runner } from './release-cli.js';

function fixture() {
  const out = mkdtempSync(join(tmpdir(), 'release-cli-'));
  const dist = join(out, 'dist');
  mkdirSync(dist);
  const files = ['elanous.tgz', 'install.sh', 'install.ps1'].map((name) => {
    const body = `content of ${name}`;
    writeFileSync(join(dist, name), body);
    return { name, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length };
  });
  writeFileSync(join(dist, 'SHA256SUMS'), files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n');
  const manifest: ReleaseManifest = {
    version: '0.1.1', tag: 'v0.1.1', prerelease: false, publicRepo: 'ElanvitalAI/elanous', sourceRef: 'origin/main',
    sourceCommit: 'a'.repeat(40), publicCommit: 'b'.repeat(40), publicDir: join(out, 'public'), distDir: dist,
    // files = release-build 가 내는 그대로 — SHA256SUMS 는 «목록에 없다»
    files, webUi: true, e2e: { ran: true, ok: true, versionLine: `0.1.1 ${'b'.repeat(40)}` },
    preparedAt: '2026-09-25T00:00:00Z',
  };
  writeFileSync(join(out, 'release.json'), JSON.stringify(manifest));
  const notes = join(out, 'notes.md');
  writeFileSync(notes, 'notes');
  return { out, dist, manifest, notes };
}

describe('release checklist CLI', () => {
  test('add → set → status JSON · actor · 사람 상태 · rm, 기존 help 명령 보존', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-checklist-cli-'));
    setElanousConfigDir(dir);
    const oldTrack = process.env.ELANOUS_TRACK;
    process.env.ELANOUS_TRACK = 'T';
    const lines: string[] = [];
    const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const jsonOutput = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => { lines.push(String(chunk).trim()); (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(); return true; }) as typeof process.stdout.write);
    const run = async (...args: string[]) => { const cmd = new Command(); registerReleaseCommands(cmd); await cmd.parseAsync(['release', 'checklist', ...args], { from: 'user' }); };
    try {
      await run('--version', '9.9.9', 'add', 'K1', '첫 칸');
      await run('--version', '9.9.9', 'set', 'K1', '--status', 'red', '--evidence', '#1');
      await run('--version', '9.9.9', 'status', '--json');
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ version: '9.9.9', red: 1, blocked: ['K1'] });
      expect(listChecklist('9.9.9').history.at(-2)).toMatchObject({ by: 'T', id: 'K1', field: 'evidence', to: '#1', dev: devVersion() });
      expect(listChecklist('9.9.9').history.at(-1)).toMatchObject({ by: 'T', id: 'K1', field: 'status', to: 'red', dev: devVersion() });
      await run('status', '--version', '9.9.9');
      expect(lines.slice(-4).join('\n')).toContain('🔴 칸: K1');
      await run('list', '--version', '9.9.9', '--json');
      expect(JSON.parse(lines.at(-1)!).items).toHaveLength(1);
      await run('rm', 'K1', '--version', '9.9.9');
      expect(listChecklist('9.9.9').items).toHaveLength(0);
      const cmd = new Command(); registerReleaseCommands(cmd);
      const release = cmd.commands.find((c) => c.name() === 'release')!;
      expect(release.commands.map((c) => c.name())).toEqual(['checklist', 'prepare', 'yank', 'publish', 'tag', 'verify', 'notes', 'run']);
      expect(release.commands.find((c) => c.name() === 'prepare')!.helpInformation()).toContain('네트워크 쓰기 없음');
      expect(release.commands.find((c) => c.name() === 'publish')!.helpInformation()).toContain('--notes-file <file>');
      expect(release.commands.find((c) => c.name() === 'verify')!.helpInformation()).toContain('--public-repo <owner/name>');
      expect(release.commands.find((c) => c.name() === 'run')!.helpInformation()).toContain('--if-ready');
    } finally {
      jsonOutput.mockRestore(); output.mockRestore(); resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true });
      if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
    }
  });

  test('판 번호가 다른 판의 별칭과 충돌해도 실제 판 번호를 우선한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-checklist-collision-'));
    setElanousConfigDir(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ release: { codenames: { '0.2.5': '9.9.9', '9.9.9': 'graph' } } }));
    const lines: string[] = [];
    const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const jsonOutput = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => { lines.push(String(chunk).trim()); (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(); return true; }) as typeof process.stdout.write);
    const run = async (...args: string[]) => { const cmd = new Command(); registerReleaseCommands(cmd); await cmd.parseAsync(['release', 'checklist', ...args], { from: 'user' }); };
    try {
      await run('--version', '9.9.9', 'add', 'K1', 'real version');
      await run('status', '--version', '9.9.9', '--json');
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ version: '9.9.9', codename: 'graph', yellow: 1 });
      expect(listChecklist('0.2.5').items).toHaveLength(0);
      await run('status', '--version', 'graph', '--json');
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ version: '9.9.9', yellow: 1 });
    } finally { jsonOutput.mockRestore(); output.mockRestore(); resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('기본 개발판·별칭 조회·씨앗 CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-checklist-alias-'));
    setElanousConfigDir(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ release: { codenames: { '0.2.5': 'graph' } } }));
    const lines: string[] = [];
    const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const jsonOutput = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => { lines.push(String(chunk).trim()); (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(); return true; }) as typeof process.stdout.write);
    const run = async (...args: string[]) => { const cmd = new Command(); registerReleaseCommands(cmd); await cmd.parseAsync(['release', 'checklist', ...args], { from: 'user' }); };
    try {
      await run('seed', '--version', '0.2.5', '--from', join(import.meta.dir, '..', '..', 'docs/ROADMAP-releases-0.2.5-and-0.2.6-2026-09-29.md'));
      await run('status', '--version', 'graph', '--json');
      const result = JSON.parse(lines.at(-1)!);
      expect(result).toMatchObject({ version: '0.2.5', codename: 'graph', dev: devVersion() });
      expect(result.items.length).toBeGreaterThan(12);
      expect(result.history[0].dev).toBe(devVersion());
      await run('status', '--version', 'graph');
      expect(lines.at(-4)).toContain('0.2.5 (graph)');
    } finally { jsonOutput.mockRestore(); output.mockRestore(); resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('release run CLI', () => {
  test('--dry-run --json prints the complete ledger/config input on stdout without invoking the checklist or graph', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-run-cli-'));
    const ledger = join(dir, 'ledger');
    mkdirSync(join(ledger, 'release', '0.2.3'), { recursive: true });
    writeFileSync(join(ledger, 'release', '0.2.3', 'release.json'), JSON.stringify({ version: '0.2.3', publishedAt: 'now' }));
    const loop = { gatePodPool: 'gate-pool', gatePodShards: 4, gatePodShardTimeoutSeconds: 240,
      gateRemote: 'node-b', gateRemoteMirror: '/mirror/repo.git', opsHosts: ['local', 'node-b'], internalDist: '~/dist', opsRestart: true };
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ release: { loop } }));
    let checklistCalls = 0;
    let graphCalls = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write);
    const error = spyOn(console, 'error').mockImplementation((line: string) => { stderr.push(line); });
    const before = process.exitCode;
    try {
      const cli = new Command();
      registerReleaseCommands(cli, { ledgerRoot: ledger, configPath,
        checklist: () => { checklistCalls++; throw new Error('dry-run invoked checklist'); },
        graph: async () => { graphCalls++; throw new Error('dry-run invoked graph'); } });
      await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--dry-run', '--json'], { from: 'user' });
      expect(stdout).toHaveLength(1);
      expect(stdout[0]!.endsWith('\n')).toBe(true);
      expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, dryRun: true, input: { ...loop, version: '0.2.4', previousVersion: '0.2.3' } });
      expect(stderr.join('\n')).toContain('"previousVersion":"0.2.3"');
      expect([checklistCalls, graphCalls]).toEqual([0, 0]);
      expect(process.exitCode ?? 0).toBe(0);
    } finally { process.exitCode = before ?? 0; write.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('--dry-run --if-ready preserves the input preview without checking readiness, running the graph or writing a lock', async () => {
    for (const blocked of [true, false]) {
      const dir = mkdtempSync(join(tmpdir(), 'release-run-preview-'));
      const ledger = join(dir, 'ledger');
      mkdirSync(join(ledger, 'release', '0.2.3'), { recursive: true });
      writeFileSync(join(ledger, 'release', '0.2.3', 'release.json'), JSON.stringify({ version: '0.2.3', publishedAt: 'now' }));
      const target = join(ledger, 'release', '0.2.4');
      const stdout: string[] = [];
      const human: string[] = [];
      const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => { stdout.push(String(chunk)); (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(); return true; }) as typeof process.stdout.write);
      const output = spyOn(console, 'log').mockImplementation((line: string) => { human.push(line); });
      const before = process.exitCode;
      let checklistCalls = 0;
      let graphCalls = 0;
      try {
        process.exitCode = 0;
        const cli = new Command();
        registerReleaseCommands(cli, { ledgerRoot: ledger, config: { gatePodPool: 'preview-pool' },
          checklist: () => { checklistCalls++; return { ok: !blocked, red: blocked ? ['K13'] : [], undecided: [], blocked: [], moved: [], knownIssues: [] }; },
          graph: async () => { graphCalls++; throw new Error('preview invoked graph'); } });
        await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--dry-run', '--if-ready', '--json'], { from: 'user' });
        expect(stdout).toHaveLength(1);
        expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, dryRun: true, input: { version: '0.2.4', previousVersion: '0.2.3', gatePodPool: 'preview-pool' } });
        expect([checklistCalls, graphCalls]).toEqual([0, 0]);
        expect(existsSync(target)).toBe(false);
        expect(process.exitCode).toBe(0);
        await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--dry-run', '--if-ready'], { from: 'user' });
        expect(human).toHaveLength(1);
        expect(human[0]).toStartWith('· 드라이런 0.2.4 · 입력 ');
        expect(JSON.parse(human[0]!.split(' · 입력 ')[1]!)).toEqual({ version: '0.2.4', previousVersion: '0.2.3', gatePodPool: 'preview-pool' });
        expect([checklistCalls, graphCalls]).toEqual([0, 0]);
        expect(existsSync(target)).toBe(false);
        expect(process.exitCode).toBe(0);
      } finally { process.exitCode = before ?? 0; write.mockRestore(); output.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('--dry-run human output includes every graph input field without running the graph', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-run-cli-'));
    mkdirSync(join(dir, 'release', '0.2.3'), { recursive: true });
    writeFileSync(join(dir, 'release', '0.2.3', 'release.json'), JSON.stringify({ version: '0.2.3', publishedAt: 'now' }));
    const lines: string[] = [];
    const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const before = process.exitCode;
    try {
      const cli = new Command();
      registerReleaseCommands(cli, { ledgerRoot: dir, config: { gatePodPool: 'pool', gateRemote: 'node-b' },
        graph: async () => { throw new Error('dry-run invoked graph'); } });
      await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--dry-run'], { from: 'user' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('드라이런');
      expect(JSON.parse(lines[0]!.split(' · 입력 ')[1]!)).toEqual({ version: '0.2.4', previousVersion: '0.2.3', gatePodPool: 'pool', gateRemote: 'node-b' });
      expect(process.exitCode ?? 0).toBe(0);
    } finally { process.exitCode = before ?? 0; output.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('--if-ready skips a blocked checklist with exit 0 and one JSON line; plain run remains exit 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-run-if-ready-cli-'));
    mkdirSync(join(dir, 'release', '0.2.3'), { recursive: true });
    writeFileSync(join(dir, 'release', '0.2.3', 'release.json'), JSON.stringify({ version: '0.2.3', publishedAt: 'now' }));
    const stdout: string[] = [];
    const human: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: (error?: Error | null) => void) => { stdout.push(String(chunk)); callback?.(); return true; }) as typeof process.stdout.write);
    const output = spyOn(console, 'log').mockImplementation((line: string) => { human.push(line); });
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const before = process.exitCode;
    let graphCalls = 0;
    const args = { ledgerRoot: dir, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: false, red: ['K13'], undecided: ['K14'], blocked: ['K15'], moved: [], knownIssues: [] }),
      graph: async () => { graphCalls++; throw new Error('blocked release invoked graph'); } };
    const cli = new Command(); registerReleaseCommands(cli, args);
    try {
      process.exitCode = 0;
      await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--if-ready', '--json'], { from: 'user' });
      expect(stdout).toEqual([`${JSON.stringify({ skipped: true, reason: 'checklist-blocked', detail: 'K13, K14, K15' })}\n`]);
      expect(graphCalls).toBe(0);
      expect(process.exitCode).toBe(0);
      await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--if-ready'], { from: 'user' });
      expect(human).toEqual(['· 준비 안 됨 0.2.4 · checklist-blocked · K13, K14, K15']);
      expect(process.exitCode).toBe(0);
      await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--json'], { from: 'user' });
      expect(JSON.parse(stdout[1]!)).toMatchObject({ ok: false, error: expect.stringContaining('K13') });
      expect(graphCalls).toBe(0);
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = before ?? 0; write.mockRestore(); output.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('--if-ready honors publishedAt and holds a lock while the real graph runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-run-if-ready-cli-'));
    mkdirSync(join(dir, 'release', '0.2.3'), { recursive: true });
    writeFileSync(join(dir, 'release', '0.2.3', 'release.json'), JSON.stringify({ version: '0.2.3', publishedAt: 'now' }));
    const target = join(dir, 'release', '0.2.4');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'release.json'), JSON.stringify({ version: '0.2.4', publishedAt: 'published now' }));
    const stdout: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: (error?: Error | null) => void) => { stdout.push(String(chunk)); callback?.(); return true; }) as typeof process.stdout.write);
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const before = process.exitCode;
    let graphCalls = 0;
    const cli = new Command(); registerReleaseCommands(cli, { ledgerRoot: dir, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async () => { graphCalls++; expect(JSON.parse(readFileSync(join(target, 'run.lock'), 'utf8')).pid).toBe(process.pid); return { status: 'done' } as never; } });
    try {
      process.exitCode = 0;
      await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--if-ready', '--json'], { from: 'user' });
      expect(JSON.parse(stdout[0]!)).toEqual({ skipped: true, reason: 'already-published', detail: 'published now' });
      expect(graphCalls).toBe(0);
      rmSync(join(target, 'release.json'));
      await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--if-ready', '--json'], { from: 'user' });
      expect(JSON.parse(stdout[1]!)).toMatchObject({ ok: true, state: { status: 'done' } });
      expect(graphCalls).toBe(1);
      expect(existsSync(join(target, 'run.lock'))).toBe(false);
      expect(process.exitCode).toBe(0);
    } finally { process.exitCode = before ?? 0; write.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('--if-ready graph error keeps exit 1 and removes the lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-run-if-ready-cli-'));
    mkdirSync(join(dir, 'release', '0.2.3'), { recursive: true });
    writeFileSync(join(dir, 'release', '0.2.3', 'release.json'), JSON.stringify({ version: '0.2.3', publishedAt: 'now' }));
    const stdout: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: (error?: Error | null) => void) => { stdout.push(String(chunk)); callback?.(); return true; }) as typeof process.stdout.write);
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const before = process.exitCode;
    const lock = join(dir, 'release', '0.2.4', 'run.lock');
    const cli = new Command(); registerReleaseCommands(cli, { ledgerRoot: dir, config: { gatePodPool: 'pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
      graph: async () => { expect(existsSync(lock)).toBe(true); throw new Error('graph failed'); } });
    try {
      process.exitCode = 0;
      await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--if-ready', '--json'], { from: 'user' });
      expect(stdout).toEqual([`${JSON.stringify({ ok: false, error: 'graph failed' })}\n`]);
      expect(existsSync(lock)).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = before ?? 0; write.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('run executes the runner, reports graph status, and keeps blocked releases fail-closed in JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-run-cli-'));
    mkdirSync(join(dir, 'release', '0.2.3'), { recursive: true });
    writeFileSync(join(dir, 'release', '0.2.3', 'release.json'), JSON.stringify({ version: '0.2.3', publishedAt: 'now' }));
    const stdout: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write);
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const before = process.exitCode;
    let checklistCalls = 0;
    let graphCalls = 0;
    const cli = new Command();
    registerReleaseCommands(cli, { ledgerRoot: dir, config: { gatePodPool: 'pool' },
      checklist: (version) => { expect(version).toBe('0.2.4'); checklistCalls++; return { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }; },
      graph: async (path, opts) => { expect(path).toEndWith('graphs/release/release-loop.yaml'); expect(opts.input.previousVersion).toBe('0.2.3'); graphCalls++; return { status: 'awaiting-approval', runId: 'run-1' } as never; } });
    try {
      await cli.parseAsync(['release', 'run', '--version', '0.2.4', '--json'], { from: 'user' });
      expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, dryRun: false, input: { version: '0.2.4', previousVersion: '0.2.3', gatePodPool: 'pool' }, state: { status: 'awaiting-approval', runId: 'run-1' } });
      expect([checklistCalls, graphCalls]).toEqual([1, 1]);
      expect(process.exitCode ?? 0).toBe(0);
      const blocked = new Command();
      registerReleaseCommands(blocked, { ledgerRoot: dir, config: { gatePodPool: 'pool' },
        checklist: () => ({ ok: false, red: ['K13'], undecided: [], blocked: [], moved: [], knownIssues: [] }),
        graph: async () => { graphCalls++; throw new Error('blocked release invoked graph'); } });
      await blocked.parseAsync(['release', 'run', '--version', '0.2.4', '--json'], { from: 'user' });
      expect(JSON.parse(stdout[1]!)).toMatchObject({ ok: false, error: expect.stringContaining('K13') });
      expect(graphCalls).toBe(1);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      const failed = new Command();
      registerReleaseCommands(failed, { ledgerRoot: dir, config: { gatePodPool: 'pool' },
        checklist: () => ({ ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] }),
        graph: async () => ({ status: 'failed' }) as never });
      await failed.parseAsync(['release', 'run', '--version', '0.2.4', '--json'], { from: 'user' });
      expect(JSON.parse(stdout[2]!)).toMatchObject({ ok: false, state: { status: 'failed' } });
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = before ?? 0; write.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('release — 버전·자산', () => {
  test('버전 모양: x.y.z 와 -rc/-alpha/-beta.N 만 · 접두 v 는 아니다', () => {
    expect(['0.1.0', '0.2.0-rc.1', '1.0.0-beta.2'].every(isReleaseVersion)).toBe(true);
    expect(['v0.1.0', '0.1', '0.1.0-dev', ''].some(isReleaseVersion)).toBe(false);
    expect(isPrerelease('0.2.0-rc.1')).toBe(true);
    expect(isPrerelease('0.2.0')).toBe(false);
  });

  test('체크섬 재대조가 바뀐 파일의 «이름»을 댄다', () => {
    const f = fixture();
    try {
      expect(verifyChecksums(f.dist)).toEqual([]);
      writeFileSync(join(f.dist, 'install.sh'), 'tampered');
      expect(verifyChecksums(f.dist)).toEqual(['install.sh']);
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });
});

function tagRunner(calls: string[], opts: { releaseFails?: boolean; tagPushFails?: boolean; local?: string; remote?: string } = {}): Runner {
  return (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    const success = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (command === 'gh' && args[1] === 'view') return { status: 1, stdout: '', stderr: '' };
    if (command === 'gh' && args[1] === 'create' && opts.releaseFails) return { status: 1, stdout: '', stderr: 'release failed' };
    if (command === 'git' && args[0] === 'push' && args[2]?.startsWith('refs/tags/') && opts.tagPushFails) return { status: 1, stdout: '', stderr: 'tag push failed' };
    // 실제 git 처럼: 없는 ref 는 `--quiet` 이면 1, 아니면 128
    if (command === 'git' && args[0] === 'show-ref') return opts.local ? success(opts.local) : { status: args.includes('--quiet') ? 1 : 128, stdout: '', stderr: args.includes('--quiet') ? '' : `fatal: '${args[args.length - 1]}' - not a valid ref` };
    if (command === 'git' && args[0] === 'ls-remote') return success(opts.remote ? `${opts.remote}\trefs/tags/v0.1.1^{}\n` : '');
    if (command === 'git' && args[0] === 'rev-parse') return success(args[2]?.startsWith('refs/tags/') ? opts.local : 'a'.repeat(40));
    return success();
  };
}

describe('release publish — 되돌릴 수 없으니 기본은 «보기만»', () => {
  test('계획: 공개 커밋 푸시 → 태그 릴리스(자산 전부 · 공개 커밋을 target · prerelease 면 표시)', () => {
    const f = fixture();
    try {
      const steps = planPublish(f.manifest, f.notes);
      expect(steps.map((s) => s.command)).toEqual(['git', 'gh']);
      expect(steps[0]!.args).toEqual(['push', 'origin', 'HEAD:main']);
      expect(steps[1]!.args).toContain('--target');
      expect(steps[1]!.args[steps[1]!.args.indexOf('--target') + 1]).toBe('b'.repeat(40));
      expect(steps[1]!.args).not.toContain('--prerelease');
      expect(planPublish({ ...f.manifest, prerelease: true }, f.notes)[1]!.args).toContain('--prerelease');
      // ⛔ 설치기가 읽는 SHA256SUMS 를 반드시 올린다(release-build 의 files 에는 없다)
      expect(steps[1]!.args).toContain(join(f.dist, 'SHA256SUMS'));
      expect(steps[1]!.args.filter((a) => a.startsWith(f.dist))).toHaveLength(4);
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });

  test('--yes 없으면 아무것도 실행하지 않는다 · 이미 있는 태그는 거부 · 자산이 바뀌었으면 거부', async () => {
    const f = fixture();
    const calls: string[] = [];
    const noRelease: Runner = (c, a) => { calls.push(`${c} ${a[0]} ${a[1]}`); return { status: c === 'gh' && a[1] === 'view' ? 1 : 0, stdout: '', stderr: '' }; };
    try {
      const dry = await publishRelease({ dir: f.out, notesFile: f.notes, instanceRoot: f.out, ledgerRoot: f.out, log: () => {} }, noRelease);
      expect(dry.published).toBe(false);
      expect(calls).toEqual(['gh release view']);
      const exists: Runner = () => ({ status: 0, stdout: '', stderr: '' });
      await expect(publishRelease({ dir: f.out, notesFile: f.notes, yes: true, instanceRoot: f.out, ledgerRoot: f.out, log: () => {} }, exists)).rejects.toThrow('이미 있는 릴리스');
      writeFileSync(join(f.dist, 'elanous.tgz'), 'changed');
      await expect(publishRelease({ dir: f.out, notesFile: f.notes, yes: true, instanceRoot: f.out, ledgerRoot: f.out, log: () => {} }, noRelease)).rejects.toThrow('elanous.tgz');
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });

  test('--yes 면 공개 성공 뒤 원본 주석 태그를 push 하고 인스턴스에 0600 판 기록을 남긴다', async () => {
    const f = fixture();
    const calls: string[] = [];
    const observations: Array<{ category: string; event: string; data: unknown }> = [];
    const observation = spyOn(debug, 'log').mockImplementation((category, event, data) => { observations.push({ category, event, data }); });
    // The machine release ledger is real state (the next gate reads it) — a test must never write there.
    const realRecord = join(releaseLedgerRoot(), 'release', '0.1.1', 'release.json');
    const realBefore = existsSync(realRecord) ? statSync(realRecord).mtimeMs : null;
    try {
      const r = await publishRelease({ dir: f.out, notesFile: f.notes, yes: true, repoRoot: f.out, instanceRoot: f.out, ledgerRoot: f.out, log: () => {} }, tagRunner(calls));
      expect(r.published).toBe(true);
      expect(existsSync(realRecord) ? statSync(realRecord).mtimeMs : null).toBe(realBefore);
      const published = calls.findIndex((c) => c.startsWith('gh release create'));
      const tagged = calls.findIndex((c) => c.startsWith('git tag -a v0.1.1 '));
      expect(published).toBeGreaterThan(calls.findIndex((c) => c === 'git push origin HEAD:main'));
      expect(tagged).toBeGreaterThan(published);
      expect(calls[tagged]).toBe(`git tag -a v0.1.1 ${'a'.repeat(40)} -m elanous v0.1.1`);
      expect(calls).toContain('git push origin refs/tags/v0.1.1:refs/tags/v0.1.1');
      const path = join(f.out, 'release', '0.1.1', 'release.json');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ ...f.manifest, publishedAt: expect.any(String) });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(observations).toContainEqual({ category: 'release.publish', event: 'tagged', data: { version: '0.1.1', commit: 'a'.repeat(40) } });
    } finally { observation.mockRestore(); rmSync(f.out, { recursive: true, force: true }); }
  });

  test('공개 릴리스 실패면 내부 태그와 판 기록은 없다', async () => {
    const f = fixture();
    const calls: string[] = [];
    try {
      await expect(publishRelease({ dir: f.out, notesFile: f.notes, yes: true, repoRoot: f.out, instanceRoot: f.out, ledgerRoot: f.out, log: () => {} }, tagRunner(calls, { releaseFails: true }))).rejects.toThrow('release failed');
      expect(calls.filter((c) => c.startsWith('git tag ') || c.startsWith('git push origin refs/tags/'))).toHaveLength(0);
      expect(() => readFileSync(join(f.out, 'release', '0.1.1', 'release.json'))).toThrow();
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });

  test('내부 태그 push 실패면 판 기록을 남기지 않는다', async () => {
    const f = fixture();
    const calls: string[] = [];
    try {
      await expect(publishRelease({ dir: f.out, notesFile: f.notes, yes: true, repoRoot: f.out, instanceRoot: f.out, ledgerRoot: f.out, log: () => {} }, tagRunner(calls, { tagPushFails: true }))).rejects.toThrow('tag push failed');
      expect(calls.some((c) => c.startsWith('git tag -a v0.1.1 '))).toBe(true);
      expect(() => readFileSync(join(f.out, 'release', '0.1.1', 'release.json'))).toThrow();
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });

  test('로컬 또는 origin 태그가 다른 원본이면 공개·태그 변경 전에 거부한다', async () => {
    const f = fixture();
    try {
      for (const conflict of [{ local: 'b'.repeat(40) }, { remote: 'b'.repeat(40) }]) {
        const calls: string[] = [];
        await expect(publishRelease({ dir: f.out, notesFile: f.notes, yes: true, repoRoot: f.out, instanceRoot: f.out, ledgerRoot: f.out, log: () => {} }, tagRunner(calls, conflict))).rejects.toThrow('태그 충돌');
        expect(calls.filter((c) => c.startsWith('git tag ') || c.startsWith('git push ') || c.startsWith('gh release create'))).toHaveLength(0);
      }
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });

  test('같은 원본이면 태그 생성·push 는 각각 멱등이다', async () => {
    const f = fixture();
    try {
      const calls: string[] = [];
      await tagRelease({ version: '0.1.1', source: 'a'.repeat(40), repoRoot: f.out, yes: true, log: () => {} }, tagRunner(calls, { local: 'a'.repeat(40), remote: 'a'.repeat(40) }));
      expect(calls.filter((c) => c.startsWith('git tag ') || c.startsWith('git push '))).toHaveLength(0);
      const missingRemote: string[] = [];
      await tagRelease({ version: '0.1.1', source: 'a'.repeat(40), repoRoot: f.out, yes: true, log: () => {} }, tagRunner(missingRemote, { local: 'a'.repeat(40) }));
      expect(missingRemote.filter((c) => c.startsWith('git tag '))).toHaveLength(0);
      expect(missingRemote).toContain('git push origin refs/tags/v0.1.1:refs/tags/v0.1.1');
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });

  test('release tag CLI: --yes 없는 소급 판은 한 줄 계획 · exit 0 · 태그 미생성', async () => {
    const cli = new Command();
    registerReleaseCommands(cli);
    const lines: string[] = [];
    const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    try {
      await cli.parseAsync(['release', 'tag', '--version', '0.2.2', '--source', '0a3902fb104f8d0501811a5402d1455b7d0e1a77'], { from: 'user' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('v0.2.2 → 0a3902fb104f8d0501811a5402d1455b7d0e1a77');
      expect(process.exitCode ?? 0).toBe(0);
    } finally { output.mockRestore(); }
  });

  test('release tag --yes 없으면 계획만 · 버전/커밋 유효성 검사', async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    expect(await tagRelease({ version: '0.2.2', source: '0a3902fb104f8d0501811a5402d1455b7d0e1a77', log: (line) => lines.push(line) }, tagRunner(calls))).toEqual({ tagged: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('v0.2.2 → 0a3902fb104f8d0501811a5402d1455b7d0e1a77');
    expect(calls).toHaveLength(0);
    await expect(tagRelease({ version: 'v0.2.2', source: 'a'.repeat(40) }, tagRunner(calls))).rejects.toThrow('버전 모양');
    await expect(tagRelease({ version: '0.2.2', source: 'HEAD' }, tagRunner(calls))).rejects.toThrow('커밋 SHA');
  });
});

// 상태 왕복 가짜 — memory add 로 받은 nonce 를 search 가 돌려주고, logs 는 «지금» 쓰인 행을 낸다.
let lastNonce = '';
function stateOk(a: readonly string[]): { status: number; stdout: string; stderr: string } {
  if (a[0] === 'memory' && a[1] === 'add') { lastNonce = String(a[3]).replace('release-verify-', ''); return { status: 0, stdout: 'saved', stderr: '' }; }
  if (a[0] === 'memory' && a[1] === 'search') return { status: 0, stdout: `match release-verify-${lastNonce}`, stderr: '' };
  if (a[0] === 'logs') return { status: 0, stdout: `{"_meta":{}}\n{"id":2,"ts_ms":${Date.now()}}\n`, stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
}

// 노트 페이지 확인 curl(-w %{http_code}) 가짜 — 기본 200.
const notesCurl = (a: readonly string[], code = '200') => (a.includes('-w') ? { status: 0, stdout: code, stderr: '' } : null);

describe('release verify — 공개 주소로 끝까지', () => {
  test('고정 버전이면 download/v<버전> 설치기를 받고, --version 이 그 버전으로 시작해야 ok', async () => {
    const urls: string[] = [];
    const run: Runner = (c, a) => {
      if (c === 'curl') { const n = notesCurl(a); if (n) return n; urls.push(String(a[1])); return { status: 0, stdout: 'echo installer', stderr: '' }; }
      if (a[0] === '--version') return { status: 0, stdout: '0.1.1 cafe\n', stderr: '' };
      return stateOk(a);
    };
    const r = await verifyRelease({ version: '0.1.1', log: () => {} }, run);
    expect(urls).toEqual(['https://github.com/ElanvitalAI/elanous/releases/download/v0.1.1/install.sh']);
    expect(r.ok).toBe(true);
    const wrong: Runner = (c, a) => (c === 'curl' && notesCurl(a) ? notesCurl(a)! : a[0] === '--version' ? { status: 0, stdout: '0.1.0 cafe', stderr: '' } : stateOk(a));
    expect((await verifyRelease({ version: '0.1.1', log: () => {} }, wrong)).ok).toBe(false);
  });

  test('검증 환경은 물려받은 ELANOUS_*·XDG_* 를 걷는다 — 상태 왕복이 운영 저장소에 쓰지 않게', async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const saved = { s: process.env.ELANOUS_STATE_DIR, x: process.env.XDG_DATA_HOME };
    process.env.ELANOUS_STATE_DIR = '/real/state'; process.env.XDG_DATA_HOME = '/real/xdg';
    try {
      const run: Runner = (c, a, cwd, o) => { if (o?.env) seen.push(o.env); return c === 'curl' ? (notesCurl(a) ?? { status: 0, stdout: 'x', stderr: '' }) : a[0] === '--version' ? { status: 0, stdout: '0.1.1 c', stderr: '' } : stateOk(a); };
      await verifyRelease({ version: '0.1.1', log: () => {} }, run);
    } finally {
      if (saved.s === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved.s;
      if (saved.x === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved.x;
    }
    expect(seen.length).toBeGreaterThan(3);
    for (const env of seen) { expect(env.ELANOUS_STATE_DIR).toBeUndefined(); expect(env.XDG_DATA_HOME).toBeUndefined(); expect(env.HOME).toContain('elanous-release-verify-'); }
  });

  test('--version 이 맞아도 상태 왕복(기억 · 로그)이 안 되면 ok 가 아니다', async () => {
    const base: Runner = (c, a) => (c === 'curl' ? (notesCurl(a) ?? { status: 0, stdout: 'echo installer', stderr: '' }) : a[0] === '--version' ? { status: 0, stdout: '0.1.1 cafe\n', stderr: '' } : stateOk(a));
    const noMemory: Runner = (c, a, cwd, o) => (a[0] === 'memory' && a[1] === 'search' ? { status: 0, stdout: 'no matches', stderr: '' } : base(c, a, cwd, o));
    const oldLogs: Runner = (c, a, cwd, o) => (a[0] === 'logs' ? { status: 0, stdout: '{"id":1,"ts_ms":1}\n', stderr: '' } : base(c, a, cwd, o));
    expect((await verifyRelease({ version: '0.1.1', log: () => {} }, base)).ok).toBe(true);
    expect((await verifyRelease({ version: '0.1.1', log: () => {} }, noMemory)).ok).toBe(false);
    expect((await verifyRelease({ version: '0.1.1', log: () => {} }, oldLogs)).ok).toBe(false);
    // 빈 HOME — 데몬이 한 번도 안 떠 로그 스토어가 없다(📏 09-25 이 맥 실측). 실패도 통과도 아니고 «안 쟀다»고 말한다.
    const lines: string[] = [];
    const noStore: Runner = (c, a, cwd, o) => (a[0] === 'logs' ? { status: 1, stdout: '', stderr: 'elanous logs: 열 수 있는 로그 스토어 없음 — scope={"registeredStores":0,"unopenedStores":0}' } : base(c, a, cwd, o));
    expect((await verifyRelease({ version: '0.1.1', log: (l) => lines.push(l) }, noStore)).ok).toBe(true);
    expect(lines.join('\n')).toContain('로그 왕복 안 잼');
  });
});

import { planYank, yankRelease, type ReleaseInfo } from './release-cli.js';
describe('release yank — 내리기(지우지 않음 · 되돌릴 수 있음)', () => {
  const rel: ReleaseInfo[] = [
    { tagName: 'v0.1.1', isPrerelease: false, isDraft: false, isLatest: true, publishedAt: '2026-09-25T21:05:00Z' },
    { tagName: 'v0.1.0', isPrerelease: false, isDraft: false, isLatest: false, publishedAt: '2026-09-25T11:30:00Z' },
    { tagName: 'v0.2.0-rc.1', isPrerelease: true, isDraft: false, isLatest: false, publishedAt: '2026-09-26T00:00:00Z' },
  ];
  test('내리기 = 대상 강등 ⊕ 직전 «정식» 판(미리보기 제외)을 Latest 로', () => {
    const steps = planYank(rel, 'v0.1.1', 'o/r');
    expect(steps.map((s) => s.args.slice(0, 3).join(' '))).toEqual(['release edit v0.1.1', 'release edit v0.1.0']);
    expect(steps[0]!.args).toContain('--prerelease');
    expect(steps[0]!.args).toContain('--latest=false');
    expect(steps[1]!.args).toContain('--latest');
  });
  test('정식 판이 하나뿐이면 내리지 않는다(Latest 가 비면 한 줄 설치가 전부 실패) · 없는 판·이미 강등된 판은 이름을 댄다', () => {
    expect(() => planYank([rel[0]!], 'v0.1.1', 'o/r')).toThrow('정식 판이 없다');
    expect(() => planYank(rel, 'v9.9.9', 'o/r')).toThrow('없는 릴리스');
    expect(() => planYank(rel, 'v0.2.0-rc.1', 'o/r')).toThrow('이미 pre-release');
  });
  test('--undo = 정식 판 ⊕ Latest ⊕ 제목 원래대로', () => {
    const [s] = planYank(rel, 'v0.1.1', 'o/r', true);
    expect(s!.args).toEqual(['release', 'edit', 'v0.1.1', '--repo', 'o/r', '--prerelease=false', '--latest', '--title', 'elanous v0.1.1']);
  });
  test('--yes 없으면 바꾸지 않는다 · --yes 면 실행 뒤 latest 설치기가 가리키는 판을 잰다', async () => {
    const calls: string[] = [];
    const run: Runner = (c, a) => {
      calls.push(`${c} ${a.slice(0, 3).join(' ')}`);
      if (c === 'gh' && a[1] === 'list') return { status: 0, stdout: JSON.stringify(rel), stderr: '' };
      if (c === 'curl') return { status: 0, stdout: 'HTTP/2 302\nlocation: https://github.com/o/r/releases/download/v0.1.0/install.sh\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    expect((await yankRelease({ version: '0.1.1', publicRepo: 'o/r', log: () => {} }, run)).applied).toBe(false);
    expect(calls.filter((c) => c.startsWith('gh release edit'))).toHaveLength(0);
    const r = await yankRelease({ version: '0.1.1', publicRepo: 'o/r', yes: true, log: () => {}, sleep: async () => {} }, run);
    expect(r).toMatchObject({ applied: true, latestNow: 'v0.1.0', propagated: true, waitedMs: 0 });
    expect(calls.filter((c) => c.startsWith('gh release edit'))).toHaveLength(2);
  });
});

describe('release yank — 설치기 리다이렉트 반영을 기다린다(📏 CDN 약 100~120초)', () => {
  const rel: ReleaseInfo[] = [
    { tagName: 'v0.1.1', isPrerelease: false, isDraft: false, isLatest: true, publishedAt: '2026-09-25T21:05:00Z' },
    { tagName: 'v0.1.0', isPrerelease: false, isDraft: false, isLatest: false, publishedAt: '2026-09-25T11:30:00Z' },
  ];
  const runWith = (redirects: string[]): Runner => (c, a) => {
    if (c === 'gh' && a[1] === 'list') return { status: 0, stdout: JSON.stringify(rel), stderr: '' };
    if (c === 'curl') return { status: 0, stdout: `location: https://github.com/o/r/releases/download/${redirects.shift() ?? 'v0.1.1'}/install.sh`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  test('옛 판을 주는 동안 기다렸다가, 바뀌면 걸린 시간과 함께 반영됐다고 말한다', async () => {
    const r = await yankRelease({ version: '0.1.1', publicRepo: 'o/r', yes: true, log: () => {}, sleep: async () => {}, pollMs: 10_000 }, runWith(['v0.1.1', 'v0.1.1', 'v0.1.0']));
    expect(r).toMatchObject({ propagated: true, latestNow: 'v0.1.0', waitedMs: 20_000 });
  });
  test('끝내 안 바뀌면 ✅ 가 아니다 — propagated false · rc 2', async () => {
    const lines: string[] = [];
    const before = process.exitCode;
    const r = await yankRelease({ version: '0.1.1', publicRepo: 'o/r', yes: true, log: (l) => lines.push(l), sleep: async () => {}, pollMs: 10_000, timeoutMs: 30_000 }, runWith([]));
    expect(r.propagated).toBe(false);
    expect(lines.join('\n')).toContain('아직 v0.1.1 을 준다');
    expect(process.exitCode).toBe(2);
    process.exitCode = before ?? 0;
  });
});

describe('release --json — stdout 은 결과 한 줄(T-R 그래프 간선용)', () => {
  test('yank --json 보기만: stdout 이 JSON 한 줄 · ok true · applied false', () => {
    const r = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'release', 'yank', '--version', '9.9.9', '--json', '--public-repo', 'nobody-xyz/none'], { cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe' });
    const lines = r.stdout.toString().trim().split('\n');
    expect(lines).toHaveLength(1);
    const d = JSON.parse(lines[0]!);
    expect(d.ok).toBe(false);   // 없는 저장소 → 오류도 JSON 한 줄
    expect(typeof d.error).toBe('string');
    expect(r.exitCode).toBe(1);
  }, 60_000);
});

describe('release verify — 노트 페이지가 문서 사이트에 있나(🅕 09-27 · 0.2.2 노트 누락)', () => {
  test('정식 판은 docs 노트 페이지가 200 이어야 ok · 없으면 경로를 말한다 · 선행 판은 안 잰다', async () => {
    const pages: string[] = [];
    const mk = (code: string): Runner => (c, a) => {
      if (c === 'curl' && a.includes('-w')) { pages.push(String(a[a.length - 1])); return { status: 0, stdout: code, stderr: '' }; }
      if (c === 'curl') return { status: 0, stdout: 'echo installer', stderr: '' };
      return a[0] === '--version' ? { status: 0, stdout: '0.2.2 cafe\n', stderr: '' } : stateOk(a);
    };
    const ok = await verifyRelease({ version: '0.2.2', log: () => {} }, mk('200'));
    expect(ok.ok).toBe(true);
    expect(ok.notesPage).toBe('ok');
    expect(pages).toEqual(['https://docs.elanous.ai/releases/0-2-2/']);
    const lines: string[] = [];
    const missing = await verifyRelease({ version: '0.2.2', log: (l) => lines.push(l) }, mk('404'));
    expect(missing.ok).toBe(false);
    expect(missing.notesPage).toBe('missing');
    expect(lines.join('\n')).toContain('release/public/docs/releases/0.2.2.md');
    expect(releaseNotesPageUrl('0.3.0-rc.1')).toBeNull();
  });

  test('publish persists identical 0600 release metadata in the machine ledger and worktree universe', async () => {
    const f = fixture();
    const ledgerRoot = join(f.out, 'machine-ledger');
    const instanceRoot = join(f.out, 'worktree-universe');
    try {
      expect((await publishRelease({ dir: f.out, notesFile: f.notes, yes: true, repoRoot: f.out, instanceRoot, ledgerRoot, log: () => {} }, tagRunner([]))).published).toBe(true);
      const paths = [ledgerRoot, instanceRoot].map((root) => join(root, 'release/0.1.1/release.json'));
      expect(readFileSync(paths[0]!, 'utf8')).toBe(readFileSync(paths[1]!, 'utf8'));
      for (const path of paths) {
        expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ sourceCommit: f.manifest.sourceCommit, publishedAt: expect.any(String) });
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });

  test('explicit config directory prevents publish from writing to another ledger universe', async () => {
    const f = fixture();
    const instanceRoot = join(f.out, 'explicit-universe');
    const other = join(f.out, 'outside-ledger');
    setElanousConfigDir(instanceRoot);
    try {
      expect((await publishRelease({ dir: f.out, notesFile: f.notes, yes: true, repoRoot: f.out, instanceRoot, ledgerRoot: other, log: () => {} }, tagRunner([]))).published).toBe(true);
      expect(existsSync(join(instanceRoot, 'release/0.1.1/release.json'))).toBe(true);
      expect(existsSync(join(other, 'release/0.1.1/release.json'))).toBe(false);
      await publishRelease({ dir: f.out, notesFile: f.notes, yes: true, repoRoot: f.out, instanceRoot: other, ledgerRoot: other, log: () => {} }, tagRunner([]));
      expect(existsSync(join(other, 'release/0.1.1/release.json'))).toBe(false);
    } finally { resetElanousConfigDir(); rmSync(f.out, { recursive: true, force: true }); }
  });

});

// 09-30: 이 파일의 publish 시험이 ledgerRoot 를 안 넘겨 `releaseLedgerRoot()` = 본집 `~/.elanous` 에 가짜 0.1.1 release.json 을 썼다
// (진짜 v0.1.1 기록을 덮어 released 해석이 0.1.1 로 틀어졌다). 모든 publishRelease 호출은 두 뿌리를 시험 폴더로 못 박는다.
test('every publishRelease call in this file pins both instanceRoot and ledgerRoot, so no run can write the production ledger', () => {
  const source = readFileSync(import.meta.path, 'utf8');
  const calls = [...source.matchAll(/publishRelease\(\{([^}]*)\}/g)].map((m) => m[1]!);
  expect(calls.length).toBeGreaterThan(5);
  expect(calls.filter((args) => !/\binstanceRoot\b/.test(args) || !/\bledgerRoot\b/.test(args))).toEqual([]);
});
