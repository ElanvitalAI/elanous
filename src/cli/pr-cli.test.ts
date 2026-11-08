import { expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { debug } from '../debug/log.js';
import { authorizePrLandDirectMerge, registerPrCommands, runPrLand } from './pr-cli.js';

test('PR-LAND-TRAIN-ONLY-GUARD: a seat direct merge is refused before any landing side effect', async () => {
  const priorTrack = process.env.ELANOUS_TRACK;
  const priorTrainRunner = process.env.ELANOUS_TRAIN_RUNNER;
  const errors: string[] = [];
  const calls: string[] = [];
  try {
    process.env.ELANOUS_TRACK = 'OPT';
    delete process.env.ELANOUS_TRAIN_RUNNER;
    const exit = await runPrLand({}, {
      run: (command, args) => { calls.push(`${command} ${args.join(' ')}`); return { ok: true, out: '' }; },
      currentBranch: () => 'main',
      resolveBase: () => 'origin/main',
      out: { log: () => {}, error: line => errors.push(line) },
    });
    expect(exit).toBe(1);
    expect(errors).toContain('✗ train-only: OPT 호출자의 직접 병합은 OP 또는 열차 실행기만 허용됩니다. PR만 쌓으려면 --hold를 사용하십시오.');
    expect(calls).toEqual([]);
  } finally {
    if (priorTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = priorTrack;
    if (priorTrainRunner === undefined) delete process.env.ELANOUS_TRAIN_RUNNER; else process.env.ELANOUS_TRAIN_RUNNER = priorTrainRunner;
  }
});

test('PR-LAND-TRAIN-ONLY-GUARD: hold is exempt and OP or train-runner bypasses the seat restriction', () => {
  expect(authorizePrLandDirectMerge({ hold: true }, { ELANOUS_TRACK: 'OPT' })).toEqual({ allowed: true });
  expect(authorizePrLandDirectMerge({}, { ELANOUS_TRACK: 'OP' })).toEqual({ allowed: true, auditActor: 'OP' });
  expect(authorizePrLandDirectMerge({}, { ELANOUS_TRACK: 'OPT', ELANOUS_TRAIN_RUNNER: '1' }))
    .toEqual({ allowed: true, auditActor: 'train-runner' });
  expect(authorizePrLandDirectMerge({}, { ELANOUS_TRACK: 'OPT' })).toEqual({ allowed: false, seat: 'OPT' });
  expect(authorizePrLandDirectMerge({}, {})).toEqual({ allowed: true });
});

test('PR-LAND-TRAIN-ONLY-GUARD: OP and train-runner production paths each emit one audit event', async () => {
  const priorTrack = process.env.ELANOUS_TRACK;
  const priorTrainRunner = process.env.ELANOUS_TRAIN_RUNNER;
  const calls: unknown[][] = [];
  const logged = spyOn(debug, 'log').mockImplementation((...args) => { calls.push(args); });
  try {
    for (const identity of [
      { seat: 'OP', marker: undefined, actor: 'OP' },
      { seat: 'OPT', marker: '1', actor: 'train-runner' },
    ]) {
      calls.length = 0;
      process.env.ELANOUS_TRACK = identity.seat;
      if (identity.marker === undefined) delete process.env.ELANOUS_TRAIN_RUNNER;
      else process.env.ELANOUS_TRAIN_RUNNER = identity.marker;
      const commands: string[] = [];
      const code = await runPrLand({}, {
        currentBranch: () => 'main', resolveBase: () => 'origin/main',
        run: (command, args) => { commands.push(`${command} ${args.join(' ')}`); return { ok: true, out: '' }; },
        out: { log: () => {}, error: () => {} },
      });
      expect(code).toBe(1); // Reaches the harmless same-branch stop after passing authorization.
      expect(commands.some(command => command.startsWith('gh '))).toBe(false);
      expect(calls.filter(([category, event]) => category === 'pr.land' && event === 'train-only-bypass'))
        .toEqual([['pr.land', 'train-only-bypass', { actor: identity.actor, seat: identity.seat, pr: null, hold: false }]]);
    }
  } finally {
    logged.mockRestore();
    if (priorTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = priorTrack;
    if (priorTrainRunner === undefined) delete process.env.ELANOUS_TRAIN_RUNNER; else process.env.ELANOUS_TRAIN_RUNNER = priorTrainRunner;
  }
});

function fixture(body: string | null = 'Supersedes: #7') {
  const calls: string[][] = [];
  const writes: string[][] = [];
  const output: string[] = [];
  const errors: string[] = [];
  let exitCode = 0;
  const program = new Command();
  program.exitOverride();
  registerPrCommands(program, {
    run: (command, args) => {
      expect(command).toBe('gh');
      calls.push([...args]);
      if (args[0] === 'pr' && ['close', 'edit', 'merge'].includes(args[1] ?? '')) writes.push([...args]);
      return { ok: true, out: JSON.stringify({ number: 42, headRefOid: 'a'.repeat(40), body }) };
    },
    out: { log: line => output.push(line), error: line => errors.push(line) },
    setExitCode: code => { exitCode = code; },
  });
  return { program, calls, writes, output, errors, get exitCode() { return exitCode; } };
}

test('eln pr lineage --json reports observed facts and refuses unmeasured close eligibility', async () => {
  const f = fixture();
  await f.program.parseAsync(['node', 'elanous', 'pr', 'lineage', '42', '--json']);
  const result = JSON.parse(f.output[0]!);
  expect(result).toMatchObject({
    status: 'observed', pr: 42, closeEligible: false,
    currentHead: { status: 'observed', value: 'a'.repeat(40) },
    supersedes: { status: 'observed', value: 7 },
    sourceCard: { status: 'unknown' }, olderScopeCarriedForward: { status: 'unknown' },
    newerProtected: { status: 'unknown' }, cellStatus: { status: 'unknown' }, owner: { status: 'unknown' },
    mergeSubstitution: { status: 'unknown' },
  });
  expect(f.calls).toEqual([['pr', 'view', '42', '--json', 'number,headRefOid,body']]);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
  expect(f.exitCode).toBe(0);
});

test('eln pr lineage returns unknown on unreadable data and sets a failing exit code', async () => {
  const f = fixture('Supersedes: #7\nSupersedes: #8');
  await f.program.parseAsync(['node', 'elanous', 'pr', 'lineage', '42', '--json']);
  expect(JSON.parse(f.output[0]!)).toMatchObject({ status: 'unknown', closeEligible: false,
    supersedes: { status: 'unknown', value: null } });
  expect(f.writes).toEqual([]);
  expect(f.exitCode).toBe(1);
});
