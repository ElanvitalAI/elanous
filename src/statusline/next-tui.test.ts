import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommitTime, cliVersionLine, kstStamp, versionLabel } from '../version/build-stamp.js';
import { codeRevision, installMetadataCommitTime } from '../version/code-revision.js';
import { compactFooterTurn, createNextTuiStatusline, displayCwd, loadNextTuiStatusline, nextTuiStatuslineSnapshot, renderNextTuiStatusline } from './next-tui.js';
import { nextTuiShortStatus, nextTuiTurnIsPhase } from '../tui/chat/status-line.js';
import { defaultStatuslineDefinition } from './legacy-parity.js';
import { renderNextTuiStatus } from '../tui/branches/status.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'statusline-')); dirs.push(dir); return dir; };

const INPUT = { turnState: 'running', model: 'gpt-sim', queued: 0, backgroundTasks: 0, width: 160 };
const DEV = { version: '0.3.28-dev.0', sha: '9956d46f714fe577094b213c1c5b04d2509e983a', source: 'installed' as const };

test('the build stamp is the commit time in KST as yymmdd_hhmm (UTC 15:25 is 00:25 the next day)', () => {
  expect(kstStamp(Date.UTC(2026, 10, 17, 15, 25) / 1000)).toBe('261118_0025');
  expect(kstStamp(Date.UTC(2026, 10, 17, 10, 25) / 1000)).toBe('261117_1925');
  expect(kstStamp(Date.UTC(2026, 11, 31, 15, 0) / 1000)).toBe('270101_0000');
});

test('official shows no stamp; dev shows its stamp, or leaves it out when the commit time is unknown', () => {
  const at = Date.UTC(2026, 10, 17, 10, 25) / 1000;
  expect(versionLabel({ version: '0.3.27', source: 'installed' }, at)).toEqual({ channel: 'official', label: '0.3.27 · official', short: '0.3.27·official' });
  expect(versionLabel(DEV, at)).toEqual({ channel: 'dev', label: '0.3.28-dev.0 · 261117_1925 · dev', short: '261117_1925·dev', stamp: '261117_1925' });
  expect(versionLabel(DEV, undefined)).toEqual({ channel: 'dev', label: '0.3.28-dev.0 · dev', short: 'dev' });
  // A release version run from a checkout is still dev (only an installed release is official).
  expect(versionLabel({ version: '0.3.27', source: 'checkout' }, at).channel).toBe('dev');
});

test('no commit time anywhere: nothing is invented', () => {
  const notARepo = tempDir();
  expect(buildCommitTime({ ...DEV, sha: 'f'.repeat(40), codeRoot: notARepo })).toBeUndefined();
});

test('eln --version keeps the sha last; this checkout is dev and carries its commit stamp', () => {
  const line = cliVersionLine();
  const sha = codeRevision();
  expect(line.split(' ').at(-1)).toBe(sha ?? 'unknown');
  expect(line).toMatch(/^\S+ \d{6}_\d{4} [0-9a-f]{40}$/);
});

test('cwd: ~ for home, a long path keeps its tail, xs takes the last folder', () => {
  expect(displayCwd('/Users/me', '/Users/me')).toEqual({ full: '~', leaf: '~' });
  expect(displayCwd('/Users/me/repo', '/Users/me')).toEqual({ full: '~/repo', leaf: 'repo' });
  expect(displayCwd('/Users/me/elanous-hq/worktrees/UX/statusline/src/tui/chat', '/Users/me')).toEqual({ full: '…/UX/statusline/src/tui/chat', leaf: 'chat' });
  expect(displayCwd('/opt/x', '/Users/me').full).toBe('/opt/x');
});

test('the footer: legacy facts, then cwd and the version; dev yellow, official green; NO_COLOR keeps the words', () => {
  const definition = defaultStatuslineDefinition();
  const at = Date.UTC(2026, 10, 17, 10, 25) / 1000;
  const snapshot = nextTuiStatuslineSnapshot(INPUT, '/Users/me/repo', { ...DEV, commitTime: at }, '/Users/me');
  expect(renderNextTuiStatusline(definition, snapshot, 160, false)).toBe('Turn running · Model gpt-sim · Queue 0 · Bg 0 · ~/repo · 0.3.28-dev.0 · 261117_1925 · dev');
  expect(renderNextTuiStatusline(definition, snapshot, 160, true)).toContain('\x1b[33m0.3.28-dev.0 · 261117_1925 · dev\x1b[39m');
  const official = nextTuiStatuslineSnapshot(INPUT, '/Users/me/repo', { version: '0.3.27', sha: 'a'.repeat(40), source: 'installed' }, '/Users/me');
  expect(renderNextTuiStatusline(definition, official, 160, true)).toContain('\x1b[32m0.3.27 · official\x1b[39m');
  expect(renderNextTuiStatusline(definition, official, 160, false)).toContain('0.3.27 · official');
});

test('a user statusline.yaml replaces the default; a broken one falls back with one warning', () => {
  const dir = tempDir();
  const path = join(dir, 'statusline.yaml');
  expect(loadNextTuiStatusline(path).warning).toBeUndefined();
  writeFileSync(path, 'layouts:\n  - { band: lg, lines: 1, segments: [version] }\n');
  const custom = createNextTuiStatusline({ build: { ...DEV, commitTime: Date.UTC(2026, 10, 17, 10, 25) / 1000 }, cwd: () => dir, userPath: path, color: false });
  expect(custom.warning).toBeUndefined();
  expect(custom.render(INPUT).shown).toBe('0.3.28-dev.0 · 261117_1925 · dev');
  writeFileSync(path, 'layouts:\n  - { band: lg, lines: 3, segments: [nope] }\n');
  const broken = createNextTuiStatusline({ build: DEV, cwd: () => dir, userPath: path, color: false });
  expect(broken.warning).toMatch(/^Status line: .*statusline\.yaml has \d+ error\(s\) .* — using the default$/);
  expect(broken.render(INPUT).plain.startsWith('Turn running · Model gpt-sim')).toBe(true);
  writeFileSync(path, ': : not yaml [');
  expect(loadNextTuiStatusline(path).warning).toContain('using the default');
});

test('/status shows the same version label', () => {
  const base = { provider: 'openai-codex', model: 'gpt-sim', auth: 'oauth' as const, account: null };
  expect(renderNextTuiStatus({ ...base, version: '0.3.28-dev.0 · 261117_1925 · dev' }).at(-1)).toBe('Version: 0.3.28-dev.0 · 261117_1925 · dev');
  expect(renderNextTuiStatus(base).some((line) => line.startsWith('Version:'))).toBe(false);
});

test('install metadata lends its commit time only to its own commit', () => {
  const root = tempDir();
  writeFileSync(join(root, 'install.json'), JSON.stringify({ commit: DEV.sha, commitTime: 1794907815 }));
  expect(installMetadataCommitTime(root, DEV.sha)).toBe(1794907815);
  const other = 'b'.repeat(40);
  expect(installMetadataCommitTime(root, other)).toBeUndefined();
  // The running build is another commit and the folder is no git repository: no stamp.
  expect(buildCommitTime({ ...DEV, sha: other, codeRoot: root })).toBeUndefined();
  expect(buildCommitTime({ ...DEV, codeRoot: root })).toBe(1794907815);
});

test('statusline.yaml: a permission error warns (only a missing file is quiet); a two-line layout is refused', () => {
  const dir = tempDir();
  const path = join(dir, 'statusline.yaml');
  // The read error is injected: a real chmod 000 is still readable for root.
  const denied = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  expect(loadNextTuiStatusline(path, denied).warning).toMatch(/cannot be read \(EACCES: permission denied\) — using the default$/);
  const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  expect(loadNextTuiStatusline(path, missing).warning).toBeUndefined();
  writeFileSync(path, 'layouts:\n  - { band: lg, lines: 2, segments: [facts], secondLine: [version] }\n');
  expect(loadNextTuiStatusline(path).warning).toContain('two-line layout (lg)');
});

test('the build stamp lookup waits for the first painted footer', async () => {
  let looked = 0;
  const footer = createNextTuiStatusline({ build: DEV, cwd: () => '/', userPath: join(tempDir(), 'none.yaml'), color: false, afterFirstPaint: () => { looked += 1; } });
  await Bun.sleep(5);
  expect(looked).toBe(0);
  footer.render(INPUT);
  footer.render(INPUT);
  expect(looked).toBe(0);
  await Bun.sleep(5);
  expect(looked).toBe(1);
  // The stamp's arrival tells the caller to paint again; the same value again does not.
  expect(footer.setCommitTime(Date.UTC(2026, 10, 17, 10, 25) / 1000)).toBe(true);
  expect(footer.setCommitTime(Date.UTC(2026, 10, 17, 10, 25) / 1000)).toBe(false);
  expect(footer.setCommitTime(undefined)).toBe(false);
  expect(footer.render(INPUT).plain).toContain('0.3.28-dev.0 · 261117_1925 · dev');
});

const STAMP = Date.UTC(2026, 10, 17, 10, 25) / 1000;
const footer = (input: Partial<typeof INPUT> & Record<string, unknown>, width: number) =>
  renderNextTuiStatusline(defaultStatuslineDefinition(), nextTuiStatuslineSnapshot({ ...INPUT, ...input, width } as typeof INPUT,
    '/Users/me/elanous-hq/worktrees/UX', { ...DEV, commitTime: STAMP }, '/Users/me'), width, false);

test('footer snapshots: wide keeps the old sentence; below 120 the short line; cwd and version are never pushed out', () => {
  const busy = { turnState: '응답 중', model: 'openai-codex/gpt-sim', queued: 2, backgroundTasks: 1, elapsedMs: 185_000, measuredUsage: { inputTokens: 14, outputTokens: 6 } };
  // ≥120 with room: the old sentence, then the cwd and the version.
  expect(footer(busy, 200)).toBe('Turn running · Model openai-codex/gpt-sim · Elapsed 185.0s · Tokens 14/6 · Queue 2 · Bg 1 · ~/elanous-hq/worktrees/UX · 0.3.28-dev.0 · 261117_1925 · dev');
  // 130: the old sentence still fits with the cwd shortened to its folder.
  expect(footer(busy, 130)).toBe('Turn running · Model openai-codex/gpt-sim · Elapsed 185.0s · Tokens 14/6 · Queue 2 · Bg 1 · UX · 0.3.28-dev.0 · 261117_1925 · dev');
  // 125: with the old sentence the version would no longer fit, so the short line is drawn (cwd and version stay).
  expect(footer(busy, 125)).toBe('● running 3m · UX · 261117_1925·dev · gpt-sim · Q2·B1·14/6t');
  // 100 and 80 columns.
  // The tokens ride with the counters (review r2: they were lost below 120 columns).
  expect(footer(busy, 100)).toBe('● running 3m · UX · 261117_1925·dev · gpt-sim · Q2·B1·14/6t');
  expect(footer(busy, 80)).toBe('● running 3m · UX · 261117_1925·dev · gpt-sim · Q2·B1·14/6t');
  expect(footer({ turnState: '대기' }, 80)).toBe('○ idle · UX · 261117_1925·dev · gpt-sim · Q0·B0');
  // A long informative state is cut at its end; the cwd and the version keep their room.
  const long = footer({ turnState: 'Task list · Enter to send · Esc closes the list and keeps the draft' }, 60);
  expect(long.endsWith(' · UX · 261117_1925·dev')).toBe(true);
  expect(long.startsWith('● Task list · Enter to send')).toBe(true);
  expect(long).toContain('…');
});

test('the short turn clause: phases with how long, failures first, information kept whole', () => {
  const short = (turnState: string, elapsedMs?: number) => nextTuiShortStatus({ ...INPUT, turnState, ...(elapsedMs === undefined ? {} : { elapsedMs }) }).turn;
  expect([short('응답 중', 12_000), short('응답 중', 185_000), short('Bash 실행 중', 3_725_000), short('응답 완료', 9_000), short('대기')])
    .toEqual(['● running 12s', '● running 3m', '● tools 1h2m', '○ done', '○ idle']);
  expect(nextTuiShortStatus({ ...INPUT, turnState: '실패' })).toMatchObject({ turn: '✗ failed', exception: true });
  expect(short('취소')).toBe('■ cancelled');
  expect(short('Bash approval timed out · denied')).toBe('● Bash approval timed out · denied');
  expect(nextTuiShortStatus({ ...INPUT, model: 'openai-codex/gpt-sim', queued: 3, steering: 1, backgroundTasks: 2 })).toMatchObject({ model: 'gpt-sim', rest: 'S1·Q2·B2' });
});

test('a turn-end summary or a hint takes only the turn part: cwd, version and a user layout stay', () => {
  const footer = createNextTuiStatusline({ build: { ...DEV, commitTime: STAMP }, cwd: () => '/Users/me/repo', userPath: join(tempDir(), 'none.yaml'), color: false });
  const turnEnd = '✻ Worked for 3s · done 7:25 PM';
  expect(footer.render({ ...INPUT, width: 100 }, turnEnd).plain).toBe(`${turnEnd} · repo · 261117_1925·dev · gpt-sim · Q0·B0`);
  const wide = footer.render({ ...INPUT, width: 160 }, `${turnEnd} · Attachments 1/2 PgUp/PgDn`);
  expect(wide.plain.startsWith(`${turnEnd} · Attachments 1/2 PgUp/PgDn · `)).toBe(true);
  expect(wide.plain).toContain('0.3.28-dev.0 · 261117_1925 · dev');
  // facts (what the logic reads) stay the turn's own text.
  expect(wide.facts.startsWith('Turn running')).toBe(true);
  // A user layout keeps its own segments around the replaced turn.
  const dir = tempDir();
  writeFileSync(join(dir, 'statusline.yaml'), 'layouts:\n  - { band: md, lines: 1, segments: [version_short, turn_short] }\n');
  const custom = createNextTuiStatusline({ build: { ...DEV, commitTime: STAMP }, cwd: () => dir, userPath: join(dir, 'statusline.yaml'), color: false });
  expect(custom.render({ ...INPUT, width: 100 }, turnEnd).plain).toBe(`261117_1925·dev · ${turnEnd}`);
});

test('review r2: a long folder name is cut so the line drops whole segments instead of cutting the version', () => {
  const longDir = '/Users/me/uxpack-input-history-Kw8GrIabcdef';
  expect(displayCwd(longDir, '/Users/me').leaf).toBe('uxpack-input-hi…');
  const line = (width: number) => renderNextTuiStatusline(defaultStatuslineDefinition(),
    nextTuiStatuslineSnapshot({ ...INPUT, turnState: '대기', width }, longDir, { ...DEV, commitTime: STAMP }, '/Users/me'), width, false);
  expect(line(60)).toBe('○ idle · uxpack-input-hi… · 261117_1925·dev · gpt-sim');
  // xs keeps the cwd over the version (OP priority ③ > ④) and never cuts the version in the middle.
  expect(line(40)).toBe('○ idle · uxpack-input-hi…');
});

test('review r2: a user layout with the turn segment shows the turn-end summary too', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'statusline.yaml'), 'layouts:\n  - { band: md, lines: 1, segments: [turn, version_short] }\n');
  const custom = createNextTuiStatusline({ build: { ...DEV, commitTime: STAMP }, cwd: () => dir, userPath: join(dir, 'statusline.yaml'), color: false });
  expect(custom.render({ ...INPUT, width: 100 }, '✻ Worked for 3s').plain).toBe('Turn ✻ Worked for 3s · 261117_1925·dev');
});

describe('NEXT-TUI-FOOTER-24-ROWS · compact turn slot', () => {
  const base = { welcomePending: false, attachmentHint: null, shortTurn: '● running 3m', activeChildren: 0 };
  test('nothing compact-only → no replacement (the line draws its own short turn)', () => {
    expect(compactFooterTurn(base)).toBeUndefined();
  });
  test('the welcome key hint, the attachment hint (first) and the sub-agent count take the turn place; no queue', () => {
    expect(compactFooterTurn({ ...base, welcomePending: true })).toBe('Enter send · Esc cancel · Ctrl+Q quit');
    expect(compactFooterTurn({ ...base, attachmentHint: 'Attachments 1/3' })).toBe('Attachments 1/3 · ● running 3m');
    expect(compactFooterTurn({ ...base, activeChildren: 2 })).toBe('● running 3m · Children 2');
  });

  // #38292 REVIEW-1: the values the compact call site passes (entry.ts) — an 80-column footer with a long turn, an
  // attachment hint and a queue. The hint must survive the cut, and the queue must appear once (in the counters).
  test('80 columns, as the call site draws it: the attachment hint survives and the queue is shown once', () => {
    const footer = createNextTuiStatusline({ build: { ...DEV, commitTime: STAMP }, cwd: () => '/home/me/projects/ticketing-app', color: false, userPath: '/nonexistent/statusline.yaml' });
    const input = { ...INPUT, width: 80, turnState: '도구 실행 중 · 아주 긴 단계 설명이 붙은 상태 문장', queued: 3, steering: 1, elapsedMs: 200_000 };
    const turn = compactFooterTurn({ welcomePending: false, attachmentHint: 'Attachments 2/4', shortTurn: nextTuiShortStatus(input).turn, activeChildren: 1 });
    const line = footer.render(input, turn).plain;
    expect(line).toContain('Attachments 2/4');
    expect(line).toContain('ticketing-app');
    expect(line).not.toContain('Steer');
    // Where the counters fit, the queue appears exactly once — in them («S1·Q2»), never again in the turn place.
    const known = { ...input, turnState: 'running', width: 110 };
    const roomy = footer.render(known, compactFooterTurn({ welcomePending: false, attachmentHint: 'Attachments 2/4',
      shortTurn: nextTuiShortStatus(known).turn, activeChildren: 1 })).plain;
    expect(roomy).toContain('Attachments 2/4');
    expect(roomy.match(/Q\d/gu)).toEqual(['Q2']);
    expect(roomy).not.toContain('Steer');
  });
});

// #38392 REVIEW-1: at the bottom while a turn runs, no turn information repeats under the progress row.
describe('bottom line during a turn: no turn clause, whatever the layout calls it', () => {
  test('① compact: with children running, the turn slot keeps «Children n» and drops the turn clause', () => {
    expect(compactFooterTurn({ welcomePending: false, attachmentHint: null, shortTurn: '', activeChildren: 2 })).toBe('Children 2');
    expect(compactFooterTurn({ welcomePending: false, attachmentHint: null, shortTurn: '● running 3m', activeChildren: 2 })).toBe('● running 3m · Children 2');
    const footer = createNextTuiStatusline({ build: { ...DEV, commitTime: STAMP }, cwd: () => '/home/me/app', color: false, userPath: '/nonexistent/statusline.yaml' });
    const busy = { ...INPUT, width: 80, turnState: 'running', elapsedMs: 200_000 };
    const line = footer.render(busy, 'Children 2').plain;
    expect(line).toContain('Children 2');
    expect(line).not.toMatch(/running|Turn /);
  });

  test('② a user layout reading session.turn under its own id has it dropped while running; its other segments stay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slb-user-'));
    try {
      const userPath = join(dir, 'statusline.yaml');
      writeFileSync(userPath, [
        'segments:',
        '  - { id: my_turn, source: session, field: turn, label: "Now" }',
        '  - { id: my_folder, source: session, field: cwd_leaf }',
        'layouts:',
        '  - { band: sm, lines: 1, segments: [my_turn, my_folder] }',
        '  - { band: md, lines: 1, segments: [my_turn, my_folder] }',
      ].join('\n'));
      const footer = createNextTuiStatusline({ build: { ...DEV, commitTime: STAMP }, cwd: () => '/home/me/app', color: false, userPath });
      const busy = { ...INPUT, width: 80, turnState: 'running', elapsedMs: 200_000 };
      expect(footer.render(busy).plain).toContain('Now ');
      const bottom = footer.render(busy, undefined, true).plain;
      expect(bottom).not.toContain('Now ');
      expect(bottom).toContain('app');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test('#38392: only a plain phase is dropped at the bottom; an action answer in the turn slot stays', () => {
  for (const phase of ['running', 'idle', 'done', 'tools']) expect(nextTuiTurnIsPhase(phase)).toBe(true);
  for (const answer of ['Editing queued item · Enter sends it again', 'Queue closed', 'Steer applied · running']) {
    expect(nextTuiTurnIsPhase(answer)).toBe(false);
  }
});

// #38392 r3: at a wide width the bottom line keeps the lg layout's own segments while a turn runs; only the turn goes.
test('wide screen during a turn: a segment only the lg layout shows stays; the turn segment is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slb-lg-'));
  try {
    const userPath = join(dir, 'statusline.yaml');
    writeFileSync(userPath, [
      'segments:',
      '  - { id: my_turn, source: session, field: turn, label: "Now" }',
      '  - { id: wide_folder, source: session, field: cwd }',
      '  - { id: wide_model, source: session, field: model, label: "M" }',
      '  - { id: small_folder, source: session, field: cwd_leaf }',
      'layouts:',
      '  - { band: md, lines: 1, segments: [my_turn, small_folder] }',
      '  - { band: lg, lines: 1, segments: [my_turn, wide_folder, wide_model] }',
    ].join('\n'));
    const footer = createNextTuiStatusline({ build: { ...DEV, commitTime: STAMP }, cwd: () => '/home/me/app', color: false, userPath });
    const busy = { ...INPUT, width: 160, turnState: 'running', elapsedMs: 200_000 };
    const bottom = footer.render(busy, undefined, true).plain;
    expect(bottom).toContain('M gpt-sim'); // the lg-only segment stays
    expect(bottom).toContain('/home/me/app');
    expect(bottom).not.toContain('Now ');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// #38392 (대표): the default wide layout shows the model while a turn runs too — once, without the turn.
test('default layout, wide screen: running → model at the bottom, no turn; idle → the model once', () => {
  const footer = createNextTuiStatusline({ build: { ...DEV, commitTime: STAMP }, cwd: () => '/home/me/app', color: false, userPath: '/nonexistent/statusline.yaml' });
  const running = footer.render({ ...INPUT, width: 160, turnState: 'running', elapsedMs: 200_000 }, undefined, true).plain;
  expect(running).toContain('gpt-sim');
  expect(running).not.toMatch(/Turn |running/);
  const idle = footer.render({ ...INPUT, width: 160, turnState: 'idle' }).plain;
  expect(idle.match(/gpt-sim/g)).toHaveLength(1);
});

// #38392 r4: exclude the turn FIRST, then choose the layout, then fit the width — select · fit · exclude × idle · running.
describe('bottom line order: exclude → select → fit', () => {
  const long = 'tools · reading a very long step description that fills the line';
  test('select: at 120 columns the default line is the narrow one while idle (the sentence does not fit), the wide one while running', () => {
    const footer = createNextTuiStatusline({ build: { ...DEV, commitTime: STAMP }, cwd: () => '/srv/projects/ticketing-app', color: false, userPath: '/nonexistent/statusline.yaml' });
    const base = { ...INPUT, width: 120, turnState: long, queued: 3, backgroundTasks: 2, elapsedMs: 200_000 };
    const idle = footer.render(base).plain;
    const running = footer.render(base, undefined, true).plain;
    expect(idle).toContain('ticketing-app');
    expect(running).toContain('/srv/projects/ticketing-app'); // the wide layout's full cwd
    expect(running).toContain('0.3.28-dev.0'); // the wide layout's version
    expect(running).toContain('gpt-sim');
    expect(running).not.toContain('reading a very long'); // exclude
  });

  test('fit: at a boundary width a long turn pushes the version out only when it is drawn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slb-fit-'));
    try {
      const userPath = join(dir, 'statusline.yaml');
      writeFileSync(userPath, [
        'segments:',
        '  - { id: my_turn, source: session, field: turn }',
        '  - { id: my_folder, source: session, field: cwd_leaf }',
        '  - { id: my_version, source: build, field: short }',
        'layouts:',
        '  - { band: sm, lines: 1, segments: [my_turn, my_folder, my_version], drop: [my_version] }',
        '  - { band: md, lines: 1, segments: [my_turn, my_folder, my_version], drop: [my_version] }',
      ].join('\n'));
      const footer = createNextTuiStatusline({ build: { ...DEV, commitTime: STAMP }, cwd: () => '/home/me/app', color: false, userPath });
      const base = { ...INPUT, width: 60, turnState: long, elapsedMs: 200_000 };
      const idle = footer.render(base).plain;
      const running = footer.render(base, undefined, true).plain;
      expect(idle).not.toContain('261117_1925'); // dropped to make room for the turn
      expect(running).toContain('app');
      expect(running).toContain('261117_1925'); // kept: the turn was excluded before fitting
      expect(running).not.toContain('reading a very long');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
