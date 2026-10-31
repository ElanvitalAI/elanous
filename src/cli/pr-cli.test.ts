import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerPrCommands } from './pr-cli.js';

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
