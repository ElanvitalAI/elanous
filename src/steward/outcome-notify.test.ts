import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDirectiveOrigin } from './directive.js';
import { notifyOutcome, type OutcomeNotifyDeps } from './outcome-notify.js';
import { readLaunchLedger, saveLaunchLedger, type LaunchEntry } from './launch.js';
import { runStewardStage, type StewardDeps } from './triage.js';

const runId = 'run-12345678-1234-1234-1234-123456789abc';
const origin = { channel: 'telegram' as const, chatId: 123, botId: '987', threadId: 4 };
// realpath: macOS tmpdir is /var → /private/var, and the notifier sends the resolved path.
const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'steward-outcome-')));
const entry = (overrides: Partial<LaunchEntry> = {}): LaunchEntry => ({
  issue: 'ELA-1', title: 'Requested report', source: 'telegram', command: 'say', status: 'merged', prNumber: 42,
  prUrl: 'https://github.com/example/repository/pull/42',
  ...overrides,
});

function fixture(dir: string, item = entry()) {
  const ledger = readLaunchLedger(dir);
  ledger.launches[item.issue] = item;
  saveLaunchLedger(dir, ledger);
  return ledger;
}

function worktree(dir: string) {
  return () => ({ exitCode: 0, stdout: `worktree ${dir}\nHEAD abcd\nbranch refs/heads/harness/report\n` });
}

test('completed (not merged) non-code run deploy-noncode ref sends exactly one allowed file to originating thread; duplicate report does not send again', async () => {
  const dir = root();
  const tree = join(dir, 'tree');
  const ref = 'out/report.md';
  mkdirSync(join(tree, 'out'), { recursive: true });
  writeFileSync(join(tree, ref), '# report');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId }));
  const files: string[] = [];
  const messages: string[] = [];
  const events = [
    { event: 'planned', data: { branch: 'harness/report', worktree: tree.slice(-40) } },
    { event: 'deploy-noncode', data: { ref, branch: 'harness/report' } },
    { event: 'run-status', data: { runStatus: 'completed' } },
  ];
  const steward = join(dir, 'steward');
  writeFileSync(join(steward, 'issues.json'), JSON.stringify([{ identifier: 'ELA-1', ref: 'one', title: 'Requested report', body: '' }]));
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const deps: StewardDeps = { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' as const },
    launchCommand: () => ({ exitCode: 0, stdout: events.map(e => JSON.stringify(e)).join('\n') }),
    sendDigest: async (text: string) => { messages.push(text); },
    outcomeNotify: { worktreeCommand: worktree(tree), document: (to, file, caption) => {
      expect(to).toMatchObject(origin); expect(caption).toBe('Requested report · 완료(병합 없음)'); files.push(file); return true;
    }, message: () => { throw new Error('unexpected link'); } },
  };
  try {
    await runStewardStage('report', deps);
    await runStewardStage('report', deps);
    expect(files).toEqual([join(tree, ref)]);
    expect(messages.filter(text => text.includes('Requested report · PR 없음'))).toEqual(['telegram · Requested report · PR 없음 · completed']);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ status: 'completed', notified: 'sent', notifyAttempts: 1, reported: true, artifactRef: ref, artifactWorktree: tree.slice(-40) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing, oversized, disallowed or escaped files fall back to PR link; no file is delivered', () => {
  const dir = root();
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  writeFileSync(join(tree, 'huge.md'), Buffer.alloc(20 * 1024 * 1024 + 1));
  writeFileSync(join(tree, 'tool.exe'), 'binary');
  writeFileSync(join(dir, 'outside.md'), 'outside');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  try {
    for (const ref of ['missing.md', 'huge.md', 'tool.exe', '../outside.md']) {
      const ledger = fixture(dir, entry({ artifactRef: ref, artifactBranch: 'harness/report' }));
      const links: string[] = [];
      expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, worktreeCommand: worktree(tree),
        document: () => { throw new Error('file sent'); }, message: (to, text) => {
          expect(to).toMatchObject(origin); links.push(text); return true;
        } })).toBe('sent');
      expect(links).toEqual(['Requested report · 병합됨 · PR 42 · https://github.com/example/repository/pull/42']);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a removed matching worktree does not hide an existing artifact in another matching worktree', () => {
  const dir = root();
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  writeFileSync(join(tree, 'report.md'), '# report');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  try {
    const ledger = fixture(dir, entry({ artifactRef: 'report.md', artifactBranch: 'harness/report' }));
    const files: string[] = [];
    const command = () => ({ exitCode: 0, stdout: `worktree ${join(dir, 'removed')}\nbranch refs/heads/harness/report\n\nworktree ${tree}\nbranch refs/heads/harness/report\n` });
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, worktreeCommand: command,
      document: (_to, file) => { files.push(file); return true; }, message: () => { throw new Error('missed file'); },
    })).toBe('sent');
    expect(files).toEqual([join(tree, 'report.md')]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a symlink outside the worktree is not delivered as a file', () => {
  const dir = root();
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  writeFileSync(join(dir, 'secret.md'), 'do not send');
  symlinkSync(join(dir, 'secret.md'), join(tree, 'report.md'));
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  try {
    const ledger = fixture(dir, entry({ artifactRef: 'report.md', artifactBranch: 'harness/report' }));
    const links: string[] = [];
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, worktreeCommand: worktree(tree),
      document: () => { throw new Error('escaped file sent'); }, message: (_to, text) => { links.push(text); return true; },
    })).toBe('sent');
    expect(links).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the planned worktree identity must match before an artifact can be sent', () => {
  const dir = root();
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  writeFileSync(join(tree, 'report.md'), '# report');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  try {
    const ledger = fixture(dir, entry({ artifactRef: 'report.md', artifactBranch: 'harness/report', artifactWorktree: 'another-worktree' }));
    const links: string[] = [];
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, worktreeCommand: worktree(tree),
      document: () => { throw new Error('wrong tree sent'); }, message: (_to, text) => { links.push(text); return true; },
    })).toBe('sent');
    expect(links).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed terminal reason reaches the original chat in one line', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const sent: string[] = [];
  try {
    await runStewardStage('report', { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
      launchCommand: () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'run-status', data: { runStatus: 'failed', reason: 'quota\nexhausted' } }) }),
      sendDigest: async () => {}, outcomeNotify: { message: (_to, text) => { sent.push(text); return true; } } });
    expect(sent).toEqual(['Requested report · 실패 — quota']);
    expect(readLaunchLedger(dir).launches['ELA-1']?.reason).toBe('quota\nexhausted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a completed non-code run with a PR event returns its file without waiting for a merge', async () => {
  const dir = root();
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  writeFileSync(join(tree, 'report.md'), '# report');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId }));
  const steward = join(dir, 'steward');
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const files: string[] = [];
  try {
    await runStewardStage('report', { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
      launchCommand: () => ({ exitCode: 0, stdout: [
        { event: 'pr-opened', data: { number: 42 } },
        { event: 'deploy-noncode', data: { ref: 'report.md', branch: 'harness/report' } },
        { event: 'run-status', data: { runStatus: 'completed' } },
      ].map(e => JSON.stringify(e)).join('\n') }), sendDigest: async () => {}, outcomeNotify: {
        worktreeCommand: worktree(tree), document: (_to, file) => { files.push(file); return true; },
        message: () => { throw new Error('expected file'); },
      } });
    expect(files).toEqual([join(tree, 'report.md')]);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ awaitingMerge: false, notified: 'sent' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a completed run that left no PR or file says so — it is not announced as a failure (round 3)', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId, prNumber: undefined }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const sent: string[] = [];
  try {
    await runStewardStage('report', { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
      launchCommand: () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'run-status', data: { runStatus: 'completed' } }) }),
      sendDigest: async () => {}, outcomeNotify: { message: (_to, text) => { sent.push(text); return true; } } });
    expect(sent).toEqual(['Requested report · 완료(병합 없음) — 남긴 파일·PR 없음']);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ status: 'completed', notified: 'sent' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a PR URL without a separate number still supplies the one-line PR number', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId, prNumber: undefined }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const sent: string[] = [];
  try {
    await runStewardStage('report', { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
      launchCommand: () => ({ exitCode: 0, stdout: [
        { event: 'pr-opened', data: { url: 'https://github.com/example/repository/pull/52' } },
        { event: 'merged', data: { merged: true } },
      ].map(e => JSON.stringify(e)).join('\n') }), sendDigest: async () => {},
      outcomeNotify: { message: (_to, text) => { sent.push(text); return true; } } });
    expect(sent).toEqual(['Requested report · 병합됨 · PR 52 · https://github.com/example/repository/pull/52']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('title and failure reason are redacted before sending and raw body is never included', () => {
  const dir = root();
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  const secret = `sk-${'X'.repeat(22)}`;
  try {
    const ledger = fixture(dir, entry({ status: 'failed', title: `Report ${secret}`, reason: `failed: ${secret}`, command: 'private body' }));
    const texts: string[] = [];
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, message: (_to, text) => { texts.push(text); return true; } })).toBe('sent');
    expect(texts).toEqual(['Report <redacted> · 실패 — failed: <redacted>']);
    expect(texts[0]).not.toContain('private body');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a run-ledger PR URL is preferred over a guessed repository link', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const sent: string[] = [];
  try {
    await runStewardStage('report', { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
      launchCommand: () => ({ exitCode: 0, stdout: [
        { event: 'pr-opened', data: { number: 42, url: 'https://github.com/example/other/pull/42' } },
        { event: 'merged', data: { number: 42, merged: true } },
      ].map(e => JSON.stringify(e)).join('\n') }), sendDigest: async () => {},
      outcomeNotify: { message: (_, text) => { sent.push(text); return true; } } });
    expect(sent).toEqual(['Requested report · 병합됨 · PR 42 · https://github.com/example/other/pull/42']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a PR number without a verified URL never invents a repository link', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const messages: string[] = [];
  try {
    await runStewardStage('report', { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
      launchCommand: () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'merged', data: { merged: true, number: 42 } }) }),
      sendDigest: async () => {}, outcomeNotify: { message: (_to, text) => { messages.push(text); return true; } } });
    expect(messages).toEqual(['Requested report · 병합됨 · 산출물 전달 불가 — 검증된 PR 링크가 없습니다']);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ prNumber: 42, notified: 'failed', notifyAttempts: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an oversized non-code artifact without PR is not treated as delivered', () => {
  const dir = root();
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  writeFileSync(join(tree, 'report.md'), Buffer.alloc(20 * 1024 * 1024 + 1));
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  try {
    const ledger = fixture(dir, entry({ prNumber: undefined, prUrl: undefined, artifactRef: 'report.md', artifactBranch: 'harness/report' }));
    const messages: string[] = [];
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, worktreeCommand: worktree(tree),
      document: () => { throw new Error('oversized file sent'); }, message: (_to, text) => { messages.push(text); return true; },
    })).toBe('failed');
    expect(messages).toEqual(['Requested report · 병합됨 · 산출물 전달 불가 — 파일을 확인할 수 없습니다']);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'failed', notifyAttempts: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing non-code artifact without PR is announced once and retried after the file returns', () => {
  const dir = root();
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  const ledger = fixture(dir, entry({ prNumber: undefined, prUrl: undefined, artifactRef: 'report.md', artifactBranch: 'harness/report' }));
  const messages: string[] = [];
  const files: string[] = [];
  const deps: OutcomeNotifyDeps = { root: dir, ledger, worktreeCommand: worktree(tree),
    document: (_to, file) => { files.push(file); return true; },
    message: (_to, text) => { messages.push(text); return true; } };
  try {
    expect(notifyOutcome(ledger.launches['ELA-1']!, deps)).toBe('failed');
    expect(notifyOutcome(ledger.launches['ELA-1']!, deps)).toBe('failed');
    expect(messages).toEqual(['Requested report · 병합됨 · 산출물 전달 불가 — 파일을 확인할 수 없습니다']);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'failed', notifyAttempts: 2 });
    writeFileSync(join(tree, 'report.md'), '# restored');
    expect(notifyOutcome(ledger.launches['ELA-1']!, deps)).toBe('sent');
    expect(notifyOutcome(ledger.launches['ELA-1']!, deps)).toBe('sent');
    expect(files).toEqual([join(tree, 'report.md')]);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'sent', notifyAttempts: 3 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no origin skips without sending; shadow records only preview; failed run sends a redacted one-line reason', () => {
  const dir = root();
  try {
    const ledger = fixture(dir);
    const never = () => { throw new Error('sent'); };
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, document: never, message: never,
      worktreeCommand: () => { throw new Error('no origin must not inspect worktrees'); } })).toBe('skipped-no-origin');
    saveDirectiveOrigin(dir, 'ELA-1', origin);
    ledger.launches['ELA-1'] = entry();
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, shadow: true, document: never, message: never })).toBe('shadow');
    expect(readLaunchLedger(dir).launches['ELA-1']?.notifyPreview).toEqual({ hasChatId: true, kind: 'link' });
    rmSync(join(dir, 'steward', 'origins', 'ELA-1.json'));
    ledger.launches['ELA-1'] = entry({ source: 'cli' });
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, shadow: true, document: never, message: never })).toBe('shadow');
    expect(readLaunchLedger(dir).launches['ELA-1']?.notifyPreview).toEqual({ hasChatId: false, kind: 'link' });
    saveDirectiveOrigin(dir, 'ELA-1', origin);
    ledger.launches['ELA-1'] = entry({ status: 'failed', reason: 'quota exhausted\nmore details' });
    const texts: string[] = [];
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, message: (_to, text) => { texts.push(text); return true; } })).toBe('sent');
    expect(texts).toEqual(['Requested report · 실패 — quota exhausted']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a saved Telegram origin routes even when the legacy issue source is not telegram', () => {
  const dir = root();
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  try {
    const ledger = fixture(dir, entry({ source: 'linear:ELA-1' }));
    const recipients: number[] = [];
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger,
      message: to => { recipients.push(to!.chatId!); return true; } })).toBe('sent');
    expect(recipients).toEqual([123]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shadow result previews an existing file and origin presence without sending', () => {
  const dir = root();
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  writeFileSync(join(tree, 'report.md'), '# report');
  try {
    const ledger = fixture(dir, entry({ artifactRef: 'report.md', artifactBranch: 'harness/report', source: 'cli' }));
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, shadow: true, worktreeCommand: worktree(tree),
      document: () => { throw new Error('shadow file sent'); }, message: () => { throw new Error('shadow link sent'); },
    })).toBe('shadow');
    expect(readLaunchLedger(dir).launches['ELA-1']?.notifyPreview).toEqual({ hasChatId: false, kind: 'file' });
    saveDirectiveOrigin(dir, 'ELA-1', origin);
    ledger.launches['ELA-1'] = entry({ artifactRef: 'report.md', artifactBranch: 'harness/report' });
    expect(notifyOutcome(ledger.launches['ELA-1']!, { root: dir, ledger, shadow: true, worktreeCommand: worktree(tree),
      document: () => { throw new Error('shadow file sent'); }, message: () => { throw new Error('shadow link sent'); },
    })).toBe('shadow');
    expect(readLaunchLedger(dir).launches['ELA-1']?.notifyPreview).toEqual({ hasChatId: true, kind: 'file' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI directive without origin keeps one landing digest and records skipped-no-origin', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  fixture(dir, entry({ source: 'cli', status: 'launched', runId }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const digests: string[] = [];
  try {
    const deps: StewardDeps = { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
      launchCommand: () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'merged', data: { merged: true, number: 42, url: 'https://github.com/example/repository/pull/42' } }) }),
      sendDigest: async text => { digests.push(text); }, outcomeNotify: {
        message: () => { throw new Error('CLI sent to Telegram'); }, document: () => { throw new Error('CLI sent file'); },
      } };
    await runStewardStage('report', deps);
    await runStewardStage('report', deps);
    expect(digests.filter(text => text.includes('PR 42'))).toEqual(['cli · Requested report · PR 42 · merged']);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'skipped-no-origin', reported: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shadow report records a no-send preview for an absent origin', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  fixture(dir, entry({ status: 'shadow' }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  try {
    await runStewardStage('report', { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'shadow' },
      sendDigest: async () => {}, outcomeNotify: { message: () => { throw new Error('shadow sent'); }, document: () => { throw new Error('shadow file'); } } });
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'shadow', notifyPreview: { hasChatId: false, kind: 'link' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reported outcome retries a false send next report without repeating digest, then succeeds', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ reported: true, notified: 'failed', notifyAttempts: 1 }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  let calls = 0;
  const digest: string[] = [];
  try {
    await runStewardStage('report', { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
      outcomeNotify: { message: () => { calls++; return true; } }, sendDigest: async text => { digest.push(text); } });
    expect(calls).toBe(1);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ reported: true, notified: 'sent', notifyAttempts: 2 });
    expect(digest.filter(text => text.includes('Requested report'))).toEqual([]);
    await runStewardStage('report', { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
      outcomeNotify: { message: () => { calls++; return true; } }, sendDigest: async text => { digest.push(text); } });
    expect(calls).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed first delivery survives a failing digest and retries on the following report', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  let sends = 0;
  let digests = 0;
  const deps: StewardDeps = { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
    launchCommand: () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'merged', data: { merged: true, number: 42, url: 'https://github.com/example/repository/pull/42' } }) }),
    sendDigest: async () => { if (++digests === 1) throw new Error('digest down'); },
    outcomeNotify: { message: () => ++sends === 2 },
  };
  try {
    await expect(runStewardStage('report', deps)).rejects.toThrow('digest down');
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'failed', notifyAttempts: 1 });
    await runStewardStage('report', deps);
    expect(sends).toBe(2);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'sent', notifyAttempts: 2, reported: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failing digest cannot suppress an origin send, and the next report does not repeat it', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const sent: string[] = [];
  let attempts = 0;
  const deps: StewardDeps = { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
    launchCommand: () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'merged', data: { merged: true, number: 42, url: 'https://github.com/example/repository/pull/42' } }) }),
    sendDigest: async () => { if (++attempts === 1) throw new Error('digest unavailable'); },
    outcomeNotify: { message: (_to, text) => { sent.push(text); return true; } },
  };
  try {
    await expect(runStewardStage('report', deps)).rejects.toThrow('digest unavailable');
    expect(sent).toHaveLength(1);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'sent' });
    expect(readLaunchLedger(dir).launches['ELA-1']?.reported).toBeUndefined();
    await runStewardStage('report', deps);
    expect(sent).toHaveLength(1);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'sent', reported: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an initially false report delivery is retried on the next tick, not twice in the same tick', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  let calls = 0;
  const digests: string[] = [];
  const deps: StewardDeps = { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
    launchCommand: () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'merged', data: { merged: true, number: 42, url: 'https://github.com/example/repository/pull/42' } }) }),
    sendDigest: async text => { digests.push(text); }, outcomeNotify: { message: () => ++calls === 2 },
  };
  try {
    await runStewardStage('report', deps);
    expect(calls).toBe(1);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'failed', notifyAttempts: 1, reported: true });
    await runStewardStage('report', deps);
    expect(calls).toBe(2);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'sent', notifyAttempts: 2 });
    expect(digests.filter(text => text.includes('PR 42'))).toEqual(['telegram · Requested report · PR 42 · merged']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two distinct directive conversations each receive one result; a failed recipient alone retries', () => {
  const dir = root();
  const other = { channel: 'telegram' as const, chatId: 456, botId: '987', threadId: 8 };
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  saveDirectiveOrigin(dir, 'ELA-1', other);
  saveDirectiveOrigin(dir, 'ELA-1', other);
  try {
    const ledger = fixture(dir);
    const sent: number[] = [];
    let otherAttempts = 0;
    const deps: OutcomeNotifyDeps = { root: dir, ledger, message: to => {
      sent.push(to!.chatId!);
      return to!.chatId !== other.chatId || ++otherAttempts > 1;
    } };
    expect(notifyOutcome(ledger.launches['ELA-1']!, deps)).toBe('failed');
    expect(sent).toEqual([origin.chatId, other.chatId]);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'failed', notifyAttempts: 1 });
    expect(notifyOutcome(ledger.launches['ELA-1']!, deps)).toBe('sent');
    expect(notifyOutcome(ledger.launches['ELA-1']!, deps)).toBe('sent');
    expect(sent).toEqual([origin.chatId, other.chatId, other.chatId]);
    expect(Object.values(readLaunchLedger(dir).launches['ELA-1']!.notifyRecipients!)).toEqual([
      { notified: 'sent', attempts: 1 }, { notified: 'sent', attempts: 2 },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a repeated conversation registered after the first report receives the result on the next report only once', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const sent: number[] = [];
  const deps: StewardDeps = { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
    launchCommand: () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'merged', data: { merged: true, number: 42, url: 'https://github.com/example/repository/pull/42' } }) }),
    sendDigest: async () => {}, outcomeNotify: { message: to => { sent.push(to!.chatId!); return true; } } };
  try {
    await runStewardStage('report', deps);
    saveDirectiveOrigin(dir, 'ELA-1', { chatId: 456, botId: '987', threadId: 8 });
    await runStewardStage('report', deps);
    await runStewardStage('report', deps);
    expect(sent).toEqual([123, 456]);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ notified: 'sent', reported: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an origin arriving after skipped-no-origin is still notified on a later report', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  fixture(dir, entry({ status: 'launched', runId }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const sent: number[] = [];
  const deps: StewardDeps = { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' },
    launchCommand: () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'merged', data: { merged: true, number: 42, url: 'https://github.com/example/repository/pull/42' } }) }),
    sendDigest: async () => {}, outcomeNotify: { message: to => { sent.push(to!.chatId!); return true; } } };
  try {
    await runStewardStage('report', deps);
    expect(readLaunchLedger(dir).launches['ELA-1']?.notified).toBe('skipped-no-origin');
    saveDirectiveOrigin(dir, 'ELA-1', origin);
    await runStewardStage('report', deps);
    await runStewardStage('report', deps);
    expect(sent).toEqual([123]);
    expect(readLaunchLedger(dir).launches['ELA-1']?.notified).toBe('sent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('false delivery retries on following ticks only and stops after three; successful delivery stays once', () => {
  const dir = root();
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  try {
    const ledger = fixture(dir);
    let calls = 0;
    const deps = { root: dir, ledger, message: () => { calls++; return false; } };
    for (let n = 1; n <= 3; n++) {
      expect(notifyOutcome(ledger.launches['ELA-1']!, deps)).toBe('failed');
      expect(readLaunchLedger(dir).launches['ELA-1']?.notifyAttempts).toBe(n);
    }
    expect(notifyOutcome(ledger.launches['ELA-1']!, deps)).toBe('failed');
    expect(calls).toBe(3);
    ledger.launches['ELA-1'] = entry();
    const succeeds = { root: dir, ledger, message: () => { calls++; return true; } };
    expect(notifyOutcome(ledger.launches['ELA-1']!, succeeds)).toBe('sent');
    expect(notifyOutcome(ledger.launches['ELA-1']!, succeeds)).toBe('sent');
    expect(calls).toBe(4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a finished run whose PR waits for merge sends the PR link to the wish chat once — merge later does not resend (round 3)', async () => {
  const dir = root();
  const steward = join(dir, 'steward');
  saveDirectiveOrigin(dir, 'ELA-1', origin);
  fixture(dir, entry({ status: 'launched', runId, prNumber: undefined }));
  writeFileSync(join(steward, 'issues.json'), '[]');
  writeFileSync(join(steward, 'schedule.json'), '[]');
  const sent: string[] = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [
    { event: 'pr-opened', data: { number: 61, url: 'https://github.com/example/repository/pull/61' } },
    { event: 'run-status', data: { runStatus: 'completed' } },
  ];
  const deps = { root: dir, getSecret: async () => 'key', launchSettings: { launch: 'live' as const },
    launchCommand: () => ({ exitCode: 0, stdout: events.map(e => JSON.stringify(e)).join('\n') }),
    sendDigest: async () => {}, outcomeNotify: { message: (_to: unknown, text: string) => { sent.push(text); return true; } } };
  try {
    await runStewardStage('report', deps);
    await runStewardStage('report', deps);
    expect(sent).toEqual(['Requested report · PR 열림(병합 대기) · PR 61 · https://github.com/example/repository/pull/61']);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ status: 'running', awaitingMerge: true, notified: 'sent' });
    events.push({ event: 'merged', data: { number: 61, merged: true } });
    await runStewardStage('report', deps);
    expect(sent).toHaveLength(1);
    expect(readLaunchLedger(dir).launches['ELA-1']).toMatchObject({ status: 'merged', reported: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
