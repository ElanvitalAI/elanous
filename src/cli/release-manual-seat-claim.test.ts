import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { listChecklist, parseOwner } from '../release-loop/checklist.js';
import { registerReleaseCommands } from './release-cli.js';
import { listOpenCellPullRequests, manualSeatClaimOpenPrRefusal, type CellOpenPullRequest } from './release-manual-seat-claim.js';

const openPr = (overrides: Partial<CellOpenPullRequest> = {}): CellOpenPullRequest => ({ number: 42,
  title: 'fix(SEAT-CLAIM-GUARD-OPEN-PR-OWNER): protect a cell owner', body: '', headRefName: 'ux/claim-owner',
  assignees: ['UX'], ...overrides });

test('cell claim allows only the owner seat of a matching open PR', () => {
  expect(manualSeatClaimOpenPrRefusal('SEAT-CLAIM-GUARD-OPEN-PR-OWNER', 'TC', [openPr()]))
    .toContain('#42 owner=UX');
  expect(manualSeatClaimOpenPrRefusal('SEAT-CLAIM-GUARD-OPEN-PR-OWNER', 'TC', [
    openPr({ headRefName: 'tc/claim-owner', assignees: ['TC'] }),
  ])).toBeNull();
  expect(manualSeatClaimOpenPrRefusal('SEAT-CLAIM-GUARD-OPEN-PR-OWNER', 'TC', [
    openPr({ number: 43, title: 'fix(OTHER-CELL): unrelated work', body: 'Related background mentions SEAT-CLAIM-GUARD-OPEN-PR-OWNER.' }),
    openPr({ number: 44, title: 'fix(OTHER-CELL): sample metadata',
      body: 'Example metadata:\n```\nCell ID: SEAT-CLAIM-GUARD-OPEN-PR-OWNER\n```' }),
    openPr({ number: 45, title: 'fix(OTHER-CELL): indented metadata',
      body: '    Cell ID: SEAT-CLAIM-GUARD-OPEN-PR-OWNER\n\nThis is a Markdown code block example.' }),
  ])).toBeNull();
  expect(manualSeatClaimOpenPrRefusal('SEAT-CLAIM-GUARD-OPEN-PR-OWNER', 'TC', [
    openPr({ title: 'fix(other): cell owned via body field', body: 'Cell ID: SEAT-CLAIM-GUARD-OPEN-PR-OWNER\n\nOther details.' }),
  ])).toContain('#42 owner=UX');
  expect(manualSeatClaimOpenPrRefusal('SEAT-CLAIM-GUARD-OPEN-PR-OWNER', 'TC', [
    openPr({ title: 'fix(other): body field with trailing whitespace',
      body: 'Cell ID: SEAT-CLAIM-GUARD-OPEN-PR-OWNER  \n\nOther details.' }),
  ])).toContain('#42 owner=UX');
  expect(manualSeatClaimOpenPrRefusal('SEAT-CLAIM-GUARD-OPEN-PR-OWNER', 'TC', [
    openPr({ assignees: [] }),
  ])).toContain('#42 owner=unresolved (unassigned)');
});

test('open cell PR enumeration pins the repo, avoids search indexing, and fails closed when incomplete', () => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const rows = [openPr(), openPr({ number: 43, title: 'fix(OTHER-CELL): related work',
    body: 'This description references SEAT-CLAIM-GUARD-OPEN-PR-OWNER as a dependency.\n```\nCell ID: SEAT-CLAIM-GUARD-OPEN-PR-OWNER\n```' }),
    openPr({ number: 44, title: 'fix(OTHER-CELL): indented example',
      body: '    Cell ID: SEAT-CLAIM-GUARD-OPEN-PR-OWNER\n\nExample only.' })];
  const found = listOpenCellPullRequests('SEAT-CLAIM-GUARD-OPEN-PR-OWNER', '/repo', (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'git') return { status: 0, stdout: 'https://github.com/ElanvitalAI/elanous.git\n' };
    return { status: 0, stdout: JSON.stringify(rows) };
  });
  expect(found.map((row) => row.number)).toEqual([42]);
  expect(calls[0]).toMatchObject({ command: 'git', args: ['remote', 'get-url', 'origin'], cwd: '/repo' });
  expect(calls[1]).toMatchObject({ command: 'gh', cwd: '/repo' });
  expect(calls[1]?.args).toContain('ElanvitalAI/elanous');
  expect(calls[1]?.args).toContain('1000');
  expect(calls[1]?.args).not.toContain('SEAT-CLAIM-GUARD-OPEN-PR-OWNER in:title,body');
  expect(() => listOpenCellPullRequests('CELL', '/repo', () => ({ status: 1, stdout: '' })))
    .toThrow('could not resolve target repository origin');
  expect(() => listOpenCellPullRequests('CELL', '/repo', (command) => command === 'git'
    ? { status: 0, stdout: 'https://example.com/owner/repo.git' }
    : { status: 0, stdout: '{' }))
    .toThrow('not a supported GitHub repository URL');
  expect(() => listOpenCellPullRequests('CELL', '/repo', (command) => command === 'git'
    ? { status: 0, stdout: 'git@github.com:owner/repo.git' }
    : { status: 1, stdout: '' }))
    .toThrow('gh pr list failed');
  expect(() => listOpenCellPullRequests('CELL', '/repo', (command) => command === 'git'
    ? { status: 0, stdout: 'git@github.com:owner/repo.git' }
    : { status: 0, stdout: '{' }))
    .toThrow('invalid JSON');
  expect(() => listOpenCellPullRequests('CELL', '/repo', (command) => command === 'git'
    ? { status: 0, stdout: 'git@github.com:owner/repo.git' }
    : { status: 0, stdout: JSON.stringify(Array.from({ length: 1000 }, (_, index) => openPr({ number: index + 1 }))) }))
    .toThrow('may be truncated');
});

test('release checklist claim refuses a foreign open PR before writing and permits its matching owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-cell-open-pr-owner-'));
  const previousTrack = process.env.ELANOUS_TRACK;
  let openPullRequests: readonly CellOpenPullRequest[] = [];
  setElanousConfigDir(dir);
  process.env.ELANOUS_TRACK = 'TC';
  const run = async (...args: string[]) => {
    const command = new Command();
    registerReleaseCommands(command, {}, {}, {}, {}, {}, {}, undefined, {
      listOpenPullRequests: () => openPullRequests,
    });
    await command.parseAsync(['release', 'checklist', '--version', '9.9.9', ...args], { from: 'user' });
  };
  try {
    await run('add', 'CELL-OWNER', 'manual seat owner guard', '--owner', 'TC');
    openPullRequests = [openPr({ title: 'fix(CELL-OWNER): active work' })];
    // The claimed-to seat is caller-controlled input; it cannot impersonate the PR owner.
    await expect(run('claim', 'CELL-OWNER', '--by', 'UX')).rejects.toThrow('#42 owner=UX');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'CELL-OWNER')?.owner).toBe('TC');

    openPullRequests = [openPr({ title: 'fix(CELL-OWNER): active work', headRefName: 'tc/cell-owner', assignees: ['TC'] })];
    await run('claim', 'CELL-OWNER', '--by', 'TC');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'CELL-OWNER')?.owner).toBe('TC');
  } finally {
    if (previousTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = previousTrack;
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release checklist claim accepts manual seats, wildcard buckets, and legacy seat syntax', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-manual-seat-claim-'));
  setElanousConfigDir(dir);
  expect(parseOwner('TC-1')).toEqual({ seat: 'TC-1' });
  expect(parseOwner('MVP-D/rel')).toEqual({ seat: 'MVP-D', sub: 'rel' });
  expect(parseOwner('MVP-A')).toEqual({ seat: 'MVP-A' });
  expect(parseOwner('MVP-Z')).toEqual({ seat: 'MVP-Z' });
  expect(parseOwner('TC/rel')).toEqual({ seat: 'TC', sub: 'rel' });
  for (const seat of ['R-OAUTH', 'Q-1', 'WIN-AZ', 'ABSORB-1', 'ABSORB-3', 'ABSORB-4', 'NM-1'])
    expect(parseOwner(seat)).toEqual({ seat });
  expect(() => parseOwner('R-FAKE')).toThrow('잘못된 담당');
  const seatState = join(dir, 'seat-state');
  mkdirSync(seatState);
  const registryPath = join(seatState, 'seat-registry.json');
  const registry = (address: string) => JSON.stringify({ version: 1, seats: [
    { address, host: 'unknown', wake: 'none', replyBody: 'agent', optIn: false },
  ] });
  writeFileSync(registryPath, registry('R-CUSTOM'));
  expect(parseOwner('R-CUSTOM')).toEqual({ seat: 'R-CUSTOM' });
  expect(() => parseOwner('R-FAKE')).toThrow('잘못된 담당');
  const originalStat = statSync(registryPath);
  writeFileSync(registryPath, registry('R-OTHERS'));
  const sameSecond = Math.floor(originalStat.mtimeMs / 1000);
  utimesSync(registryPath, sameSecond, sameSecond);
  expect(statSync(registryPath).size).toBe(originalStat.size);
  expect(Math.floor(statSync(registryPath).mtimeMs / 1000)).toBe(sameSecond);
  expect(() => parseOwner('R-CUSTOM')).toThrow('잘못된 담당');
  expect(parseOwner('R-OTHERS')).toEqual({ seat: 'R-OTHERS' });
  const run = async (...args: string[]) => {
    const command = new Command();
    registerReleaseCommands(command, {}, {}, {}, {}, {}, {}, undefined, { listOpenPullRequests: () => [] });
    await command.parseAsync(['release', 'checklist', '--version', '9.9.9', ...args], { from: 'user' });
  };
  const previousTrack = process.env.ELANOUS_TRACK;
  process.env.ELANOUS_TRACK = 'OP';
  try {
    const seats = ['MVP-D', 'MVP-Z', 'MVP-*', 'NM-*', 'NT-*', 'GATE-G'];
    for (const [index, seat] of seats.entries()) {
      const id = `M${index + 1}`;
      await run('add', id, 'manual work', '--owner', 'OP');
      await run('claim', id, '--by', seat, '--force', '--reason', 'OP test reassignment');
      expect(listChecklist('9.9.9').items.find((item) => item.id === id)?.owner).toBe(seat);
    }
    for (const [id, seat] of [['M7', 'MVP-D/rel'], ['M8', 'TC-1']] as const) {
      await run('add', id, 'compatible seat syntax', '--owner', 'OP');
      await run('claim', id, '--by', seat, '--force', '--reason', 'OP test reassignment');
      expect(listChecklist('9.9.9').items.find((item) => item.id === id)?.owner).toBe(seat);
    }
    await run('add', 'M9', 'registered seat owner guard', '--owner', 'R-OTHERS');
    process.env.ELANOUS_TRACK = 'R-OTHERS';
    await run('claim', 'M9', '--by', 'R-OTHERS');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'M9')?.owner).toBe('R-OTHERS');
    writeFileSync(registryPath, registry('TEAM_MEMBER_01'));
    expect(parseOwner('TEAM_MEMBER_01')).toEqual({ seat: 'TEAM_MEMBER_01' });
    expect(parseOwner('TEAM_MEMBER_01/rel')).toEqual({ seat: 'TEAM_MEMBER_01', sub: 'rel' });
    await run('add', 'M10', 'registered address follows registry syntax', '--owner', 'OP');
    process.env.ELANOUS_TRACK = 'OP';
    await run('claim', 'M10', '--by', 'TEAM_MEMBER_01');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'M10')?.owner).toBe('TEAM_MEMBER_01');
    process.env.ELANOUS_TRACK = 'OP';
    await run('add', 'MI', 'invalid manual label', '--owner', 'OP');
    for (const invalid of ['MVP-D-EXTRA', 'MVP-**', 'MVP-']) {
      await expect(run('claim', 'MI', '--by', invalid)).rejects.toThrow('잘못된 담당');
    }
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'MI')?.owner).toBe('OP');
  } finally {
    if (previousTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = previousTrack;
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('incident simulation: only the current cell owner may delegate and only OP may force-reassign', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-claim-authorization-sim-'));
  const previousTrack = process.env.ELANOUS_TRACK;
  setElanousConfigDir(dir);
  const runAs = async (seat: string, ...args: string[]) => {
    process.env.ELANOUS_TRACK = seat;
    const command = new Command();
    registerReleaseCommands(command, {}, {}, {}, {}, {}, {}, undefined, { listOpenPullRequests: () => [] });
    await command.parseAsync(['release', 'checklist', '--version', '9.9.9', ...args], { from: 'user' });
  };
  try {
    await runAs('TC', 'add', 'C1', 'owned cell', '--owner', 'TC');
    await runAs('TC', 'claim', 'C1', '--by', 'TC/rel');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C1')?.owner).toBe('TC/rel');

    await expect(runAs('MVP-D', 'claim', 'C1', '--by', 'MVP-D'))
      .rejects.toThrow(/칸 주인 또는 OP만 claim/);
    await expect(runAs('OP/rel', 'claim', 'C1', '--by', 'MVP-D', '--force', '--reason', 'subseat cannot sign'))
      .rejects.toThrow(/OP 서명/);
    await expect(runAs('MVP-D', 'claim', 'C1', '--by', 'MVP-D', '--force', '--reason', 'simulation authorization'))
      .rejects.toThrow(/OP|서명/);
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C1')?.owner).toBe('TC/rel');

    await expect(runAs('OP', 'claim', 'C1', '--by', 'MVP-D', '--force')).rejects.toThrow(/--reason/);
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C1')?.owner).toBe('TC/rel');
    await runAs('OP', 'claim', 'C1', '--by', 'MVP-D', '--force', '--reason', 'OP simulation approval');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C1')?.owner).toBe('MVP-D');
    expect(listChecklist('9.9.9').history.at(-1)).toMatchObject({ by: 'OP', from: 'TC/rel', to: 'MVP-D', force: true, reason: 'OP simulation approval' });

    await runAs('OP', 'add', 'C3', 'registered Q-1 reassignment', '--owner', 'OP');
    await runAs('OP', 'claim', 'C3', '--by', 'Q-1', '--force', '--reason', 'OP assigns registered Q-1 seat');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C3')?.owner).toBe('Q-1');
    expect(listChecklist('9.9.9').history.at(-1)).toMatchObject({ by: 'OP', to: 'Q-1', force: true });

    await runAs('TC', 'add', 'C2', 'delegation cell', '--owner', 'TC');
    await runAs('TC', 'claim', 'C2', '--by', 'MVP-D');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'C2')?.owner).toBe('MVP-D');
  } finally {
    if (previousTrack === undefined) delete process.env.ELANOUS_TRACK;
    else process.env.ELANOUS_TRACK = previousTrack;
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});
