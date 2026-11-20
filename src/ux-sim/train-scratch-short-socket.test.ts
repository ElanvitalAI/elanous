import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// TRAIN-TMPDIR-SHORT-SOCKET: a unix socket path (sun_path) must stay under 103 bytes. Gate tests create
// `<TMPDIR>/<mkdtemp prefix>-XXXXXX/<name>.sock`; the longest real one is
// `grid-ssh-broker-command-error-` (29) + 6 random + `/host.sock` (10) + 1 separator = 46 bytes.
const SOCKET_TAIL = '/grid-ssh-broker-command-error-abcdef/host.sock';
const SOCKET_LIMIT = 103;
const SCRATCH_BUDGET = 40; // OP 칸 TRAIN-TMPDIR-SHORT-SOCKET: SOCKET_LIMIT minus the longest tail leaves 57 bytes; 40 keeps margin
const BATCH = join(import.meta.dir, '..', '..', 'scripts', 'train', 'legacy', 'train-batch-live.py');

const PYTHON = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
out = {}
for home in ('/home/builders', '/home/ubuntu'):
    for suffix in ('primary', 'handoff', 'timeout-remeasure-minim5'):
        out[home + '|' + suffix] = m.remote_scratch_path(home, '131034322', suffix)
out['old'] = m.remote_batch_root('/home/builders', '131034322', 'primary') + '-tmp'
art = '/home/builders/elanous-hq/seat-state/OP/train-artifacts/batch-131034322/primary-art'
out['setup'] = m.remote_worker_setup(art, out['/home/builders|primary'])
out['cleanup'] = m.build_remote_batch_tmp_cleanup_command(out['/home/builders|primary'], art)
bad = []
for tmp in ('/home/builders/elanous-hq/seat-state/OP/train-artifacts/batch-131034322/primary-tmp', '/home/builders/.etb/../x', '/home/builders/.etb/zz'):
    try:
        m.build_remote_batch_tmp_cleanup_command(tmp, art); bad.append(tmp)
    except ValueError:
        pass
out['accepted_unsafe'] = bad
print(json.dumps(out))
`;

const run = spawnSync('python3', ['-I', '-c', PYTHON, BATCH], { encoding: 'utf8' });
if (run.status !== 0) throw new Error(run.stderr || 'python import failed');
const got = JSON.parse(run.stdout) as Record<string, any>;

test('previous gate TMPDIR (literal 83 bytes) put socket tests over the unix sun_path limit', () => {
  expect(got.old).toBe('/home/builders/elanous-hq/seat-state/OP/train-artifacts/batch-131034322/primary-tmp');
  expect(got.old.length).toBe(83);
  expect(Buffer.byteLength(got.old + SOCKET_TAIL)).toBeGreaterThanOrEqual(SOCKET_LIMIT);
});

test('gate TMPDIR is short, home-relative, per run, and leaves room for the longest socket path', () => {
  expect(got['/home/builders|primary']).toMatch(/^\/home\/builders\/\.etb\/[0-9a-f]{10}$/);
  const lens = Object.entries(got).filter(([k]) => k.includes('|')).map(([, v]) => v as string);
  expect(new Set(lens).size).toBe(6);
  for (const p of lens) {
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(SCRATCH_BUDGET);
    expect(Buffer.byteLength(p + SOCKET_TAIL)).toBeLessThan(SOCKET_LIMIT);
  }
  expect(got['/home/builders|primary'].length).toBe(30);
});

test('worker setup exports the short TMPDIR and records the owner artifact; cleanup refuses non-owned paths', () => {
  expect(got.setup).toContain('export TMPDIR=/home/builders/.etb/');
  expect(got.setup).toContain('pwd -P) > /home/builders/.etb/');
  expect(got.cleanup).toContain("scratch.parent.name != '.etb'");
  expect(got.cleanup).toContain('owner.read_text().strip() != str(artifact)');
  expect(got.accepted_unsafe).toEqual([]);
});

const CLEAN = join(import.meta.dir, '..', '..', 'scripts', 'train', 'legacy', 'train-primary-tmp-clean.py');
const CLEAN_PY = String.raw`
import importlib.util, json, os, pathlib, sys, tempfile, time
spec = importlib.util.spec_from_file_location('c', sys.argv[1]); c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
base = pathlib.Path(tempfile.mkdtemp()).resolve()
root = base / 'train-artifacts'; art = root / 'batch-77' / 'primary-art'; art.mkdir(parents=True)
etb = base / '.etb'; etb.mkdir()
old = time.time() - 40000
def mk(name, owner):
    d = etb / name; (d / 'state').mkdir(parents=True)
    if owner is not None: (d / '.owner').write_text(owner + '\n')
    for p in (d / 'state', d / '.owner', d):
        if p.exists(): os.utime(p, (old, old))
mk('aaaaaaaaaa', str(art)); mk('bbbbbbbbbb', None); mk('cccccccccc', str(base / 'elsewhere' / 'batch-1' / 'x-art'))
mk('dddddddddd', str(art)); os.utime(etb / 'dddddddddd', None)
(etb / 'not-ours').mkdir()
res = {pathlib.Path(r['path']).name: r['status'] for r in c.clean_short(etb, root, 21600)}
print(json.dumps({'res': res, 'left': sorted(p.name for p in etb.iterdir())}))
`;

test('stale short scratch sweep removes only old dirs whose owner marker names a train artifact', () => {
  const r = spawnSync('python3', ['-I', '-c', CLEAN_PY, CLEAN], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const out = JSON.parse(r.stdout);
  expect(out.res).toEqual({
    aaaaaaaaaa: 'removed',
    bbbbbbbbbb: 'no-owner-marker',
    cccccccccc: 'owner-outside-train-artifacts',
    dddddddddd: 'scratch-younger-or-unsafe',
  });
  expect(out.left).toEqual(['bbbbbbbbbb', 'cccccccccc', 'dddddddddd', 'not-ours']);
});
