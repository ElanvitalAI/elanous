import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPrCommands } from './pr-cli.js';
import type { HotspotStartForecastRow } from './hotspot-start-forecast.js';

test('pr command list snapshot keeps queue, land, and granularity beside the new thin entrypoints', () => {
  const root = new Command();
  registerPrCommands(root);
  const pr = root.commands.find(command => command.name() === 'pr');
  expect(pr?.commands.map(command => command.name())).toEqual(['supersede-drafts', 'lineage', 'census', 'open-guard', 'queue', 'land', 'granularity']);
  expect(pr?.commands.find(command => command.name() === 'queue')?.commands.map(command => command.name()))
    .toEqual(['status', 'enqueue', 'train-event', 'run']);
});

test('read-only open-guard reports unknown without spending the new-PR allowance', async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const exits: number[] = [];
  const root = new Command();
  registerPrCommands(root, {
    run: (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git' && args.includes('--name-only')) return { ok: true, out: 'src/example.ts\0' };
      if (command === 'git' && args.includes('--unified=0')) return { ok: true, out: '' };
      return { ok: false, out: '', err: 'GitHub unavailable' };
    },
    out: { log: line => lines.push(line), error: line => lines.push(line) },
    setExitCode: code => exits.push(code),
  });
  await root.parseAsync(['pr', 'open-guard', '--seat', 'UX'], { from: 'user' });
  expect(JSON.parse(lines[0]!)).toMatchObject({ status: 'unknown', reasons: [{ code: 'inventory-unknown' }] });
  expect(exits).toEqual([1]);
  expect(calls.some(call => call.startsWith('eln msg post'))).toBe(false);
  expect(lines[0]).not.toContain('allowCreation');
});

test('open-guard CLI planned files reject aliases and require a current-head OP approval without fetching patches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-guard-cli-'));
  const approvalFile = join(dir, 'approval.json');
  const heads = ['a'.repeat(40), 'b'.repeat(40)];
  const rows = [
    ...heads.map((head, index) => ({ number: index + 1, title: `PR ${index + 1}`, state: 'open', draft: false,
      updated_at: '2026-11-08T00:00:00Z', head: { ref: `branch-${index + 1}`, sha: head }, body: '', labels: [] })),
    { number: 3, title: 'PR 3', state: 'open', draft: false, updated_at: '2026-11-08T00:00:00Z',
      head: { ref: 'branch-3', sha: 'c'.repeat(40) }, body: '', labels: [] },
  ];
  const calls: string[] = [];
  const forecasts: HotspotStartForecastRow[] = [];
  let inventoryFails = false;
  let patchFails = false;
  let forecastFails = false;
  let baseFails = false;
  let sourceAuthor = 'ElanvitalAI';
  let actualDiff = '';
  const invoke = async (args: string[]) => {
    const lines: string[] = [];
    const exits: number[] = [];
    const root = new Command();
    registerPrCommands(root, {
      run: (command, argv) => {
        calls.push(`${command} ${argv.join(' ')}`);
        if (command === 'git' && argv.includes('rev-parse')) return baseFails
          ? { ok: false, out: '', err: 'base unavailable' } : { ok: true, out: 'd'.repeat(40), err: '' };
        if (command === 'git') return argv.includes('--unified=0') && patchFails
          ? { ok: false, out: '', err: 'patch unavailable' }
          : { ok: true, out: argv.includes('--name-only') ? actualDiff : '', err: '' };
        if (argv[0] === 'pr' && argv[1] === 'list') return { ok: true, out: JSON.stringify(rows.map(row => ({
          number: row.number, changedFiles: 1, files: [{ path: row.number === 3 ? 'src/actual.ts' : 'src/shared.ts' }],
        }))) };
        if (argv[0] === 'api' && argv[1] === 'repos/ElanvitalAI/elanous/issues/comments/42')
          return { ok: true, out: JSON.stringify({ id: 42, user: { login: sourceAuthor }, body: JSON.stringify({
            kind: 'HOTSPOT-FILE-LEASE-APPROVAL', files: ['src/shared.ts'],
            prs: heads.map((headSha, index) => ({ number: index + 1, headSha })),
          }) }) };
        if (argv.some(arg => arg.includes('/pulls?state=open&per_page=100')))
          return inventoryFails ? { ok: false, out: '', err: 'offline' } : { ok: true, out: JSON.stringify(rows) };
        if (argv[0] === 'pr' && argv[1] === 'diff') return { ok: true, out: '', err: '' };
        return { ok: false, out: '', err: 'unexpected command' };
      },
      out: { log: line => lines.push(line), error: line => lines.push(line) },
      setExitCode: code => exits.push(code),
      appendHotspotStartForecast: row => { if (forecastFails) throw new Error('ledger unavailable'); forecasts.push(row); },
    });
    await root.parseAsync(['pr', 'open-guard', '--seat', 'OP', ...args], { from: 'user' });
    return { verdict: JSON.parse(lines[0]!), exits };
  };
  try {
    expect((await invoke(['--planned-file', 'src/shared.ts'])).verdict.hotspot)
      .toMatchObject({ status: 'refuse', reason: 'hotspot-op-approval-required' });
    expect(forecasts).toMatchObject([
      { base: 'd'.repeat(40), otherPr: 1, files: ['src/shared.ts'], conflict: null, detector: 'open-guard' },
      { base: 'd'.repeat(40), otherPr: 2, files: ['src/shared.ts'], conflict: null, detector: 'open-guard' },
    ]);
    expect((await invoke(['--planned-file', './src/shared.ts'])).verdict.hotspot)
      .toMatchObject({ status: 'unknown', reason: 'planned-files-unknown' });
    writeFileSync(approvalFile, JSON.stringify({ commentUrl: 'https://github.com/ElanvitalAI/elanous/issues/42#issuecomment-42',
      files: ['src/shared.ts'], prs: heads.map((headSha, index) => ({ number: index + 1, headSha })) }));
    expect(await invoke(['--planned-file', 'src/shared.ts', '--op-approval-file', approvalFile]))
      .toMatchObject({ verdict: { status: 'allow', hotspot: { status: 'allow' } }, exits: [] });
    sourceAuthor = 'forger';
    expect((await invoke(['--planned-file', 'src/shared.ts', '--op-approval-file', approvalFile])).verdict.hotspot.status).toBe('refuse');
    sourceAuthor = 'ElanvitalAI';
    writeFileSync(approvalFile, JSON.stringify({ commentUrl: 'https://github.com/ElanvitalAI/elanous/issues/42#issuecomment-42',
      files: ['src/shared.ts'], prs: heads.map((headSha, index) => ({ number: index + 1, headSha: index === 1 ? 'c'.repeat(40) : headSha })) }));
    expect((await invoke(['--planned-file', 'src/shared.ts', '--op-approval-file', approvalFile])).verdict.hotspot.status).toBe('refuse');
    inventoryFails = true;
    expect((await invoke(['--planned-file', 'src/shared.ts'])).verdict.hotspot.status).toBe('unknown');
    expect(forecasts.at(-1)).toMatchObject({ otherPr: null, conflict: null });
    expect(forecasts.at(-1)?.unmeasuredReason).toContain('inventory-unknown:');
    expect(calls.some(call => call.includes('pr diff'))).toBe(false);
    inventoryFails = false;
    actualDiff = 'src/actual.ts\0';
    const separated = await invoke(['--planned-file', 'src/shared.ts']);
    expect(separated.verdict.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'file-overlap', prs: [3] }),
    ]));
    expect(separated.verdict.hotspot).toMatchObject({ status: 'refuse', reason: 'hotspot-op-approval-required' });
    expect(calls.some(call => call.includes('pr diff 3 --patch'))).toBe(true);
    actualDiff = '';
    const noPlannedFiles = await invoke([]);
    expect(noPlannedFiles.verdict).toMatchObject({ status: 'unknown', reasons: [{ code: 'candidate-unknown' }] });
    expect(noPlannedFiles.verdict.hotspot).toBeUndefined();
    const forecastCount = forecasts.length;
    expect((await invoke([])).verdict.hotspot).toBeUndefined();
    expect(forecasts).toHaveLength(forecastCount);
    actualDiff = 'src/actual.ts\0';
    patchFails = true;
    expect((await invoke([])).verdict).toMatchObject({ status: 'unknown', reasons: [{ code: 'candidate-unknown' }] });
    patchFails = false;
    baseFails = true;
    expect((await invoke(['--planned-file', 'src/shared.ts'])).verdict).toMatchObject({ status: 'unknown', forecastError: 'forecast-base-unavailable' });
    baseFails = false;
    forecastFails = true;
    expect((await invoke(['--planned-file', 'src/shared.ts'])).verdict).toMatchObject({ status: 'unknown' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
