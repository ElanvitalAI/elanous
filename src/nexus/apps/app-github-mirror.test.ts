import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGh } from '../../ux-sim/fake-gh.js';
import { createFakeCred } from '../../ux-sim/fake-cred.js';
import { createTempGitRemote } from '../../ux-sim/temp-git-remote.js';
import { createAppGithubMirror, scanLocalGitHistory, isMirrorGitConfigSafe } from './app-github-mirror.js';

const REPOSITORY = 'owner/notes';
const TOKEN = 'fake-scoped-token';

function commit(fixture: ReturnType<typeof createTempGitRemote>, content: string): void {
  writeFileSync(join(fixture.checkout, 'README.md'), content);
  fixture.git(fixture.checkout, ['add', 'README.md']);
  fixture.git(fixture.checkout, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'change']);
}

test('first push exports complete reachable history and later pushes mirror only one way', async () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    const gh = createFakeGh({ prs: [], repository: REPOSITORY, tokens: [{ id: TOKEN, repository: REPOSITORY, permission: 'contents:write' }] });
    const cred = createFakeCred({ now: () => 1_000 });
    const lease = cred.install('cred:openai.api_key', { permissions: ['push'], expiresAt: 2_000 });
    const mirror = createAppGithubMirror({
      readToken: async () => cred.use(lease, 'push').ok ? { repository: REPOSITORY, token: TOKEN } : undefined,
      scanHistory: (sourceRepo, token) => scanLocalGitHistory(sourceRepo, token),
      push: async ({ token, expectedBefore }) => {
        if (expectedBefore !== undefined) expect(expectedBefore)
          .toBe(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']));
        return gh.pushWithToken(token, fixture);
      },
    });
    commit(fixture, 'first export\n');
    const first = await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: fixture.checkout });
    expect(first).toMatchObject({ ok: true, kind: 'export' });
    expect(gh.webhooks).toHaveLength(1);
    expect(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']))
      .toBe(fixture.git(fixture.checkout, ['rev-parse', 'HEAD']));
    commit(fixture, 'second mirror\n');
    const second = await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: fixture.checkout,
      previousHead: first.ok ? first.after : undefined });
    expect(second).toMatchObject({ ok: true, kind: 'mirror' });
    expect(gh.webhooks).toHaveLength(2);
  } finally { fixture.cleanup(); }
});

test('a commit added after scanning cannot replace the pinned source head', async () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    commit(fixture, 'scanned revision\n');
    const scannedHead = fixture.git(fixture.checkout, ['rev-parse', 'HEAD']);
    const before = fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']);
    const mirror = createAppGithubMirror({ readToken: async () => ({ repository: REPOSITORY, token: TOKEN }),
      scanHistory: (sourceRepo, token) => {
        const scan = scanLocalGitHistory(sourceRepo, token);
        commit(fixture, 'ELANOUS_CANARY_V1 added after scan\n');
        return scan;
      },
      push: async ({ sourceHead }) => {
        expect(sourceHead).toBe(scannedHead);
        fixture.git(fixture.checkout, ['push', fixture.remote, `${sourceHead}:refs/heads/main`]);
        return { ok: true, before, after: sourceHead };
      },
    });
    expect(await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: fixture.checkout }))
      .toMatchObject({ ok: true, after: scannedHead });
    expect(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main'])).toBe(scannedHead);
    expect(fixture.git(fixture.checkout, ['rev-parse', 'HEAD'])).not.toBe(scannedHead);
  } finally { fixture.cleanup(); }
});

test('short registered tokens in old history are still detected', () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    commit(fixture, 'tiny-token\n');
    commit(fixture, 'clean current tree\n');
    expect(scanLocalGitHistory(fixture.checkout, 'tiny-token').verdict).toBe('leaked');
  } finally { fixture.cleanup(); }
});

test('UTF-8 token bytes in old history block export', () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    commit(fixture, 'clé-secrète\n');
    commit(fixture, 'clean current tree\n');
    expect(scanLocalGitHistory(fixture.checkout, 'clé-secrète').verdict).toBe('leaked');
  } finally { fixture.cleanup(); }
});

test('a local Git proxy or disabled TLS verification makes HTTPS transport unsafe', () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    expect(isMirrorGitConfigSafe(fixture.checkout)).toBe(true);
    fixture.git(fixture.checkout, ['config', '--local', 'http.proxy', 'http://proxy.invalid']);
    expect(isMirrorGitConfigSafe(fixture.checkout)).toBe(false);
    fixture.git(fixture.checkout, ['config', '--local', '--unset', 'http.proxy']);
    fixture.git(fixture.checkout, ['config', '--local', 'http.sslVerify', 'false']);
    expect(isMirrorGitConfigSafe(fixture.checkout)).toBe(false);
  } finally { fixture.cleanup(); }
});

test('default transport stages only the scanned commit despite source config and orphan changes', async () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  const shimDir = mkdtempSync(join(tmpdir(), 'mirror-git-shim-'));
  const previousPath = process.env.PATH;
  try {
    commit(fixture, 'safe export\n');
    const orphanFile = join(fixture.root, 'orphan');
    writeFileSync(orphanFile, 'orphan object outside scanned refs\n');
    const orphan = fixture.git(fixture.checkout, ['hash-object', '-w', orphanFile]);
    const shim = join(shimDir, 'git');
    const log = join(shimDir, 'transport-repo');
    writeFileSync(shim, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = fetch ]; then
    /usr/bin/git "$@" || exit $?
    /usr/bin/git -C "$MIRROR_TEST_SOURCE" config --local http.proxy http://interceptor.invalid
    exit $?
  fi
  if [ "$arg" = push ]; then
    /usr/bin/git -C "$2" cat-file -e "$MIRROR_TEST_ORPHAN" && exit 4
    printf '%s' "$2" > "$MIRROR_TEST_LOG"
    exit 0
  fi
done
exec /usr/bin/git "$@"
`, { mode: 0o700 });
    chmodSync(shim, 0o700);
    process.env.PATH = `${shimDir}:${previousPath ?? ''}`;
    process.env.MIRROR_TEST_SOURCE = fixture.checkout;
    process.env.MIRROR_TEST_LOG = log;
    process.env.MIRROR_TEST_ORPHAN = orphan;
    const mirror = createAppGithubMirror({ readToken: async () => ({ repository: REPOSITORY, token: TOKEN }) });
    const outcome = await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: fixture.checkout });
    expect(outcome).toMatchObject({ ok: true, kind: 'export', after: fixture.git(fixture.checkout, ['rev-parse', 'HEAD']) });
    expect(isMirrorGitConfigSafe(fixture.checkout)).toBe(false);
    expect(readFileSync(log, 'utf8')).not.toBe(fixture.checkout);
    expect(readFileSync(log, 'utf8')).toContain('staging.git');
  } finally {
    process.env.PATH = previousPath;
    delete process.env.MIRROR_TEST_SOURCE;
    delete process.env.MIRROR_TEST_LOG;
    delete process.env.MIRROR_TEST_ORPHAN;
    fixture.cleanup();
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test('default Git transport performs first export, leased mirror, and rejects a changed remote', async () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  const shimDir = mkdtempSync(join(tmpdir(), 'mirror-git-remote-'));
  const previousPath = process.env.PATH;
  try {
    const shim = join(shimDir, 'git');
    writeFileSync(shim, `#!/bin/bash
args=("$@")
for i in "\${!args[@]}"; do
  if [[ "\${args[$i]}" == "https://github.com/${REPOSITORY}.git" ]]; then
    args[$i]="$MIRROR_TEST_REMOTE"
  fi
done
GIT_ALLOW_PROTOCOL=file exec /usr/bin/git "\${args[@]}"
`, { mode: 0o700 });
    chmodSync(shim, 0o700);
    process.env.PATH = `${shimDir}:${previousPath ?? ''}`;
    process.env.MIRROR_TEST_REMOTE = fixture.remote;
    const mirror = createAppGithubMirror({ readToken: async () => ({ repository: REPOSITORY, token: TOKEN }) });
    commit(fixture, 'first\n');
    const first = await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: fixture.checkout });
    expect(first).toMatchObject({ ok: true, kind: 'export' });
    commit(fixture, 'second\n');
    const second = await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: fixture.checkout,
      previousHead: first.ok ? first.after : undefined });
    expect(second).toMatchObject({ ok: true, kind: 'mirror', before: first.ok ? first.after : undefined });
    fixture.git(fixture.seed, ['pull', '--rebase', 'origin', 'main']);
    fixture.advanceMain(1);
    const remoteBefore = fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']);
    commit(fixture, 'local third\n');
    const rejected = await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: fixture.checkout,
      previousHead: second.ok ? second.after : undefined });
    expect(rejected).toMatchObject({ ok: false, reason: 'push-failed' });
    expect(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main'])).toBe(remoteBefore);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.MIRROR_TEST_REMOTE;
    fixture.cleanup();
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test('history size limits report enumerated objects and the byte count that crossed the limit', () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    const objects = scanLocalGitHistory(fixture.checkout, TOKEN, { maxObjects: 1 }); // 출처: 내부 문서 `app-source-and-git` §5 · 최소 fixture 에도 commit/tree/blob 셋이 있다.
    expect(objects).toMatchObject({ verdict: 'indeterminate' });
    expect(objects.objectsEnumerated).toBeGreaterThan(1); // 출처: 내부 문서 `app-source-and-git` §5 · base commit/tree/blob 수.
    const bytes = scanLocalGitHistory(fixture.checkout, TOKEN, { maxBytes: 1 }); // 출처: 내부 문서 `app-source-and-git` §5 · base commit 한 개도 1 byte 초과.
    expect(bytes).toMatchObject({ verdict: 'indeterminate' });
    expect(bytes.bytesMeasured).toBeGreaterThan(1); // 출처: 내부 문서 `app-source-and-git` §5 · cap 을 넘긴 객체의 크기 포함.
  } finally { fixture.cleanup(); }
});

test('a canary in an earlier reachable commit blocks export before GitHub push', async () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    commit(fixture, 'ELANOUS_CANARY_V1 in history\n');
    commit(fixture, 'clean current tree\n');
    const gh = createFakeGh({ prs: [], repository: REPOSITORY, tokens: [{ id: TOKEN, repository: REPOSITORY, permission: 'contents:write' }] });
    const before = fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']);
    const mirror = createAppGithubMirror({ readToken: async () => ({ repository: REPOSITORY, token: TOKEN }),
      scanHistory: scanLocalGitHistory, push: async ({ token }) => gh.pushWithToken(token, fixture) });
    const result = await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: fixture.checkout });
    expect(result).toMatchObject({ ok: false, reason: 'canary-hit' });
    expect(gh.webhooks).toHaveLength(0);
    expect(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main'])).toBe(before);
  } finally { fixture.cleanup(); }
});

test('a canary in a reachable commit message blocks export', async () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    writeFileSync(join(fixture.checkout, 'README.md'), 'clean bytes\n');
    fixture.git(fixture.checkout, ['add', 'README.md']);
    fixture.git(fixture.checkout, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      'commit', '-m', 'ELANOUS_CANARY_V1 in commit metadata']);
    expect(scanLocalGitHistory(fixture.checkout, TOKEN).verdict).toBe('leaked');
    expect(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']))
      .not.toBe(fixture.git(fixture.checkout, ['rev-parse', 'HEAD']));
  } finally { fixture.cleanup(); }
});

test('an environment secret file in an old tree blocks export after deletion', () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    writeFileSync(join(fixture.checkout, '.env.local'), 'HARMLESS=1\n');
    fixture.git(fixture.checkout, ['add', '.env.local']);
    fixture.git(fixture.checkout, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'old env']);
    rmSync(join(fixture.checkout, '.env.local'));
    fixture.git(fixture.checkout, ['add', '-u']);
    fixture.git(fixture.checkout, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'remove env']);
    expect(scanLocalGitHistory(fixture.checkout, TOKEN).verdict).toBe('leaked');
  } finally { fixture.cleanup(); }
});

test('missing, expired, and underprivileged local slots never call the push boundary', async () => {
  const cred = createFakeCred({ now: () => 2_000 });
  const attempts: string[] = [];
  const mirror = createAppGithubMirror({
    readToken: async () => {
      const state = cred.use({ slot: 'cred:openai.api_key', generation: 1 }, 'push');
      return state.ok ? { repository: REPOSITORY, token: TOKEN } : undefined;
    },
    scanHistory: async () => { attempts.push('scan'); return { verdict: 'clean', objectsScanned: 1, bytesScanned: 1 }; },
    push: async () => { attempts.push('push'); return { ok: true, before: 'old', after: 'new' }; },
  });
  const input = { appSlug: 'notes', repository: REPOSITORY, sourceRepo: '/unused' };
  expect(await mirror.push(input)).toMatchObject({ ok: false, reason: 'missing-token' });
  cred.install('cred:openai.api_key', { permissions: ['read'], expiresAt: 3_000 });
  expect(await mirror.push(input)).toMatchObject({ ok: false, reason: 'missing-token' });
  cred.rotate('cred:openai.api_key', { permissions: ['push'], expiresAt: 2_000 });
  expect(await mirror.push(input)).toMatchObject({ ok: false, reason: 'missing-token' });
  expect(attempts).toEqual([]);
});

test('GitHub token expiry and insufficient repository permission leave the remote unchanged', async () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    commit(fixture, 'would be pushed\n');
    const before = fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']);
    const gh = createFakeGh({ prs: [], repository: REPOSITORY, now: () => new Date('2026-11-09T00:00:00Z'),
      tokens: [
        { id: 'expired', repository: REPOSITORY, permission: 'contents:write', expiresAt: '2026-11-08T00:00:00Z' },
        { id: 'read-only', repository: REPOSITORY, permission: 'contents:read' },
      ] });
    for (const [token, reason] of [['expired', 'token-expired'], ['read-only', 'permission-denied']] as const) {
      const mirror = createAppGithubMirror({ readToken: async () => ({ repository: REPOSITORY, token }),
        scanHistory: scanLocalGitHistory, push: async ({ token: used }) => gh.pushWithToken(used, fixture) });
      expect(await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: fixture.checkout }))
        .toMatchObject({ ok: false, reason });
    }
    expect(gh.webhooks).toHaveLength(0);
    expect(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main'])).toBe(before);
  } finally { fixture.cleanup(); }
});

test('a non-fast-forward remote rejects the mirror without a webhook', async () => {
  const fixture = createTempGitRemote({ repository: REPOSITORY });
  try {
    commit(fixture, 'local divergent change\n');
    fixture.advanceMain(1);
    const before = fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']);
    const gh = createFakeGh({ prs: [], repository: REPOSITORY,
      tokens: [{ id: TOKEN, repository: REPOSITORY, permission: 'contents:write' }] });
    const mirror = createAppGithubMirror({ readToken: async () => ({ repository: REPOSITORY, token: TOKEN }),
      scanHistory: scanLocalGitHistory, push: async ({ token }) => gh.pushWithToken(token, fixture) });
    expect(await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: fixture.checkout }))
      .toMatchObject({ ok: false, reason: 'push-failed' });
    expect(gh.webhooks).toHaveLength(0);
    expect(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main'])).toBe(before);
  } finally { fixture.cleanup(); }
});

test('scope mismatch and incomplete scan cannot report export', async () => {
  const calls: string[] = [];
  const mirror = createAppGithubMirror({
    readToken: async () => ({ repository: REPOSITORY, token: TOKEN }),
    scanHistory: async () => { calls.push('scan'); return { verdict: 'indeterminate', objectsScanned: 0, bytesScanned: 0 }; },
    push: async () => { calls.push('push'); return { ok: true, before: 'old', after: 'new' }; },
  });
  expect(await mirror.push({ appSlug: 'notes', repository: 'other/repo', sourceRepo: '/unused' }))
    .toMatchObject({ ok: false, reason: 'repository-denied' });
  expect(await mirror.push({ appSlug: 'notes', repository: REPOSITORY, sourceRepo: '/unused' }))
    .toMatchObject({ ok: false, reason: 'scan-incomplete' });
  expect(calls).toEqual(['scan']);
});
