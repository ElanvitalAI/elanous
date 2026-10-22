import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runSelfImplement, type SelfImplementSeams } from './orchestrator.js';
import { seams } from './test-seams.js';
import { createTempGitRemote } from '../ux-sim/temp-git-remote.js';
import { createFakeBins } from '../ux-sim/fake-bin.js';

const codexNoCandidateSeams = (): Pick<SelfImplementSeams, 'currentProviderName' | 'inspectCodexRotation'> => ({
  currentProviderName: () => 'openai-codex',
  inspectCodexRotation: (() => ({
    reason: 'no-candidate',
    candidateCount: 0,
    knownAccountCount: 2,
    currentReached: true,
  })) as SelfImplementSeams['inspectCodexRotation'],
});

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
        ...codexNoCandidateSeams(),
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
        ...codexNoCandidateSeams(),
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

test('non-Codex provider does not treat a Codex rotation snapshot as quota exhaustion', async () => {
  let opened = 0;
  let preserved = 0;
  const result = await runSelfImplement({
    feature: 'grok implementation stopped work', maxReworkRounds: 0,
    seams: seams({
      currentProviderName: () => 'grok',
      inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 2, currentReached: true })) as SelfImplementSeams['inspectCodexRotation'],
      gate: async () => ({ passed: false, log: 'implementation stopped gate' }),
      preservationHasChanges: () => true,
      preserveBlockedBranch: async () => { preserved++; return true; },
      openPr: async () => { opened++; return { url: 'https://pr/implementation', number: 8 }; },
    }),
  });
  expect(result.abandonedClassification?.classification).toBe('implementation-deficit');
  expect(result.quotaExhaustionAssessment?.exhausted).toBeUndefined();
  expect(opened).toBe(1);
  expect(preserved).toBe(0);
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
        ...codexNoCandidateSeams(),
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
        ...codexNoCandidateSeams(),
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
        ...codexNoCandidateSeams(),
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
        ...codexNoCandidateSeams(),
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
        ...codexNoCandidateSeams(),
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
        ...codexNoCandidateSeams(),
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
}, 60_000);

// REPAIR-BLOCKED-DRAFT-LINK-ORIGINAL — commit-only 수리 런(base = 합성 로컬 가지 pr-<N>)이 리뷰 FAIL 로 멈추면
// 새 draft PR 을 열지 않고(origin 에 pr-<N> 이 없어 반드시 실패했다) 수확 가지를 원 PR #N 에 코멘트로 잇는다.
test('repair run on synthetic base pr-123 blocked by review links its salvage ref to PR #123 without opening a PR', async () => {
  const fixture = createTempGitRemote();
  const fakeBins = createFakeBins({ gh: { stdout: 'https://github.com/o/r/pull/123#issuecomment-1\n' } });
  const original = debug.log;
  const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const openings: Array<{ head: string; base?: string }> = [];
  try {
    const repo = fixture.checkout;
    const branch = 'self-impl/pr-123-head-abc-r1234ab';
    fixture.git(repo, ['config', 'user.email', 'test@example.com']);
    fixture.git(repo, ['config', 'user.name', 'Test']);
    fixture.git(repo, ['checkout', '-b', branch]);
    writeFileSync(join(repo, 'repair.ts'), 'export const repaired = true;\n');
    process.env.ELANOUS_SUBSTRATE = 'pod';
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    const result = await runSelfImplement({
      feature: '기존 PR #123 수리', base: 'pr-123', completion: 'worktree-only', maxReworkRounds: 0, memory: false,
      seams: seams({
        createWorktree: async () => ({ path: repo, branch, resolvedBase: fixture.git(repo, ['rev-parse', 'main']) }),
        preservationHasChanges: () => true,
        persistPrBodyArtifact: () => ({ path: '/tmp/repair-link-body.md' }),
        reviewDiff: async () => ({ verdict: 'fail', mustFix: ['must A'], shouldFix: [], reviewed: true, summary: 'blocked' }),
        openPr: async ({ head, base }) => { openings.push({ head, ...(base ? { base } : {}) }); throw new Error('base 브랜치 pr-123 가 origin 에 없다'); },
        postPrComment: async ({ number, body, cwd }) => {
          const posted = spawnSync('gh', ['pr', 'comment', String(number), '--body', body], { cwd, env: fakeBins.env, encoding: 'utf8' });
          if (posted.status !== 0) throw new Error(posted.stderr);
        },
      }),
    });
    expect(openings).toHaveLength(0);
    const salvageRef = result.salvageRef!;
    expect(result.originalPr).toBe(123);
    expect(salvageRef).toMatch(/^salvage\/run-[0-9a-f]{6}\/self-impl-pr-123-head-abc-r1234ab$/);
    const head = fixture.git(repo, ['rev-parse', 'HEAD']);
    expect(fixture.git(repo, ['ls-remote', '--heads', 'origin', salvageRef]).split('\t')[0]).toBe(head);
    expect(fixture.git(repo, ['ls-remote', '--heads', 'origin', branch])).toBe('');
    const comments = fakeBins.calls().filter((call) => call.name === 'gh');
    expect(comments).toHaveLength(1);
    expect(comments[0]!.argv.slice(0, 3)).toEqual(['pr', 'comment', '123']);
    expect(comments[0]!.argv[4]).toContain(`수리 산출물 salvage ${salvageRef}`);
    expect(events).toContainEqual(expect.objectContaining({ event: 'start', data: expect.objectContaining({ repairCommitOnly: 123, openPr: false }) }));
    const linked = events.find((entry) => entry.event === 'rework-blocked-draft-pr' && entry.data.skipped === 'repair-link-original');
    expect(linked?.data).toMatchObject({ originalPr: 123, salvageRef, salvageSha: head, pushed: true, commentPosted: true });
    // L2 영수증 — 관측 원문(fixture 런)을 시험 출력에 남긴다.
    console.log(`[repair-link-original] ${JSON.stringify({ openPrCalls: openings.length, ghCalls: comments.map((call) => call.argv), observation: { skipped: linked?.data.skipped, originalPr: linked?.data.originalPr, salvageRef: linked?.data.salvageRef, salvageSha: linked?.data.salvageSha, pushed: linked?.data.pushed, commentPosted: linked?.data.commentPosted }, result: { stage: result.stage, originalPr: result.originalPr, salvageRef: result.salvageRef } })}`);
  } finally {
    (debug as { log: typeof debug.log }).log = original;
    if (previousSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = previousSubstrate;
    fakeBins.cleanup();
    fixture.cleanup();
  }
}, 60_000);

test('needs-owner-only harvestable stop on pr-<N> base still links the original PR (not the draft-not-archive salvage path)', async () => {
  const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
  delete process.env.ELANOUS_SUBSTRATE;
  const pushes: string[] = [];
  const comments: Array<{ number: number; body: string }> = [];
  let opened = 0;
  try {
    const result = await runSelfImplement({
      feature: '기존 PR #45 수리', base: 'pr-45', maxReworkRounds: 0, memory: false,
      seams: seams({
        draftOnStopMode: () => 'needs-owner-only',
        gate: async () => ({ passed: false, log: 'implementation stopped gate' }),
        preservationHasChanges: () => true,
        persistPrBodyArtifact: () => ({ path: '/tmp/repair-link-needs-owner.md' }),
        preserveBlockedBranch: async ({ branch }) => { pushes.push(branch); return true; },
        openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 7 }; },
        postPrComment: async ({ number, body }) => { comments.push({ number, body }); },
      }),
    });
    expect(result.abandonedClassification?.classification).toBe('implementation-deficit');
    expect(opened).toBe(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatch(/^salvage\/run-[0-9a-f]{6}\//);
    expect(comments).toEqual([{ number: 45, body: expect.stringContaining(`수리 산출물 salvage ${pushes[0]}`) }]);
  } finally {
    if (previousSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = previousSubstrate;
  }
});

test('failed salvage push on pr-<N> base opens no PR, posts no comment, and reports no salvageRef', async () => {
  const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
  process.env.ELANOUS_SUBSTRATE = 'pod';
  const original = debug.log;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let opened = 0;
  let commented = 0;
  (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
    events.push({ event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  try {
    const result = await runSelfImplement({
      feature: '기존 PR #46 수리', base: 'pr-46', completion: 'worktree-only', maxReworkRounds: 0, memory: false,
      seams: seams({
        preservationHasChanges: () => true,
        persistPrBodyArtifact: () => ({ path: '/tmp/repair-link-push-failed.md' }),
        reviewDiff: async () => ({ verdict: 'fail', mustFix: ['must A'], shouldFix: [], reviewed: true, summary: 'blocked' }),
        preserveBlockedBranch: async () => false,
        openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 7 }; },
        postPrComment: async () => { commented++; },
      }),
    });
    expect({ opened, commented }).toEqual({ opened: 0, commented: 0 });
    expect(result.originalPr).toBeUndefined();
    expect(result.salvageRef).toBeUndefined();
    expect(result.detail).toContain('수확 가지 push 실패');
    const linked = events.find((entry) => entry.event === 'rework-blocked-draft-pr' && entry.data.skipped === 'repair-link-original');
    expect(linked?.data).toMatchObject({ originalPr: 46, pushed: false, commentPosted: false });
  } finally {
    (debug as { log: typeof debug.log }).log = original;
    if (previousSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = previousSubstrate;
  }
});
