import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// TRAIN-CLEANUP-OFF-CRITICAL-PATH: the verdict must never wait for worktree cleanup, and a cleanup failure/timeout
// must never be turned into an exception (it used to: `worktree remove --force` 180 s timeout -> RuntimeError in `finally`).
const BATCH = join(import.meta.dir, '..', '..', 'scripts', 'train', 'legacy', 'train-batch-live.py');
const SLOW_RM_SECONDS = 3;
const VERDICT_BUDGET_MS = 1500;
const SPAWN_LIMIT_MS = 20_000;

const PYTHON = String.raw`
import importlib.util, json, sys, subprocess, time
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
out = {}
res = [{'host': 'h1', 'worktree': '/home/builders/elanous-hq/seat-state/OP/train-artifacts/batch-1/integration-primary',
        'bundle': '/home/builders/x.bundle', 'refs': ['refs/opt-train/1/primary/9']}]
# 1) ssh that would take 30 s: the cleanup call must return at once
m.ssh_remote_command = lambda host, text, **k: ['sleep', '30']
t = time.time(); r = m.cleanup_remote_integrations(res); out['slow_elapsed'] = time.time() - t; out['slow'] = r
t = time.time(); r = m.cleanup_remote_batch_temps([{'host': 'h1', 'tmp': '/home/builders/.etb/0123456789',
    'art': '/home/builders/elanous-hq/seat-state/OP/train-artifacts/batch-1/primary-art'}], lambda *_: None)
out['tmp_elapsed'] = time.time() - t; out['tmp'] = r
# 2) ssh that cannot even start: recorded, not raised
m.ssh_remote_command = lambda host, text, **k: ['/nonexistent/ssh-binary']
try:
    out['broken'] = m.cleanup_remote_integrations(res); out['broken_bundle'] = m.cleanup_remote_bundle_copies([{'host': 'h1', 'path': '/p'}])
    out['raised'] = False
except Exception as exc:
    out['raised'] = repr(exc)
print(json.dumps(out))
`;

test('cleanup of integrations/tmp/bundle copies is detached: returns at once, failure to start is recorded not raised', () => {
  const r = spawnSync('python3', ['-I', '-c', PYTHON, BATCH], { encoding: 'utf8', timeout: SPAWN_LIMIT_MS });
  if (r.status !== 0) throw new Error(r.stderr || 'python failed');
  const out = JSON.parse(r.stdout);
  expect(out.slow_elapsed * 1000).toBeLessThan(VERDICT_BUDGET_MS);
  expect(out.tmp_elapsed * 1000).toBeLessThan(VERDICT_BUDGET_MS);
  expect(out.slow[0]).toMatchObject({ host: 'h1', detached: true });
  expect(out.raised).toBe(false);
  expect(out.broken[0].detached).toBe(false);
  expect(out.broken_bundle[0].detached).toBe(false);
});

function gcSnippet(tree: string, pattern: string): string {
  const py = String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
sys.stdout.write(m.remote_worktree_gc(sys.argv[2], sys.argv[3]))
`;
  const r = spawnSync('python3', ['-I', '-c', py, BATCH, tree, pattern], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

function sandbox(): { root: string; bin: string; shared: string; tree: string } {
  const root = mkdtempSync(join(tmpdir(), 'tca-'));
  const batch = join(root, 'train-artifacts', 'batch-5');
  const tree = join(batch, 'primary-worktree');
  const shared = join(root, 'shared-node-modules');
  mkdirSync(join(tree, 'src'), { recursive: true });
  mkdirSync(shared);
  writeFileSync(join(shared, 'keep.txt'), 'shared');
  symlinkSync(shared, join(tree, 'node_modules'));
  writeFileSync(join(tree, 'src', 'a.ts'), 'x');
  // slow rm: models the multi-minute node_modules delete
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'rm'), `#!/bin/sh\n[ "$1" = -rf ] && sleep ${SLOW_RM_SECONDS}\nexec /bin/rm "$@"\n`);
  chmodSync(join(bin, 'rm'), 0o755);
  return { root, bin, shared, tree };
}

test('worktree gc returns before a slow recursive delete, never follows a node_modules symlink, deletes later', () => {
  const sb = sandbox();
  try {
    const script = gcSnippet(sb.tree, '*/train-artifacts/batch-*/*-worktree') + '\necho DONE';
    const t = Date.now();
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}` }, timeout: SPAWN_LIMIT_MS });
    const elapsed = Date.now() - t;
    expect(r.stdout.trim()).toBe('DONE');
    expect(elapsed).toBeLessThan(VERDICT_BUDGET_MS);
    expect(existsSync(sb.tree)).toBe(false); // the worktree path is free at once
    expect(existsSync(join(sb.shared, 'keep.txt'))).toBe(true); // shared target untouched
    const leftovers = readdirSync(join(sb.root, 'train-artifacts', 'batch-5'));
    expect(leftovers.length).toBe(1);
    expect(leftovers[0]).toMatch(/^primary-worktree\.gc-[0-9]+$/);
    spawnSync('sleep', [String(SLOW_RM_SECONDS + 2)]);
    expect(readdirSync(join(sb.root, 'train-artifacts', 'batch-5'))).toEqual([]); // detached delete finished
    expect(existsSync(join(sb.shared, 'keep.txt'))).toBe(true);
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
}, SPAWN_LIMIT_MS);

test('worktree gc refuses a path outside train-artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'tca-'));
  try {
    const victim = join(root, 'precious-worktree');
    mkdirSync(victim);
    writeFileSync(join(victim, 'f'), '1');
    const r = spawnSync('bash', ['-c', gcSnippet(victim, '*/train-artifacts/batch-*/*-worktree')], { encoding: 'utf8' });
    expect(r.stderr).toContain('refusing unowned worktree path');
    expect(existsSync(join(victim, 'f'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate trap and dependency scratch cleanup use the rename-then-detached-delete path, not a blocking worktree remove', () => {
  const py = String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
sys.stdout.write(m.remote_worker_cleanup_trap('/h/train-artifacts/batch-1/primary-worktree', '/h/.etb/0123456789', '/h/train-artifacts/batch-1/primary-art'))
`;
  const r = spawnSync('python3', ['-I', '-c', py, BATCH], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain('worktree remove');
  expect(r.stdout).toContain('nohup sh -c');
  expect(r.stdout).not.toContain('rm -rf -- "$dep_real"');
});

test('every cleanup kind records its start outcome in tmp-cleanup.json; start failure is recorded, nothing raises', () => {
  const py = String.raw`
import importlib.util, json, sys, tempfile, pathlib
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
m.ssh_remote_command = lambda host, text, **k: ['ssh', host, 'x']
real_popen = m.subprocess.Popen
def failing_popen(argv, **kw):
    raise OSError('ssh start refused')
m.subprocess.Popen = failing_popen
art = pathlib.Path(tempfile.mkdtemp())
integ = [{'host': 'h1', 'worktree': '/home/builders/elanous-hq/seat-state/OP/train-artifacts/batch-1/integration-primary', 'bundle': '/home/builders/b.bundle', 'refs': []}]
tmp = [{'host': 'h2', 'tmp': '/home/builders/.etb/0123456789', 'art': '/home/builders/elanous-hq/seat-state/OP/train-artifacts/batch-1/primary-art'}]
rec = m.run_detached_cleanups(art, [{'host': 'h3', 'path': '/home/builders/p.bundle'}], integ, tmp, lambda *_: None)
ondisk = json.loads((art / 'tmp-cleanup.json').read_text())
# ssh options are present on a real detach argv
m.subprocess.Popen = lambda argv, **kw: type('P', (), {'pid': 1, 'poll': lambda self: 0})()
seen = []
m.ssh_remote_command = lambda host, text, **k: seen.append(1) or ['ssh', host, 'x']
m.detach_remote('h1', 'true')
captured = []
m.subprocess.Popen = lambda argv, **kw: captured.append(argv) or type('P', (), {'pid': 1, 'poll': lambda self: 0})()
m.detach_remote('h1', 'true')
print(json.dumps({'rec': rec, 'ondisk': ondisk, 'argv': captured[0]}))
`;
  const r = spawnSync('python3', ['-I', '-c', py, BATCH], { encoding: 'utf8', timeout: SPAWN_LIMIT_MS });
  if (r.status !== 0) throw new Error(r.stderr || 'python failed');
  const out = JSON.parse(r.stdout);
  expect(out.ondisk).toEqual(out.rec);
  for (const [kind, host] of [['bundle', 'h3'], ['integration', 'h1'], ['tmp', 'h2']] as const) {
    expect(out.ondisk[kind]).toHaveLength(1);
    expect(out.ondisk[kind][0]).toMatchObject({ host, detached: false });
    expect(out.ondisk[kind][0].error).toContain('ssh start refused');
  }
  expect(out.argv.slice(0, 7)).toEqual(['ssh', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']);
});

test('remote recursive delete carries coreutils timeout when present; bundle cleanup output lands in the batch art log', () => {
  const py = String.raw`
import importlib.util, json, sys, tempfile, pathlib
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
gc = m.remote_worktree_gc('/h/train-artifacts/batch-1/p-worktree', '*/train-artifacts/batch-*/*-worktree')
seen = []
class P:
    pid = 7
    def poll(self): return 0
def fake_popen(argv, **kw):
    seen.append(kw['stdout'].name if hasattr(kw['stdout'], 'name') else repr(kw['stdout'])); return P()
m.subprocess.Popen = fake_popen
m.ssh_remote_command = lambda host, text, **k: ['ssh', host, text]
art = pathlib.Path(tempfile.mkdtemp())
m.cleanup_remote_bundle_copies([{'host': 'h1', 'path': '/h/x.bundle'}], art)
print(json.dumps({'gc': gc, 'seen': seen, 'art': str(art)}))
`;
  const r = spawnSync('python3', ['-I', '-c', py, BATCH], { encoding: 'utf8', timeout: SPAWN_LIMIT_MS });
  if (r.status !== 0) throw new Error(r.stderr || 'python failed');
  const out = JSON.parse(r.stdout);
  expect(out.gc).toContain('command -v timeout');
  expect(out.gc).toContain('T="timeout 900"');
  expect(out.seen).toEqual([join(out.art, 'cleanup-async.log')]);
});
