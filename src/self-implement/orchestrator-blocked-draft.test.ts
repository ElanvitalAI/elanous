import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runSelfImplement, type SelfImplementSeams } from './orchestrator.js';
import { seams } from './test-seams.js';

test('quota-exhausted blocked run preserves its branch without opening a draft; implementation deficit still opens one', async () => {
  const original = debug.log;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const openings: string[] = [];
  const pushes: string[] = [];
  const artifacts: string[] = [];
  const messages: string[] = [];
  (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
    events.push({ event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  try {
    const common = {
      preservationHasChanges: () => true,
      persistPrBodyArtifact: ({ body }: { body: string }) => { artifacts.push(body); return { path: '/tmp/blocked-verdict.md' }; },
      preserveBlockedBranch: async ({ branch }: { branch: string }) => { pushes.push(branch); return true; },
      openPr: async ({ head }: { head: string }) => { openings.push(head); return { url: `https://pr/${head}`, number: 7 }; },
      onProgress: ({ message }: { message: string }) => { messages.push(message); },
    };
    const quota = await runSelfImplement({
      feature: 'quota stopped work', maxReworkRounds: 0,
      seams: seams({
        ...common,
        inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 2, currentReached: true })) as SelfImplementSeams['inspectCodexRotation'],
        gate: async () => ({ passed: false, log: 'quota stopped gate' }),
      }),
    });
    expect(quota.abandonedClassification?.classification).toBe('quota-exhausted');
    expect(openings).toHaveLength(0);
    expect(pushes).toEqual([quota.branch!]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toContain('quota stopped gate');
    expect(messages.some((message) => message.startsWith(`환경 탓 중단 — draft PR 없이 브랜치만 보존: ${quota.branch} · 중단 사유 보존`))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-blocked-draft-pr', data: expect.objectContaining({ skipped: 'environment-stop', classification: 'quota-exhausted', branch: quota.branch, pushed: true }) }));

    const implementation = await runSelfImplement({
      feature: 'implementation stopped work', maxReworkRounds: 0,
      seams: seams({ ...common, gate: async () => ({ passed: false, log: 'implementation stopped gate' }) }),
    });
    expect(implementation.abandonedClassification?.classification).toBe('implementation-deficit');
    expect(openings).toEqual([implementation.branch!]);
    expect(pushes).toHaveLength(1);
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
});

test('no changes takes precedence over environment branch preservation', async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const original = debug.log;
  let pushes = 0;
  let openings = 0;
  (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
    events.push({ event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  try {
    await runSelfImplement({
      feature: 'quota stopped without changes', maxReworkRounds: 0,
      seams: seams({
        inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 2, currentReached: true })) as SelfImplementSeams['inspectCodexRotation'],
        gate: async () => ({ passed: false, log: 'quota stopped gate' }),
        preservationHasChanges: () => false,
        preserveBlockedBranch: async () => { pushes++; return true; },
        openPr: async () => { openings++; return { url: 'https://pr/unexpected', number: 7 }; },
      }),
    });
    expect(pushes).toBe(0);
    expect(openings).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-blocked-draft-pr', data: expect.objectContaining({ skipped: 'no-changes', classification: 'quota-exhausted' }) }));
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
});

test('worktree-only keeps its existing artifact-only route for a non-environment stop', async () => {
  const original = debug.log;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let opened = 0;
  let pushes = 0;
  let artifacts = 0;
  (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
    events.push({ event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  try {
    const result = await runSelfImplement({
      feature: 'worktree-only implementation stop', completion: 'worktree-only', maxReworkRounds: 0,
      seams: seams({
        gate: async () => ({ passed: false, log: 'gate failed' }),
        preservationHasChanges: () => true,
        persistPrBodyArtifact: () => { artifacts++; return { path: '/tmp/blocked-worktree-body.md' }; },
        preserveBlockedBranch: async () => { pushes++; return true; },
        openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 7 }; },
      }),
    });
    expect(result.abandonedClassification?.classification).toBe('implementation-deficit');
    expect({ opened, pushes, artifacts }).toEqual({ opened: 0, pushes: 0, artifacts: 1 });
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-blocked-draft-pr', data: expect.objectContaining({ skipped: 'worktree-only', prBodyArtifactPath: '/tmp/blocked-worktree-body.md' }) }));
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
});

test('worktree-only environment stop never pushes, even when an origin exists', async () => {
  const original = debug.log;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let pushed = 0;
  let opened = 0;
  let artifactOrigin: string | undefined;
  (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
    events.push({ event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  try {
    const result = await runSelfImplement({
      feature: 'worktree-only quota stop', completion: 'worktree-only', maxReworkRounds: 0,
      seams: seams({
        inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 2, currentReached: true })) as SelfImplementSeams['inspectCodexRotation'],
        gate: async () => ({ passed: false, log: 'quota stopped gate' }),
        preservationHasChanges: () => true,
        persistPrBodyArtifact: ({ origin }) => { artifactOrigin = origin; return { path: '/tmp/blocked-worktree-quota.md' }; },
        preserveBlockedBranch: async () => { pushed++; return true; },
        openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 7 }; },
      }),
    });
    expect(result.abandonedClassification?.classification).toBe('quota-exhausted');
    expect({ pushed, opened, artifactOrigin }).toEqual({ pushed: 0, opened: 0, artifactOrigin: 'self-implement-blocked-draft-pr-worktree-only' });
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-blocked-draft-pr', data: expect.objectContaining({ skipped: 'worktree-only', prBodyArtifactPath: '/tmp/blocked-worktree-quota.md' }) }));
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
});

test('failed environment push is reported to the caller and never presented as preserved', async () => {
  const original = debug.log;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const messages: string[] = [];
  let opened = 0;
  (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
    events.push({ event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  try {
    await expect(runSelfImplement({
      feature: 'failed quota branch push', maxReworkRounds: 0,
      seams: seams({
        inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 2, currentReached: true })) as SelfImplementSeams['inspectCodexRotation'],
        gate: async () => ({ passed: false, log: 'quota stopped gate' }),
        preservationHasChanges: () => true,
        persistPrBodyArtifact: () => ({ path: '/tmp/blocked-push-failure.md' }),
        preserveBlockedBranch: async () => { throw new Error('remote rejected'); },
        openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 7 }; },
        onProgress: ({ message }) => { messages.push(message); },
      }),
    })).rejects.toThrow('원격 브랜치 보존 실패');
    expect(opened).toBe(0);
    expect(messages.some((message) => message.includes('원격 브랜치 보존 실패') && message.includes('remote rejected'))).toBe(true);
    expect(messages.some((message) => message.includes('draft PR 없이 브랜치만 보존:'))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-blocked-draft-pr', data: expect.objectContaining({ skipped: 'environment-stop', pushed: false, pushError: 'remote rejected', prBodyArtifactPath: '/tmp/blocked-push-failure.md' }) }));
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
});

test('missing worktree keeps provider attribution and reports failed preservation without a draft', async () => {
  const original = debug.log;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const messages: string[] = [];
  let opened = 0;
  (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
    events.push({ event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  try {
    const result = await runSelfImplement({
      feature: 'missing environment worktree', maxReworkRounds: 0,
      seams: seams({
        createWorktree: async ({ branch }) => ({ path: join(tmpdir(), `nonexistent-${branch}`), branch, resolvedBase: 'a'.repeat(40) }),
        inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 2, currentReached: true })) as SelfImplementSeams['inspectCodexRotation'],
        gate: async () => ({ passed: false, log: 'quota stopped gate' }),
        preservationHasChanges: () => true,
        persistPrBodyArtifact: () => ({ path: '/tmp/blocked-missing-worktree.md' }),
        openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 7 }; },
        onProgress: ({ message }) => { messages.push(message); },
      }),
    });
    expect(result.abandonedClassification?.classification).toBe('quota-exhausted');
    expect(opened).toBe(0);
    expect(messages.some((message) => message.includes('워크트리 부재로 보존 실패'))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-blocked-draft-pr', data: expect.objectContaining({ skipped: 'environment-stop', pushed: false, preservationErrorStep: 'worktree' }) }));
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
});

test('environment stop without origin commits changes on the local branch for checkout recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'blocked-no-origin-'));
  const repo = join(root, 'repo');
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const original = debug.log;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const messages: string[] = [];
  try {
    git(root, 'init', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'checkout', '-b', 'self-impl/local-only');
    writeFileSync(join(repo, 'change.ts'), 'export const local = true;\n');
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    let opened = 0;
    const result = await runSelfImplement({
      feature: 'local quota stop', maxReworkRounds: 0,
      seams: seams({
        createWorktree: async () => ({ path: repo, branch: 'self-impl/local-only', resolvedBase: git(repo, 'rev-parse', 'main') }),
        inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 2, currentReached: true })) as SelfImplementSeams['inspectCodexRotation'],
        gate: async () => ({ passed: false, log: 'quota stopped gate' }),
        preservationHasChanges: () => true,
        persistPrBodyArtifact: () => ({ path: '/tmp/blocked-local-only.md' }),
        openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 7 }; },
        onProgress: ({ message }) => { messages.push(message); },
      }),
    });
    expect(result.abandonedClassification?.classification).toBe('quota-exhausted');
    expect(opened).toBe(0);
    expect(git(repo, 'status', '--short')).toBe('');
    expect(git(repo, 'show', 'self-impl/local-only:change.ts')).toContain('local = true');
    expect(git(repo, 'rev-list', '--count', 'main..self-impl/local-only')).toBe('1');
    git(repo, 'checkout', 'main');
    git(repo, 'checkout', 'self-impl/local-only');
    expect(git(repo, 'show', 'HEAD:change.ts')).toContain('local = true');
    expect(messages.some((message) => message.includes('로컬 브랜치만 보존(원격 origin 없음)') && message.includes('self-impl/local-only'))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-blocked-draft-pr', data: expect.objectContaining({ skipped: 'environment-stop', pushed: false, branch: 'self-impl/local-only', committed: true }) }));
  } finally {
    (debug as { log: typeof debug.log }).log = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test('environment branch is committed and pushed to an existing origin without opening a PR', async () => {
  const root = mkdtempSync(join(tmpdir(), 'blocked-environment-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const original = debug.log;
  try {
    git(root, 'init', '-b', 'main', repo);
    git(root, 'init', '--bare', remote);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'checkout', '-b', 'self-impl/blocked-environment');
    writeFileSync(join(repo, 'change.ts'), 'export const preserved = true;\n');
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    let opened = 0;
    const result = await runSelfImplement({
      feature: 'environment branch push', maxReworkRounds: 0,
      seams: seams({
        createWorktree: async () => ({ path: repo, branch: 'self-impl/blocked-environment', resolvedBase: git(repo, 'rev-parse', 'main') }),
        inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 2, currentReached: true })) as SelfImplementSeams['inspectCodexRotation'],
        gate: async () => ({ passed: false, log: 'quota stopped gate' }),
        preservationHasChanges: () => true,
        persistPrBodyArtifact: () => ({ path: '/tmp/blocked-environment-body.md' }),
        openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 7 }; },
      }),
    });
    expect(result.abandonedClassification?.classification).toBe('quota-exhausted');
    expect(opened).toBe(0);
    expect(git(repo, 'ls-remote', '--heads', 'origin', 'self-impl/blocked-environment').split('\t')[0]).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(git(repo, 'show', 'HEAD:change.ts')).toContain('preserved = true');
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-blocked-draft-pr', data: expect.objectContaining({ skipped: 'environment-stop', pushed: true }) }));

    const remoteHead = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'worktree-only.ts'), 'export const local = true;\n');
    const local = await runSelfImplement({
      feature: 'worktree-only quota stop with origin', completion: 'worktree-only', maxReworkRounds: 0,
      seams: seams({
        createWorktree: async () => ({ path: repo, branch: 'self-impl/blocked-environment', resolvedBase: git(repo, 'rev-parse', 'main') }),
        inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 2, currentReached: true })) as SelfImplementSeams['inspectCodexRotation'],
        gate: async () => ({ passed: false, log: 'quota stopped gate' }),
        preservationHasChanges: () => true,
        persistPrBodyArtifact: () => ({ path: '/tmp/blocked-worktree-quota.md' }),
        openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 7 }; },
      }),
    });
    expect(local.abandonedClassification?.classification).toBe('quota-exhausted');
    expect(opened).toBe(0);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(git(repo, 'ls-remote', '--heads', 'origin', 'self-impl/blocked-environment').split('\t')[0]).toBe(remoteHead);
    expect(git(repo, 'status', '--short')).toContain('worktree-only.ts');
    expect(events).toContainEqual(expect.objectContaining({ event: 'rework-blocked-draft-pr', data: expect.objectContaining({ skipped: 'worktree-only', prBodyArtifactPath: '/tmp/blocked-worktree-quota.md' }) }));
  } finally {
    (debug as { log: typeof debug.log }).log = original;
    rmSync(root, { recursive: true, force: true });
  }
});
