import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// TRAIN-TIMEOUT-NOT-VIOLATION: a bun «this test timed out» under load is unmeasured infra, never a violation.
const BATCH = join(import.meta.dir, '..', '..', 'scripts', 'train', 'legacy', 'train-batch-live.py');
const SPAWN_LIMIT_MS = 30_000;

const PYTHON = String.raw`
import importlib.util, json, sys, tempfile, pathlib
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
BASE, HEAD = 'a' * 40, 'b' * 40
TIMEOUT = '(pass) fast one [1.00ms]\n(fail) slow gate test > case [5003.10ms]\n  ^ this test timed out after 5000ms.\n(pass) tail [2.00ms]\n\n 2 pass\n 1 fail\nRan 3 tests across 1 files. [5.01s]\n'
VIOLATION = 'error: expect(received).toEqual(expected)\n\n- Expected  - 1\n+ Received  + 1\n(fail) rules > real violation [3.00ms]\n'
def case(log):
    d = pathlib.Path(tempfile.mkdtemp()); art = d / 'remote-artifacts' / 'primary-art'; art.mkdir(parents=True)
    (art / 'always-ratchets.log').write_text(log)
    data = {'base40': BASE, 'head40': HEAD, 'verdict': 'failed', 'exitCode': 1, 'introduced': 0, 'unknown': 0, 'unrunImporters': 0,
            'typecheck': {'status': 'passed', 'exitCode': 0, 'base40': BASE, 'head40': HEAD},
            'trainAlwaysRatchets': {'status': 'failed', 'exitCode': 1, 'tests': list(m.TRAIN_ALWAYS_RATCHETS), 'log': 'always-ratchets.log', 'reviewWorkItems': []}}
    p = d / 'summary.json'; p.write_text(json.dumps(data))
    try:
        m.select_gate_summary(p, None, BASE, HEAD, [])
        err = None
    except RuntimeError as exc:
        err = str(exc)
    return {'unmeasured': m.gate_is_unmeasured(p, BASE, HEAD), 'failed': m.gate_failed_introduced(p), 'err': err,
            'infra': m.is_host_infra_reason(err), 'detail': m.always_ratchet_detail(p, data)}
print(json.dumps({'timeout': case(TIMEOUT), 'both': case(TIMEOUT + VIOLATION), 'violation': case(VIOLATION),
                  'classify': m.classify_bun_failures(TIMEOUT + VIOLATION)}))
`;
const run = spawnSync('python3', ['-I', '-c', PYTHON, BATCH], { encoding: 'utf8', timeout: SPAWN_LIMIT_MS });
if (run.status !== 0) throw new Error(run.stderr || 'python failed');
const got = JSON.parse(run.stdout);

test('log classification separates load timeouts from real failures', () => {
  expect(got.classify.timeouts).toEqual(['slow gate test > case [5003.10ms]']);
  expect(got.classify.violations).toEqual(['rules > real violation [3.00ms]']);
});

test('timeout-only ratchet failure is unmeasured infra: requeue path, no strike marker, not a failure', () => {
  expect(got.timeout.unmeasured).toBe(true);
  expect(got.timeout.failed).toBe(false);
  expect(got.timeout.err).toContain('unmeasured primary gate requires retry');
  expect(got.timeout.infra).toBe(true); // refusal event gets infra=true: no park count, no same-head refusal count
  expect(got.timeout.detail).toContain('timeouts=1 violations=0');
});

test('timeout plus violation, and violation only, stay failures (never infra)', () => {
  for (const kind of ['both', 'violation'] as const) {
    expect(got[kind].unmeasured).toBe(false);
    expect(got[kind].failed).toBe(true);
    expect(got[kind].err).toContain('always-ratchet bundle missing, failed, or unbound');
    expect(got[kind].infra).toBe(false);
  }
  expect(got.both.detail).toContain('violations=1');
});

// JUD fail must 2 (fd1f30f2): primary violations must not be laundered by a timeout-only retry, and the classifier must
// parse per block with the exact bun shape (marker = the line right after `(fail)`, no `error:` inside the block).
const PYTHON2 = String.raw`
import importlib.util, json, sys, tempfile, pathlib
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
BASE, HEAD = 'a' * 40, 'b' * 40
TIMEOUT = '(fail) slow gate test > case [5003.10ms]\n  ^ this test timed out after 5000ms.\n\n 0 pass\n 1 fail\nRan 1 tests across 1 files. [5.01s]\n'
VIOLATION = 'error: expect(received).toEqual(expected)\n(fail) rules > real violation [3.00ms]\n'
def summary(d, name, art, log, status='failed'):
    a = d / 'remote-artifacts' / art; a.mkdir(parents=True, exist_ok=True); (a / 'always-ratchets.log').write_text(log)
    data = {'base40': BASE, 'head40': HEAD, 'verdict': 'failed', 'exitCode': 1, 'introduced': 0, 'unknown': 0, 'unrunImporters': 0,
            'typecheck': {'status': 'passed', 'exitCode': 0, 'base40': BASE, 'head40': HEAD},
            'trainAlwaysRatchets': {'status': status, 'exitCode': 1, 'tests': list(m.TRAIN_ALWAYS_RATCHETS), 'log': 'always-ratchets.log', 'reviewWorkItems': []}}
    p = d / name; p.write_text(json.dumps(data)); return p
def pair(primary_log, retry_log):
    d = pathlib.Path(tempfile.mkdtemp())
    p = summary(d, 'summary.json', 'primary-art', primary_log)
    r = summary(d, 'summary-h-retry.json', 'retry-art', retry_log)
    try:
        m.select_gate_summary(p, r, BASE, HEAD, []); err = None
    except RuntimeError as exc:
        err = str(exc)
    return {'err': err, 'infra': m.is_host_infra_reason(err)}
out = {'a_primary_violation_retry_timeout': pair(VIOLATION, TIMEOUT), 'b_both_timeout': pair(TIMEOUT, TIMEOUT)}
out['c_error_then_next_timeout'] = m.classify_bun_failures('error: boom\n  at x\n(fail) a > plain error [2.00ms]\n(pass) b [1ms]\n' + TIMEOUT)
out['d_pure_timeout_block'] = m.classify_bun_failures('src/t.test.ts:\n' + TIMEOUT + '(pass) z [1ms]\n')
out['e_marker_not_adjacent'] = m.classify_bun_failures('(fail) a [1ms]\n  console noise\n  ^ this test timed out after 5ms.\n')
out['f_error_inside_timeout_block'] = m.classify_bun_failures('error: expect(received).toBe(expected)\n(fail) a [5001ms]\n  ^ this test timed out after 5000ms.\n')
out['g_ansi'] = m.classify_bun_failures('\x1b[31m(fail) a [5001.00ms]\x1b[0m\n\x1b[2m  ^ this test timed out after 5000ms.\x1b[0m\n')
print(json.dumps(out))
`;
const run2 = spawnSync('python3', ['-I', '-c', PYTHON2, BATCH], { encoding: 'utf8', timeout: SPAWN_LIMIT_MS });
if (run2.status !== 0) throw new Error(run2.stderr || 'python failed');
const got2 = JSON.parse(run2.stdout);

test('primary violation + timeout-only retry stays a failure (no host-infra marker); both timeout-only is infra', () => {
  expect(got2.a_primary_violation_retry_timeout.err).toContain('retry of failed primary remained unmeasured');
  expect(got2.a_primary_violation_retry_timeout.infra).toBe(false);
  expect(got2.b_both_timeout.err).toContain('retry remained unmeasured');
  expect(got2.b_both_timeout.infra).toBe(true);
});

test('classifier parses per block with the exact bun shape', () => {
  expect(got2.c_error_then_next_timeout.violations).toEqual(['a > plain error [2.00ms]']);
  expect(got2.c_error_then_next_timeout.timeouts).toEqual(['slow gate test > case [5003.10ms]']);
  expect(got2.d_pure_timeout_block).toEqual({ timeouts: ['slow gate test > case [5003.10ms]'], violations: [] });
  expect(got2.e_marker_not_adjacent.timeouts).toEqual([]);
  expect(got2.e_marker_not_adjacent.violations).toHaveLength(1);
  expect(got2.f_error_inside_timeout_block.timeouts).toEqual([]);
  expect(got2.f_error_inside_timeout_block.violations).toHaveLength(1);
  expect(got2.g_ansi.timeouts).toHaveLength(1);
});

// JUD-B counterexamples on 525f4d34: unmeasured-infra only when EVERY attempt (primary, retry, handoff) is a pure ratchet
// timeout; anything uncertain fails closed.
const REAL_MODULE_ERROR_PLUS_TIMEOUT = [
  'bun test v1.4.2 (744846f84)', '', 'a.test.ts:', '', '# Unhandled error between tests', '-------------------------------',
  "1 | throw new Error('module load broken');", '              ^', 'error: module load broken',
  '      at /x/a.test.ts:1:11', '-------------------------------', '', '', 'b.test.ts:',
  '(fail) slow [11.24ms]', '  ^ this test timed out after 10ms.', '', ' 0 pass', ' 2 fail', ' 1 error', 'Ran 2 tests across 2 files. [31.00ms]', '',
].join('\n');
const PYTHON3 = String.raw`
import importlib.util, json, sys, tempfile, pathlib
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
BASE, HEAD = 'a' * 40, 'b' * 40
TIMEOUT = '(fail) slow gate test > case [5003.10ms]\n  ^ this test timed out after 5000ms.\n\n 0 pass\n 1 fail\nRan 1 tests across 1 files. [5.01s]\n'
VIOLATION = 'error: expect(received).toEqual(expected)\n(fail) rules > real violation [3.00ms]\n\n 0 pass\n 1 fail\nRan 1 tests across 1 files. [5.01s]\n'
MODULE = sys.argv[2]
def summary(d, name, art, log, typecheck='passed'):
    if log is not None:
        a = d / 'remote-artifacts' / art; a.mkdir(parents=True, exist_ok=True); (a / 'always-ratchets.log').write_text(log)
    tc = {'status': typecheck, 'exitCode': 0, 'base40': BASE, 'head40': HEAD}
    if typecheck == 'unmeasured': tc['reason'] = 'typecheck receipt missing'
    data = {'base40': BASE, 'head40': HEAD, 'verdict': 'failed', 'exitCode': 1, 'introduced': 0, 'unknown': 0, 'unrunImporters': 0,
            'typecheck': tc, 'trainAlwaysRatchets': {'status': 'failed', 'exitCode': 1, 'tests': list(m.TRAIN_ALWAYS_RATCHETS), 'log': 'always-ratchets.log', 'reviewWorkItems': []}}
    p = d / name; p.write_text(json.dumps(data)); return p
out = {}
# 1) real bun shape: unhandled module error + separate timeout
d = pathlib.Path(tempfile.mkdtemp()); p = summary(d, 'summary.json', 'primary-art', MODULE)
out['module_classify'] = m.classify_bun_failures(MODULE)
out['module_timeout_only'] = m.ratchet_timeout_only(p, json.loads(p.read_text()))
# 2) retry log missing, primary timeout log present: retry must not borrow primary's log
d = pathlib.Path(tempfile.mkdtemp()); summary(d, 'summary.json', 'primary-art', TIMEOUT); r = summary(d, 'summary-h-retry.json', 'retry-art', None)
out['retry_borrowed_log'] = m.ratchet_timeout_only(r, json.loads(r.read_text()))
# 3) three attempts: timeout-only / retry (typecheck unmeasured + assertion violation) / timeout-only handoff
d = pathlib.Path(tempfile.mkdtemp())
p = summary(d, 'summary.json', 'primary-art', TIMEOUT)
r = summary(d, 'summary-h-retry.json', 'retry-art', VIOLATION, typecheck='unmeasured')
h = summary(d, 'summary-g-handoff.json', 'handoff-art', TIMEOUT)
try:
    m.select_gate_summary(p, h, BASE, HEAD, [], attempts=[p, r, h]); err = None
except RuntimeError as exc:
    err = str(exc)
except TypeError as exc:
    err = 'TypeError: ' + str(exc)
out['three_attempts'] = {'err': err, 'infra': m.is_host_infra_reason(err), 'marker': m.unmeasured_refusal_marker(p, r, h)}
print(json.dumps(out))
`;
const run3 = spawnSync('python3', ['-I', '-c', PYTHON3, BATCH, REAL_MODULE_ERROR_PLUS_TIMEOUT], { encoding: 'utf8', timeout: SPAWN_LIMIT_MS });
if (run3.status !== 0) throw new Error(run3.stderr || 'python failed');
const got3 = JSON.parse(run3.stdout);

test('JUD-B 1: unhandled module error + separate timeout is a violation (real bun 1.4.2 shape, `2 fail 1 error`)', () => {
  expect(got3.module_classify.violations).not.toEqual([]);
  expect(got3.module_timeout_only).toBe(false);
});

test('JUD-B 2: a retry whose own log is missing never borrows the primary log (fail closed)', () => {
  expect(got3.retry_borrowed_log).toBe(false);
});

test('JUD-B 3: every attempt feeds the marker; a retry violation hidden between primary and handoff leaves no host-infra marker', () => {
  expect(got3.three_attempts.marker).toBe('');
  expect(got3.three_attempts.err).toContain('retry remained unmeasured');
  expect(got3.three_attempts.infra).toBe(false);
});

// JUD-B boundary counterexamples on 5fdcdf83: an unhandled-error header before a timeout block, and a log cut off before
// bun's summary lines, are both "cannot explain every failure" -> not unmeasured-infra.
const PYTHON4 = String.raw`
import importlib.util, json, sys, tempfile, pathlib
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
BASE, HEAD = 'a' * 40, 'b' * 40
def only(log):
    d = pathlib.Path(tempfile.mkdtemp()); a = d / 'remote-artifacts' / 'primary-art'; a.mkdir(parents=True); (a / 'always-ratchets.log').write_text(log)
    data = {'base40': BASE, 'head40': HEAD, 'verdict': 'failed', 'exitCode': 1, 'introduced': 0, 'unknown': 0, 'unrunImporters': 0,
            'typecheck': {'status': 'passed', 'exitCode': 0, 'base40': BASE, 'head40': HEAD},
            'trainAlwaysRatchets': {'status': 'failed', 'exitCode': 1, 'tests': list(m.TRAIN_ALWAYS_RATCHETS), 'log': 'always-ratchets.log', 'reviewWorkItems': []}}
    p = d / 'summary.json'; p.write_text(json.dumps(data)); return m.ratchet_timeout_only(p, data)
HEADER = '# Unhandled error between tests\n(fail) slow case [5003ms]\n  ^ this test timed out after 5000ms.\n'
CUT = '(fail) slow case [5003ms]\n  ^ this test timed out after 5000ms.\n'
FULL = CUT + '\n 0 pass\n 1 fail\nRan 1 tests across 1 files. [5.00s]\n'
print(json.dumps({'header': m.classify_bun_failures(HEADER), 'header_infra': only(HEADER + '\n 0 pass\n 1 fail\n'),
                  'cut_infra': only(CUT), 'full_infra': only(FULL)}))
`;
const run4 = spawnSync('python3', ['-I', '-c', PYTHON4, BATCH], { encoding: 'utf8', timeout: SPAWN_LIMIT_MS });
if (run4.status !== 0) throw new Error(run4.stderr || 'python failed');
const got4 = JSON.parse(run4.stdout);

test('JUD-B boundary 1: an Unhandled-error header ahead of a timeout block is a violation', () => {
  expect(got4.header.timeouts).toEqual([]);
  expect(got4.header.violations).not.toEqual([]);
  expect(got4.header_infra).toBe(false);
});

test('JUD-B boundary 2: a log without bun summary lines (cut off) is never timeout-only; the complete one still is', () => {
  expect(got4.cut_infra).toBe(false);
  expect(got4.full_infra).toBe(true);
});

// JUD-B #113081: a log cut off right after the `N fail` summary has no completion evidence. bun ends every complete run with
// ` Ran N tests across M files. [time]`; the summary counts must add up to N.
const PYTHON5 = String.raw`
import importlib.util, json, sys, tempfile, pathlib
spec = importlib.util.spec_from_file_location('tbl', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['tbl'] = m; spec.loader.exec_module(m)
BASE, HEAD = 'a' * 40, 'b' * 40
def only(log):
    d = pathlib.Path(tempfile.mkdtemp()); a = d / 'remote-artifacts' / 'primary-art'; a.mkdir(parents=True); (a / 'always-ratchets.log').write_text(log)
    data = {'base40': BASE, 'head40': HEAD, 'verdict': 'failed', 'exitCode': 1, 'introduced': 0, 'unknown': 0, 'unrunImporters': 0,
            'typecheck': {'status': 'passed', 'exitCode': 0, 'base40': BASE, 'head40': HEAD},
            'trainAlwaysRatchets': {'status': 'failed', 'exitCode': 1, 'tests': list(m.TRAIN_ALWAYS_RATCHETS), 'log': 'always-ratchets.log', 'reviewWorkItems': []}}
    p = d / 'summary.json'; p.write_text(json.dumps(data)); return m.ratchet_timeout_only(p, data)
BLOCK = '(pass) a [1.00ms]\n(fail) slow case [5003ms]\n  ^ this test timed out after 5000ms.\n'
print(json.dumps({
  'cut_after_summary': only(BLOCK + '\n 1 pass\n 1 fail\n'),
  'complete': only(BLOCK + '\n 1 pass\n 1 fail\nRan 2 tests across 1 files. [5.01s]\n'),
  'counts_disagree': only(BLOCK + '\n 1 pass\n 1 fail\nRan 9 tests across 1 files. [5.01s]\n'),
  'with_skip_todo': only(BLOCK + '\n 1 pass\n 1 skip\n 1 todo\n 1 fail\nRan 4 tests across 1 files. [5.01s]\n'),
}))
`;
const run5 = spawnSync('python3', ['-I', '-c', PYTHON5, BATCH], { encoding: 'utf8', timeout: SPAWN_LIMIT_MS });
if (run5.status !== 0) throw new Error(run5.stderr || 'python failed');
const got5 = JSON.parse(run5.stdout);

test('JUD-B #113081: timeout-only needs bun completion evidence (Ran line) and consistent counts', () => {
  expect(got5.cut_after_summary).toBe(false);
  expect(got5.counts_disagree).toBe(false);
  expect(got5.complete).toBe(true);
  expect(got5.with_skip_todo).toBe(true);
});
