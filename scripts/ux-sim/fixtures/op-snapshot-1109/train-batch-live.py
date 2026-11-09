#!/usr/bin/env python3
"""Staged batch runner boundary. Active train scripts are never changed here."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import math
import os
import re
import shlex
import subprocess
import sys
import socket
import stat
import tempfile
import time
from pathlib import Path
from datetime import datetime

MAX_BATCH = 4
HOSTS_REGISTRY = Path.home() / 'elanous-hq/seat-state/OP/train-hosts.tsv'  # OP 10-28 20:4x 대표 «열차 N개» — 한 줄 = 한 열차 호스트
HOST_CAPS_TSV = Path.home() / 'elanous-hq/seat-state/OP/train-manager/host-caps.tsv'
REMOTE_GATE_TAIL_BEGIN = 'REMOTE_GATE_LOG_TAIL_BEGIN'
REMOTE_GATE_TAIL_END = 'REMOTE_GATE_LOG_TAIL_END'
TRAIN_ALWAYS_RATCHETS = (
    'test/rules-contract.test.ts',
    'scripts/ratchets/*.test.ts',
    'src/instance/*ratchet*.test.ts',
    'src/self-implement/graph-engine-map.test.ts',
    'src/self-implement/elanous-tui-spawn-identity.test.ts',
    'apps/pwa/src/components/shell/sidebar-nav-items.test.ts',
)
TRAIN_ALWAYS_RATCHET_PROFILE = 'train-always-ratchets-v1'
GATE_TIER_HELPER = Path.home() / 'elanous-hq/seat-state/OP/tools/gate-tier.py'
_gate_tier_spec = importlib.util.spec_from_file_location('train_gate_tier', GATE_TIER_HELPER)
_gate_tier = importlib.util.module_from_spec(_gate_tier_spec)
sys.modules[_gate_tier_spec.name] = _gate_tier
_gate_tier_spec.loader.exec_module(_gate_tier)
# OP #83391: gcp2 needed 2184s for a completed shard run; allow 30% headroom.
GATE_HOST_MEASURED_SECONDS = {'gcp2': 2184}


def gate_timeout_for_host(host, requested_seconds):
    measured = GATE_HOST_MEASURED_SECONDS.get(host)
    if measured is None:
        return requested_seconds
    return max(requested_seconds, math.ceil(measured * 1.3))
MEMORY_HELPER = Path.home() / 'elanous-hq/seat-state/OP/tools/train-memory.py'
REFUSAL_EVENTS = Path.home() / 'elanous-hq/seat-state/OP/train-manager/refusal-events.jsonl'
HEAD_MISMATCH_NOTICES = Path.home() / 'elanous-hq/seat-state/OP/train-manager/head-mismatch-notices.jsonl'
GENERATED_REGEN_OUTPUTS = (
    'docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md',
    'src/sim-world-device-catalog-history.json',
    'docs/generated/cli-anatomy.md',
)  # Keep identical to src/self-implement/merge-train.ts GENERATED_OUTPUTS.
UX_SIM_REGEN_INPUTS = (
    'src/ux-sim/',
    'scripts/generate-ux-sim-device-manual.ts',
    'scripts/generate-sim-world-device-catalogs.ts',
)
CLI_REGEN_INPUTS = ('src/cli/', 'scripts/docs/generate-cli-anatomy.ts', 'scripts/docs/generate-graph-anatomy.ts')
GENERATED_REGEN_TIMEOUT = 120
TRAIN_REFRESH_SUBJECT = 'docs: refresh generated outputs for integrated train'
TRAIN_REFRESH_AUTHOR = ('OP-train', 'op-train@local')
TRAIN_REFRESH_REVIEW_SCHEMA = 'elanous.train.generated-refresh-review-carry.v1'
TRAIN_REFRESH_REVIEW_OK = Path.home() / 'elanous-hq/seat-state/OP/tools/train-1016/night-train/review-ok.jq'
_memory_spec = importlib.util.spec_from_file_location('train_memory', MEMORY_HELPER)
_memory = importlib.util.module_from_spec(_memory_spec)
_memory_spec.loader.exec_module(_memory)


def memory_skip_set(rows, base):
    """Exact measured PR/head/base tuples are never selected for another run."""
    blocked = set()
    for row in rows:
        matches = _memory.exact_rows(row.pr, row.head.lower(), base.lower())
        if any(item.get('eventType') == 'batch-gate'
               and item.get('status') in ('passed', 'failed', 'precondition-unmet', 'conflict')
               for item in matches):
            blocked.add(row.pr)
    return blocked


def memory_append(pr, head, base, event_type, status, run_id='', **details):
    from types import SimpleNamespace
    _memory.append(SimpleNamespace(source='train', event_type=event_type, pr=str(pr),
                                   head=head, base=base, run_id=str(run_id), status=status,
                                   data=json.dumps(details, ensure_ascii=False)))


def log(message):
    """Emit a timestamped batch-runner transition to the invoking train log."""
    print(f"{time.strftime('%m-%d %H:%M:%S')} [train-batch] {message}", flush=True)


def remote_gate_log_tail(text):
    """Return the bounded remote gate.log tail embedded by the SSH wrapper, if present."""
    lines = text.splitlines()
    try:
        start = len(lines) - 1 - lines[::-1].index(REMOTE_GATE_TAIL_BEGIN)
        end = lines.index(REMOTE_GATE_TAIL_END, start + 1)
    except ValueError:
        return ''
    return '\n'.join(lines[start + 1:end])


def live_gate_hosts():
    hosts = ['node-b', 'node-c']
    try:
        for line in HOSTS_REGISTRY.read_text().splitlines():
            if line.strip() and not line.startswith('#'):
                h = line.split('\t')[0].strip()
                if (len(line.split('\t')) >= 8 and line.split('\t')[7] == 'yes'
                        and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', h) and h not in hosts):
                    hosts.append(h)
    except OSError:
        pass
    return tuple(hosts)


def remote_path_for_host(host):
    for line in HOSTS_REGISTRY.read_text().splitlines():
        fields = line.split('\t')
        if fields and fields[0] == host and len(fields) >= 6:
            value = fields[5]
            if value != '-' and re.fullmatch(r'[A-Za-z0-9_./:$-]+', value):
                return value
    raise ValueError(f'remote PATH missing from train-hosts.tsv for {host}')


def parse_exclude(text):
    out = {x.strip() for x in (text or '').split(',') if x.strip()}
    if any(not x.isdigit() for x in out):
        raise ValueError('exclude must be comma-separated PR numbers')
    return out


def wait_queue_lock_clear(queue, what, limit=180):
    """OP 10-28 20:0x: 다른 열차의 land-single 이 줄 갱신으로 잠깐 잡는 $Q.lock 에 바로 거부하지 않는다 — 오래 잡혀 있으면 거부."""
    lock = Path(str(queue) + '.lock')
    for _ in range(limit // 5):
        if not lock.exists():
            return
        time.sleep(5)
    if lock.exists():
        raise RuntimeError(f'active train holds the queue lock {what}')

class Row:
    def __init__(self, pr, head, tree, evidence):
        self.pr, self.head, self.tree, self.evidence = pr, head, tree, evidence
    def as_dict(self):
        return {'pr': self.pr, 'head': self.head, 'tree': self.tree, 'evidence': self.evidence}


def read_queue(path):
    rows = []
    for n, line in enumerate(Path(path).read_text().splitlines(), 1):
        if not line or line.startswith('#'):
            continue
        fields = line.split('\t')
        if len(fields) != 4:
            raise ValueError(f'queue row {n}: expected 4 fields')
        pr, head, tree, evidence = fields
        if not pr.isdigit() or not re.fullmatch(r'[0-9a-f]{40}', head):
            raise ValueError(f'queue row {n}: invalid PR/head')
        rows.append(Row(pr, head, tree, evidence))
    if len({r.pr for r in rows}) != len(rows):
        raise ValueError('duplicate PR rows')
    return rows


def chosen_still_queued(path, chosen):
    """OP 10-27 21:0x: 열차가 달리는 동안 다른 자리가 줄 «뒤»에 붙이는 것은 허용 — 고른 PR 들이 같은 head 로 남아 있는지만 본다."""
    try:
        now = {r.pr: r.head for r in read_queue(path)}
    except Exception:
        return False
    return all(now.get(r.pr) == r.head for r in chosen)


def select(rows, conflicts, limit=MAX_BATCH):
    chosen, deferred = [], []
    for row in rows:
        if row.pr in conflicts:
            deferred.append({'pr': row.pr, 'reason': 'merge-tree conflict'})
        elif len(chosen) < limit:
            chosen.append(row)
        else:
            deferred.append({'pr': row.pr, 'reason': 'batch cap'})
    return chosen, deferred


def command(argv, cwd=None, timeout=120):
    return subprocess.run(argv, cwd=cwd, text=True, capture_output=True, timeout=timeout)


def host_cap_is_zero(host):
    """Read the train-manager live overlay so drained hosts are classified before SSH/home probing."""
    try:
        lines = HOST_CAPS_TSV.read_text(encoding='utf-8').splitlines()
    except OSError:
        return False
    for line in lines:
        if not line.strip() or line.startswith('#'):
            continue
        fields = line.split('\t')
        if len(fields) >= 2 and fields[0] == host and fields[1].strip().isdigit():
            return int(fields[1].strip()) == 0
    return False


def resolve_remote_home(host):
    """Resolve a train host home, falling back to the registered absolute WSL bin path."""
    if host_cap_is_zero(host):
        raise RuntimeError(f'host-infra: {host} has train capacity 0; skipped persistent artifact home lookup')
    probe = command(['ssh', '-o', 'ConnectTimeout=10', host, 'printf %s "$HOME"'], timeout=30)
    probed = (probe.stdout or '').strip()
    if probe.returncode == 0 and probed.startswith('/'):
        return probed
    try:
        remote_path = remote_path_for_host(host)
    except (OSError, ValueError):
        remote_path = ''
    for entry in remote_path.split(':'):
        match = re.match(r'^(/home/[^/:]+)/(?:\.bun\/bin|\.local\/share\/elanous\/bin)(?:\/|$)', entry)
        if match:
            return match.group(1)
    detail = (probe.stderr or probe.stdout or f'ssh rc={probe.returncode}').strip()[-300:]
    raise RuntimeError(f'cannot resolve remote home on {host}: {detail}; no registered absolute home path')


def generated_merge_conflict_only(output):
    # Generated outputs are replaced from the exact integrated source tree after merging.
    paths = [line.strip() for line in (output or '').splitlines()
             if line.strip() and not re.fullmatch(r'[0-9a-f]{40}', line.strip())]
    return bool(paths) and all(path in GENERATED_REGEN_OUTPUTS for path in paths)


def generated_output_ere():
    return '|'.join(re.escape(path).replace(r'\-', '-') for path in GENERATED_REGEN_OUTPUTS)


def merge_conflicts(repo, base, rows):
    result = set()
    for row in rows:
        p = command(['git', 'merge-tree', '--write-tree', '--name-only', base, row.head], repo, 60)
        if p.returncode == 1:
            if not generated_merge_conflict_only(p.stdout):
                result.add(row.pr)
        elif p.returncode:
            raise RuntimeError(f'merge-tree unmeasured #{row.pr}: rc={p.returncode}')
    return result


def build_remote_merge_tree_command(base, rows, run_id):
    """Recheck selected PR mergeability using only the batch host clone's objects."""
    if not re.fullmatch(r'[0-9a-f]{40}', base) or not re.fullmatch(r'[0-9]+', str(run_id)):
        raise ValueError('invalid remote merge-tree identity')
    if not rows:
        raise ValueError('cannot merge-tree check an empty row set')
    generated_pattern = generated_output_ere()
    lines = ['set -euo pipefail', 'cd ~/source/elanous-agent',
             'git fetch -q origin main', f'git cat-file -e {base}^{{commit}}']
    refs = [f'refs/opt-train/{run_id}/merge-tree/{row.pr}' for row in rows]
    lines.insert(1, "trap 'cd ~/source/elanous-agent; " +
                 '; '.join(f'git update-ref -d {ref} >/dev/null 2>&1 || true' for ref in refs) + "' EXIT")
    lines.insert(3, 'if git remote get-url github >/dev/null 2>&1; then pull_remote=github; else pull_remote=origin; fi')
    for row in rows:
        if not str(row.pr).isdigit() or not re.fullmatch(r'[0-9a-f]{40}', row.head):
            raise ValueError('invalid merge-tree PR/head')
        ref = f'refs/opt-train/{run_id}/merge-tree/{row.pr}'
        pull_ref = f'refs/pull/{row.pr}/head'
        lines.extend([
            f'git fetch -q "$pull_remote" +{pull_ref}:{pull_ref}',
            f'pulled=$(git rev-parse {pull_ref})',
            f'git update-ref {ref} "$pulled"',
            f'actual=$(git rev-parse {ref})',
            f'if [ "$actual" != {row.head} ]; then',
            f'  echo "MERGE_TREE_HEAD_MISMATCH=#{row.pr} expected={row.head} actual=$actual"',
            'else',
            f'  if merge_output=$(git merge-tree --write-tree --name-only {base} {ref} 2>&1); then',
            f'    echo MERGE_TREE_CLEAN=#{row.pr}',
            '  else',
            '    rc=$?',
            '    if [ "$rc" -eq 1 ]; then',
            '      conflict_paths=$(printf "%s\\n" "$merge_output" | sed "/^[0-9a-f]\\{40\\}$/d; /^$/d")',
            f'      if [ -n "$conflict_paths" ] && ! printf "%s\\n" "$conflict_paths" | grep -Ev "^({generated_pattern})$" >/dev/null; then',
            f'        echo MERGE_TREE_GENERATED_CONFLICT=#{row.pr}',
            f'      else echo MERGE_TREE_CONFLICT=#{row.pr}; fi',
            f'    else echo "MERGE_TREE_UNMEASURED=#{row.pr}:rc=$rc"; exit "$rc"; fi',
            '  fi',
            'fi',
        ])
    return '\n'.join(lines)


def remote_merge_conflicts(host, base, rows, run_id, remote_homes):
    if host not in remote_homes:
        try:
            remote_homes[host] = resolve_remote_home(host)
        except RuntimeError as error:
            raise RuntimeError(f'cannot resolve merge-tree host home on {host}: {error}') from error
    payload = build_remote_merge_tree_command(base, rows, run_id)
    result = command(ssh_remote_command(host, payload), timeout=600)
    output = (result.stdout or '') + (result.stderr or '')
    if result.returncode:
        raise RuntimeError(f'batch-host merge-tree unmeasured on {host} rc={result.returncode}: {output[-1200:]}')
    unmeasured = re.search(r'^MERGE_TREE_UNMEASURED=(#[0-9]+:[^\n]+)$', output, re.M)
    if unmeasured:
        raise RuntimeError(f'batch-host merge-tree unmeasured: {unmeasured.group(1)}')
    conflicts = set(re.findall(r'^MERGE_TREE_CONFLICT=#([0-9]+)$', output, re.M))
    generated_only = set(re.findall(r'^MERGE_TREE_GENERATED_CONFLICT=#([0-9]+)$', output, re.M))
    clean = set(re.findall(r'^MERGE_TREE_CLEAN=#([0-9]+)$', output, re.M))
    mismatch_lines = re.findall(
        r'^MERGE_TREE_HEAD_MISMATCH=#([0-9]+) expected=([0-9a-f]{40}) actual=([0-9a-f]{40})$',
        output, re.M)
    head_mismatches = {pr: {'expected': expected, 'actual': actual}
                       for pr, expected, actual in mismatch_lines}
    if len(head_mismatches) != len(mismatch_lines):
        raise RuntimeError('batch-host merge-tree emitted duplicate head-mismatch rows')
    expected_heads = {str(row.pr): row.head for row in rows}
    if any(expected_heads.get(pr) != mismatch['expected']
           for pr, mismatch in head_mismatches.items()):
        raise RuntimeError('batch-host merge-tree head-mismatch identity differs from selected queue row')
    measured = clean | conflicts | generated_only | set(head_mismatches)
    expected = {str(row.pr) for row in rows}
    if measured != expected:
        raise RuntimeError(f'batch-host merge-tree result set mismatch: expected={sorted(expected)} measured={sorted(measured)}')
    return {'conflicts': conflicts, 'generated_only_conflicts': generated_only, 'head_mismatches': head_mismatches}


def defer_head_mismatches(rows, mismatches):
    """Drop only stale queue-head rows; other measured batch members remain eligible."""
    kept, deferred = [], []
    for row in rows:
        mismatch = mismatches.get(str(row.pr))
        if mismatch is None:
            kept.append(row)
            continue
        deferred.append({'pr': row.pr, 'reason': 'batch host head mismatch',
                         'expectedHead': mismatch['expected'], 'actualHead': mismatch['actual']})
    return kept, deferred


def notify_head_mismatch_owner(row, mismatch, repo_root):
    owner = row_owner(row, repo_root)
    body = (f'[TRAIN batch] #{row.pr} 큐 head 불일치로 이번 묶음에서 해당 행만 제외했습니다 · '
            f'queued={mismatch["expected"]} remote={mismatch["actual"]} · '
            '현재 PR head를 확인해 land-enqueue 줄을 갱신해 주세요.')
    key = (str(row.pr), str(mismatch['expected']).lower(), str(mismatch['actual']).lower())
    HEAD_MISMATCH_NOTICES.parent.mkdir(parents=True, exist_ok=True)
    with HEAD_MISMATCH_NOTICES.with_suffix('.lock').open('a', encoding='utf-8') as lock_stream:
        fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX)
        try:
            previous = []
            try:
                previous = [json.loads(line) for line in HEAD_MISMATCH_NOTICES.read_text(encoding='utf-8').splitlines()
                            if line.strip()]
            except FileNotFoundError:
                pass
            except (OSError, json.JSONDecodeError) as exc:
                return owner, subprocess.CompletedProcess([], 1, '', f'head mismatch notice ledger unreadable: {exc}')
            if any((str(item.get('pr')), str(item.get('queuedHead', '')).lower(),
                    str(item.get('remoteHead', '')).lower()) == key for item in previous):
                return owner, subprocess.CompletedProcess([], 0, 'duplicate notification suppressed', '')
            sent = send_typecheck_owner(owner, body, repo_root)
            if sent.returncode == 0:
                event = {'schema': 'elanous.train.head-mismatch-notice.v1',
                         'at': datetime.now().astimezone().isoformat(timespec='seconds'),
                         'pr': key[0], 'queuedHead': key[1], 'remoteHead': key[2], 'owner': owner}
                with HEAD_MISMATCH_NOTICES.open('a', encoding='utf-8') as stream:
                    stream.write(json.dumps(event, ensure_ascii=False, separators=(',', ':')) + '\n')
                    stream.flush()
                    os.fsync(stream.fileno())
            return owner, sent
        finally:
            fcntl.flock(lock_stream.fileno(), fcntl.LOCK_UN)


def acquire(path, logical_host=''):
    path = Path(path)
    owner = {'pid': os.getpid(), 'started': time.time(),
             'machine': socket.gethostname().lower(), 'logicalHost': str(logical_host)}
    deadline = time.monotonic() + 65
    while True:
        try:
            path.mkdir()
            marker = path / 'owner.json'
            temp = path / f'.owner-{os.getpid()}-{time.time_ns()}.tmp'
            temp.write_text(json.dumps(owner, separators=(',', ':')) + '\n', encoding='utf-8')
            os.replace(temp, marker)
            return path, owner
        except FileExistsError:
            try:
                before = path.stat()
            except OSError:
                continue
            try:
                existing = json.loads((path / 'owner.json').read_text())
                pid = int(existing.get('pid', 0))
                os.kill(pid, 0)
            except ProcessLookupError:
                pid = 0
            except PermissionError:
                pid = -1  # process exists but this user cannot signal it
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                # mkdir and owner publication are separate filesystem operations.
                # A competing acquirer must never classify that fresh gap as stale.
                if time.monotonic() < deadline and time.time() - before.st_mtime < 60:
                    time.sleep(0.05)
                    continue
                pid = 0
            if pid:
                raise RuntimeError(f'active batch lock owner pid={pid}: {path}')
            try:
                after = path.stat()
            except OSError:
                continue
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                continue
            stale = path.with_name(f'{path.name}.stale-{int(time.time())}-{os.getpid()}')
            try:
                path.rename(stale)
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f'dead batch lock could not be isolated: {path}: {exc}')
                time.sleep(0.05)


HOST_INFRA_PATTERNS = (
    'No space left on device', 'host-infra:',
    'ssh: connect to host', 'Operation timed out', 'Connection timed out',
)


def is_host_infra_reason(reason):
    """True when a refusal names host infrastructure, not the PR (OP 11-05 #34925/#35007)."""
    text = str(reason or '')
    return any(pattern in text for pattern in HOST_INFRA_PATTERNS)


def remote_setup_infra_detail(log_path):
    """Return a short host-infra diagnosis from a remote gate stdout log, or ''."""
    try:
        text = Path(log_path).read_text(errors='replace')
    except OSError:
        return ''
    if 'No space left on device' in text:
        line = next((l for l in text.splitlines() if 'No space left on device' in l), '')
        return f'host-infra: disk full (No space left on device) — {line.strip()[:200]}'
    return ''


def always_ratchet_detail(summary_path, data):
    """Name the first failing always-ratchet test from the preserved log (OP 11-05)."""
    ratchets = data.get('trainAlwaysRatchets')
    if not isinstance(ratchets, dict):
        return 'missing: summary has no trainAlwaysRatchets'
    if ratchets.get('tests') != list(TRAIN_ALWAYS_RATCHETS):
        return 'unbound: test list differs from train profile'
    status = f"status={ratchets.get('status')} exitCode={ratchets.get('exitCode')}"
    base = Path(summary_path).parent
    name = Path(summary_path).name
    order = (['handoff-art'] if 'handoff' in name else []) + (['retry-art'] if 'retry' in name else []) + ['primary-art']
    log_name = str(ratchets.get('log') or 'always-ratchets.log')
    for art in order:
        log = base / 'remote-artifacts' / art / log_name
        if not log.is_file():
            continue
        lines = log.read_text(errors='replace').splitlines()
        fails = [l for l in lines if l.startswith('(fail)')]
        header = next((l[:-1] for l in lines if re.match(r'^[A-Za-z0-9_./@+-]+\.test\.tsx?:$', l)), '')
        received = [l.strip()[1:].strip().strip('",') for l in lines if re.match(r'^\+\s+"', l)]
        if fails:
            first = fails[0][len('(fail) '):][:160]
            hint = f" received={'|'.join(received[:3])}" if received else ''
            return f'failed {status} fails={len(fails)} first={first}{hint} log={art}/{log_name}' + (f' file={header}' if header else '')
        return f'{status} log={art}/{log_name} (no (fail) line)'
    return f'{status} log not preserved'


def append_refusal_event(args, reason):
    """Persist an exact-head refusal so the manager can park on the second run."""
    try:
        queue_rows = {row.pr: row for row in read_queue(args.queue)}
    except Exception:
        queue_rows = {}
    summary = ''
    if args.artifacts:
        manifest_path = args.artifacts / 'manifest.json'
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            summary = str((manifest.get('preflight') or {}).get('summary') or '')
        except (OSError, ValueError, TypeError):
            pass
    REFUSAL_EVENTS.parent.mkdir(parents=True, exist_ok=True)
    with REFUSAL_EVENTS.with_suffix('.lock').open('a', encoding='utf-8') as lock_stream:
        fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX)
        with REFUSAL_EVENTS.open('a', encoding='utf-8') as stream:
            for pr in sorted(set(parse_exclude(args.authorize)), key=int):
                row = queue_rows.get(pr)
                # Ignore malformed/pre-queue CLI rejects; only exact queued heads count toward auto-park.
                if row is None or not re.fullmatch(r'[0-9a-f]{40}', row.head.lower()) or not re.fullmatch(r'[0-9]+', str(args.run_id)):
                    continue
                event = {
                    'schema': 'elanous.train.refusal.v1',
                    'at': datetime.now().astimezone().isoformat(timespec='seconds'),
                    'pr': pr, 'head': row.head.lower() if row else '',
                    'base': args.base.lower(), 'runId': str(args.run_id),
                    'host': str(args.host), 'reason': str(reason).replace('\n', ' ')[:1200],
                    'summary': summary, 'artifacts': str(args.artifacts or ''),
                }
                # OP 11-05 11:0x: host infrastructure (disk full etc.) is not a PR strike.
                if is_host_infra_reason(reason):
                    event['infra'] = True
                stream.write(json.dumps(event, ensure_ascii=False, separators=(',', ':')) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        fcntl.flock(lock_stream.fileno(), fcntl.LOCK_UN)


def process_is_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False


def acquire_claim_selection_lock(queue, timeout=300):
    """Serialize the final shared-claim read and direct-batch claim publication."""
    lock = Path(str(queue) + '.select.lock')
    deadline = time.monotonic() + timeout
    while True:
        try:
            lock.mkdir()
            (lock / 'pid').write_text(f'{os.getpid()}\n')
            return lock
        except FileExistsError:
            try:
                before = lock.stat()
            except OSError:
                continue
            try:
                pid = int((lock / 'pid').read_text().strip())
            except (OSError, ValueError):
                # Do not steal a freshly-created lock while its owner publishes pid.
                if time.time() - before.st_mtime < 6:
                    time.sleep(0.05)
                    continue
                pid = 0
            if pid and not process_is_alive(pid):
                try:
                    after = lock.stat()
                except OSError:
                    continue
                if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                    continue
                stale = lock.with_name(f'{lock.name}.stale-dead-owner-{int(time.time())}-{os.getpid()}')
                try:
                    lock.rename(stale)
                    continue
                except OSError:
                    pass
            if time.monotonic() >= deadline:
                raise RuntimeError(f'shared claim selection lock timeout: {lock}')
            time.sleep(0.25)


def release_claim_selection_lock(lock):
    try:
        pid = int((lock / 'pid').read_text().strip())
    except (OSError, ValueError):
        raise RuntimeError(f'shared claim selection lock owner missing: {lock}')
    if pid != os.getpid():
        raise RuntimeError(f'shared claim selection lock owner changed: {lock}')
    (lock / 'pid').unlink()
    lock.rmdir()


def reserve_claims_for_live_batch(queue, host, batch_lock, authorized, allow_preflight_overlap=False):
    """Exclude every live cross-host claim and publish direct express claims atomically."""
    claim_dir = Path.home() / 'elanous-hq/seat-state/OP/train-claims'
    claim_dir.mkdir(parents=True, exist_ok=True)
    lock_name = Path(batch_lock).name
    slot_suffix = lock_name.removeprefix(f'{Path(queue).name}.batch.lock.{host}')
    slot_suffix = slot_suffix.lstrip('.')
    own_path = claim_dir / (f'claim-{host}-{slot_suffix}.tsv' if slot_suffix else f'claim-{host}.tsv')
    excluded, direct_claim = set(), None
    for path in sorted(claim_dir.glob('claim-*.tsv')):
        try:
            fields = path.read_text().strip().split('\t')
            if len(fields) < 4 or not fields[0].isdigit():
                continue
            pid, claim_host, lock_text, prs_text = fields[:4]
            prs = {pr for pr in prs_text.split(',') if pr.isdigit()}
        except OSError:
            continue
        lock_path = Path(lock_text) if lock_text else None
        lock_pid = 0
        if lock_path and lock_path.is_dir():
            try:
                lock_pid = int(json.loads((lock_path / 'owner.json').read_text()).get('pid', 0))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                lock_pid = 0
        if path == own_path:
            # The loop owning this exact slot published the imminent batch under the
            # selection lock. Other same-host slots remain exclusions like other hosts.
            local_active = process_is_alive(pid)
            if local_active and prs == authorized:
                continue
            if local_active:
                raise RuntimeError(f'active same-slot train claim conflicts with authorization: {sorted(prs)}')
            stale = path.with_name(f'{path.name}.stale-{int(time.time())}-{os.getpid()}')
            try:
                path.rename(stale)
            except OSError as exc:
                raise RuntimeError(f'stale local train claim could not be isolated: {path}: {exc}')
            continue
        active = process_is_alive(lock_pid) if lock_pid else process_is_alive(pid)
        if active:
            excluded.update(prs)
        else:
            stale = path.with_name(f'{path.name}.stale-{int(time.time())}-{os.getpid()}')
            try:
                path.rename(stale)
            except OSError:
                # A concurrent loop may already have refreshed or retired this claim.
                continue
    overlap = authorized & excluded
    if overlap and not allow_preflight_overlap:
        raise RuntimeError(f'authorized PRs claimed by another live train: {sorted(overlap)}')
    if overlap and allow_preflight_overlap:
        excluded.difference_update(overlap)  # explicit OP-only preflight duplication; no land adapter runs
    if not own_path.exists():
        tmp = own_path.with_suffix('.tsv.tmp')
        tmp.write_text(f'{os.getpid()}\t{host}\t{batch_lock}\t{",".join(sorted(authorized, key=int))}\n')
        tmp.replace(own_path)
        direct_claim = own_path
    return excluded, direct_claim


def release_direct_claim(path, batch_lock):
    """Remove only the claim created by this direct batch; loop-owned claims persist."""
    if path is None:
        return
    try:
        fields = path.read_text().strip().split('\t')
    except OSError:
        return
    if len(fields) >= 3 and fields[0] == str(os.getpid()) and fields[2] == str(batch_lock):
        path.unlink(missing_ok=True)


def reserve_unmeasured_handoff(queue, excluded_hosts):
    """Reserve the next eligible train host before sending it the same integration."""
    preference = ('aws1', 'gcp1', 'gcp2', 'aws2', 'minim5', 'node-c')
    rows = {}
    for line in HOSTS_REGISTRY.read_text().splitlines():
        fields = line.split('\t')
        if len(fields) >= 8 and fields[7] == 'yes':
            rows[fields[0]] = fields
    for host in preference:
        if host in excluded_hosts or host not in rows or host_cap_is_zero(host):
            continue
        # A registry row only expresses preference; reserve only hosts that can
        # accept the handoff now. Avoid parking on an unreachable artifact home.
        try:
            probe = command(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, 'true'], timeout=8)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if probe.returncode != 0:
            continue
        lock_path = Path(f'{queue}.batch.lock.{host}')
        try:
            lock, owner = acquire(lock_path, host)
            return host, lock, owner
        except RuntimeError:
            continue
    return None


def release(path, owner):
    marker = path / 'owner.json'
    if json.loads(marker.read_text()) != owner:
        raise RuntimeError('lock owner changed; manual recovery required')
    marker.unlink()
    path.rmdir()


def release_acquired_lock(lock_handle):
    """Release with the immutable (path, owner-record) returned by acquire()."""
    release(*lock_handle)


def final_preflight_status(summary):
    """Classify only measured passes; an explicit no-tests skip is a pass when all gates pass."""
    verdict = summary.get('verdict')
    exit_code = summary.get('exitCode')
    typecheck = summary.get('typecheck') or {}
    ratchets = summary.get('trainAlwaysRatchets') or {}
    checks_passed = (typecheck.get('status') == 'passed'
                     and ratchets.get('status') == 'passed'
                     and ratchets.get('exitCode') == 0
                     and ratchets.get('tests') == list(TRAIN_ALWAYS_RATCHETS))
    no_tests = (verdict == 'skipped'
                and summary.get('artifactsUnavailable') == 'no-tests'
                and summary.get('shards') == 0)
    gate_passed = ((verdict in ('passed', 'pass') or no_tests) and exit_code == 0)
    if gate_passed and checks_passed:
        return 'passed'
    if verdict in ('failed', 'fail'):
        return 'failed'
    return 'unmeasured'


def make_plan(queue, repo, base, limit, exclude=frozenset()):
    queued = read_queue(queue)
    memory_excluded = memory_skip_set(queued, base)
    rows = [r for r in queued if r.pr not in exclude and r.pr not in memory_excluded]
    chosen, deferred = select(rows, merge_conflicts(repo, base, rows), limit)
    return {'schema': 1, 'base': base, 'selected': [r.as_dict() for r in chosen],
            'deferred': deferred + [{'pr': p, 'reason': 'same PR/head/base already measured in train-memory.jsonl'} for p in sorted(memory_excluded)],
            'excluded': sorted(set(exclude) | memory_excluded), 'liveReady': len(chosen) >= 1,
            'merge': 0, 'push': 0, 'gate': 0, 'land': 0}


def ssh_remote_command(host, command_text):
    """Keep remote bash -lc and its payload in one SSH command argument."""
    return ['ssh', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
            host, 'bash -lc ' + shlex.quote(command_text)]


def scp_transfer(source, destination):
    return ['scp', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
            str(source), str(destination)]


def validate_gate(path, base, integration, rows):
    data = json.loads(Path(path).read_text())
    if data.get('base40') != base or data.get('head40') != integration:
        raise RuntimeError('gate base/integration head mismatch')
    typecheck = data.get('typecheck')
    if (not isinstance(typecheck, dict) or typecheck.get('status') != 'passed'
            or typecheck.get('base40') != base or typecheck.get('head40') != integration
            or typecheck.get('exitCode') != 0):
        raise RuntimeError('integrated-branch typecheck missing, failed, or unbound')
    always_ratchets = data.get('trainAlwaysRatchets')
    if (not isinstance(always_ratchets, dict) or always_ratchets.get('status') != 'passed'
            or always_ratchets.get('exitCode') != 0
            or always_ratchets.get('tests') != list(TRAIN_ALWAYS_RATCHETS)):
        raise RuntimeError('always-ratchet bundle missing, failed, or unbound: '
                           + always_ratchet_detail(path, data))
    # OP 10-29 13:4x: 변경이 시험 반경에 닿지 않으면(삭제·.gitignore 등) gate 는 verdict=skipped · artifactsUnavailable=no-tests · shards 0 — 측정할 시험이 없다는 정당한 통과로 본다(회귀·미측정 0 조건 아래)
    skipped_ok = (data.get('verdict') == 'skipped' and data.get('artifactsUnavailable') == 'no-tests'
                  and data.get('shards') == 0 and data.get('exitCode') == 0)
    if data.get('verdict') not in ('passed', 'pass') and not skipped_ok:
        raise RuntimeError('gate verdict not pass')
    if any(data.get(k) != 0 for k in ('introduced', 'unknown', 'unrunImporters')):
        raise RuntimeError('gate has introduced/unknown/unrun importer results')
    # OP 10-28 03:5x: 기존 실패(preexisting)만 있으면 gate 는 exit 1 이지만 verdict=passed·introduced/unknown/unrun 0 이다 — 위 검사가 이미 회귀 0 을 보장한다
    preexisting_build = data.get('preexistingBuild')
    build_preexisting_ok = (isinstance(preexisting_build, dict)
                            and preexisting_build.get('status') == 'preexisting'
                            and preexisting_build.get('base40') == base
                            and preexisting_build.get('head40') == integration
                            and preexisting_build.get('baseExitCode') == 1
                            and preexisting_build.get('headExitCode') == 1
                            and preexisting_build.get('headLog') == 'gate.log'
                            and bool(preexisting_build.get('baseLog'))
                            and bool(preexisting_build.get('diagnosticFingerprint')))
    if data.get('exitCode') != 0 and not (
            data.get('preexisting', 0) and data.get('verdict') in ('passed', 'pass')
    ) and not (build_preexisting_ok and data.get('verdict') in ('passed', 'pass')):
        raise RuntimeError('gate exitCode must be zero')
    # Current gate JSON binds one integration HEAD; per-member provenance is
    # proven by the immutable batch manifest used to construct that tree.
    return data


def gate_is_unmeasured(path, base, integration):
    """Only a bound, explicitly unmeasured first result is eligible for one host reroute."""
    data = json.loads(Path(path).read_text())
    if data.get('base40') != base or data.get('head40') != integration:
        raise RuntimeError('unmeasured gate base/integration head mismatch')
    typecheck = data.get('typecheck')
    if data.get('verdict') != 'unmeasured' and not (
            isinstance(typecheck, dict) and typecheck.get('status') == 'unmeasured'):
        return False
    if not (data.get('unmeasuredByShard') or data.get('unmeasuredReason')
            or (isinstance(typecheck, dict) and typecheck.get('reason'))):
        raise RuntimeError('unmeasured gate has no shard-level reason')
    return True


def resolve_retry_host(primary_host, requested_host=''):
    """Use the primary slot unless the manager explicitly selects another host."""
    return requested_host or primary_host


def retry_needs_unmeasured_handoff(retry_summary, base, integration):
    """Any unmeasured retry gets one different-host handoff, regardless of primary verdict."""
    return gate_is_unmeasured(retry_summary, base, integration)


def gate_timeout_only_files_from_data(data):
    """Return unique, safe test files only for a failed gate with timeouts and no introduced failures."""
    if (data.get('verdict') != 'failed' or data.get('introduced') != 0
            or data.get('unknown') != 0 or data.get('unrunImporters') != 0):
        return []
    typecheck = data.get('typecheck')
    ratchets = data.get('trainAlwaysRatchets')
    if (not isinstance(typecheck, dict) or typecheck.get('status') != 'passed'
            or not isinstance(ratchets, dict) or ratchets.get('status') != 'passed'):
        return []
    text = str(data.get('verdictLine') or '')
    header = re.search(r'(?m)^\[gate-baseline\] introduced=0, preexisting=\d+, unknown=0, precondition-unmet=0, timed-out=([0-9]+)\b', text)
    if not header or int(header.group(1)) < 1:
        return []
    identities = re.findall(r'(?m)^- flaky-timeout:\s*(.+)$', text)
    if len(identities) != int(header.group(1)):
        return []
    files = []
    for identity in identities:
        file = identity.split(' > ', 1)[0]
        if (not re.fullmatch(r'(?:src|test|scripts)/[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?', file)
                or '..' in Path(file).parts):
            return []
        if file not in files:
            files.append(file)
    return files


def gate_timeout_only_files(summary_path):
    try:
        return gate_timeout_only_files_from_data(json.loads(Path(summary_path).read_text()))
    except Exception:
        return []


def gate_failed_introduced(path):
    """OP 10-28 00:1x: 부하 플레이키 — 같은 묶음이 실행마다 다른 시험을 introduced 로 낸다(node-b Pod 51·mbp 부하 100).
    primary 가 failed 면 --retry-host 로 지정한 실제 호스트에서 1회 재판정 — 진짜 회귀면 거기서도 재현돼 거부된다."""
    try:
        data = json.loads(Path(path).read_text())
    except Exception:
        return False
    typecheck = data.get('typecheck')
    always_ratchets = data.get('trainAlwaysRatchets')
    return (data.get('verdict') == 'failed'
            or (isinstance(typecheck, dict) and typecheck.get('status') == 'failed')
            or (isinstance(always_ratchets, dict) and always_ratchets.get('status') == 'failed'))


def parse_typecheck_error_lines(text):
    """Keep compiler error TS lines and extract file locations when present."""
    records = []
    ansi = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
    patterns = (
        re.compile(r'^(?P<file>.+?)\((?P<line>\d+),(?P<column>\d+)\):\s*error TS(?P<code>\d+):\s*(?P<message>.*)$'),
        re.compile(r'^(?P<file>.+?):(?P<line>\d+):(?P<column>\d+)\s+-\s+error TS(?P<code>\d+):\s*(?P<message>.*)$'),
        re.compile(r'^(?P<file>.+?):\s*error TS(?P<code>\d+):\s*(?P<message>.*)$'),
    )
    for source in text.splitlines():
        raw = ansi.sub('', source).strip()
        if not re.search(r'\berror TS\d+:', raw):
            continue
        match = next((pattern.match(raw) for pattern in patterns if pattern.match(raw)), None)
        records.append({
            'raw': raw,
            'file': _repo_path(match.group('file')) if match else None,
            'line': int(match.group('line')) if match and match.groupdict().get('line') else None,
            'column': int(match.group('column')) if match and match.groupdict().get('column') else None,
            'code': match.group('code') if match else None,
            'message': match.group('message') if match else None,
            'prs': [],
        })
    return records


def _repo_path(path):
    if not path:
        return ''
    value = path.replace('\\', '/')
    marker = '/elanous-agent/'
    if marker in value:
        value = value.rsplit(marker, 1)[1]
    while value.startswith('./'):
        value = value[2:]
    return value


def attribute_typecheck_errors(errors, pr_files):
    """Attach each compiler location to every queued PR that changed that path."""
    attributed = set()
    normalized_files = {
        str(pr): sorted({_repo_path(path) for path in files if _repo_path(path)})
        for pr, files in pr_files.items()
    }
    for error in errors:
        file_path = _repo_path(error.get('file'))
        matches = sorted(pr for pr, files in normalized_files.items()
                        if any(file_path == path or file_path.endswith('/' + path) for path in files)) if file_path else []
        error['prs'] = matches
        attributed.update(matches)
    return sorted(attributed)


def changed_line_hunks(repo, base, head):
    """Return added/changed line ranges and bounded diff evidence per path."""
    diff = command(['git', 'diff', '--no-ext-diff', '--unified=3', base, head], repo, 60)
    if diff.returncode:
        raise RuntimeError(f'typecheck attribution diff failed {head[:12]}: {diff.stderr[-500:]}')
    hunks, current = {}, None
    for line in diff.stdout.splitlines():
        if line.startswith('+++ b/'):
            current = _repo_path(line[6:])
            hunks.setdefault(current, [])
        elif line.startswith('@@') and current:
            match = re.search(r'\+(\d+)(?:,(\d+))?', line)
            if match:
                start = int(match.group(1)); count = int(match.group(2) or '1')
                hunks[current].append({'start': start, 'end': start + max(count, 1) - 1,
                                       'evidence': line})
        elif current and hunks[current]:
            evidence = hunks[current][-1].setdefault('lines', [])
            if len(evidence) < 10:
                evidence.append(line)
    return hunks


def typecheck_hunk_attribution(repo, base, rows, errors):
    by_pr = {row.pr: changed_line_hunks(repo, base, row.head) for row in rows}
    records = []
    for error in errors:
        path, line_no = _repo_path(error.get('file')), error.get('line')
        matches = []
        path_candidates = []
        if path:
            for pr, paths in by_pr.items():
                for changed_path, ranges in paths.items():
                    if path == changed_path or path.endswith('/' + changed_path):
                        path_candidates.extend((pr, changed_path, hunk) for hunk in ranges)
                        if line_no and hunk['start'] <= line_no <= hunk['end']:
                            matches.append({'pr': pr, 'path': changed_path,
                                            'hunk': f"{hunk['start']}-{hunk['end']}",
                                            'precision': 'file-line',
                                            'evidence': '\n'.join(hunk.get('lines', []))[:1200]})
        # The current main-delta script strips line/column while normalizing diagnostics.
        # A changed-file fallback is safe only when exactly one PR hunk owns that path.
        unique_owners = {(pr, changed_path) for pr, changed_path, _ in path_candidates}
        if not line_no and len(unique_owners) == 1:
            pr, changed_path = next(iter(unique_owners))
            for _, _, hunk in path_candidates:
                matches.append({'pr': pr, 'path': changed_path,
                                'hunk': f"{hunk['start']}-{hunk['end']}", 'precision': 'file-only-singleton',
                                'evidence': '\n'.join(hunk.get('lines', []))[:1200]})
        error['hunkMatches'] = matches
        records.append(error)
    return records


def row_owner(row, repo_root):
    """Resolve only from trusted seat/workspace roots; branch-name fragments are not addresses."""
    path = row.tree.rstrip('/') if row.tree else ''
    normalized = path.replace('\\', '/').lower()
    # Known pane-only workspaces carry their seat in the workspace root; the
    # trailing worktree name (e.g. priority27-launch-stall) is not an owner.
    if re.search(r'/(?:private/)?tmp/goalauth-harvest(?:[./-]|$)', normalized):
        return 'GOALAUTH'
    if re.search(r'/work/fprint-[^/]+(?:/|$)', normalized):
        return 'FPRINT'
    valid_seats = {p.name.upper() for p in (Path.home() / 'elanous-hq/seats').iterdir()
                   if p.is_dir() and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,31}', p.name)}
    parts = Path(path).parts if path else ()
    for marker in ('worktrees', 'seats'):
        if marker in parts:
            idx = parts.index(marker)
            if idx + 1 < len(parts):
                seat = parts[idx + 1].upper()
                if seat in valid_seats:
                    return seat
    # A seat-prefixed workspace folder is trusted only when that seat exists.
    if parts:
        candidate = parts[-1].split('-', 1)[0].upper()
        if candidate in valid_seats:
            return candidate
    return 'OP'


def send_typecheck_owner(owner, body, repo_root):
    """Send to a real seat mailbox, or use the known pane for GOALAUTH."""
    if owner == 'GOALAUTH':
        return subprocess.run(['zsh', str(Path.home() / 'elanous-hq/seat-state/OP/tools/pane-say.sh'),
                               'wJ:pR', body], capture_output=True, text=True, timeout=60)
    return subprocess.run(['eln', 'msg', 'post', '--from', 'TRAIN', '--to', owner,
                           '--kind', 'report', '--body', body], capture_output=True,
                          text=True, timeout=60)


def record_typecheck_rejections(repo, base, rows, summary_path, artifacts, log_path, post_op_summary=True):
    """Persist a no-strike typecheck marker and mail owners diagnostics intersecting their PR hunks."""
    summary_path = Path(summary_path)
    try:
        data = json.loads(summary_path.read_text())
    except Exception:
        data = {}
    tc = data.get('typecheck') if isinstance(data, dict) else None
    status = tc.get('status') if isinstance(tc, dict) else 'missing'
    if status not in ('failed', 'unmeasured', 'missing'):
        return
    errors = tc.get('errors', []) if isinstance(tc, dict) else []
    if status == 'failed' and not errors and log_path and Path(log_path).is_file():
        errors = parse_typecheck_error_lines(Path(log_path).read_text(errors='replace'))
    matched = typecheck_hunk_attribution(repo, base, rows, errors) if errors else []
    by_pr = {}
    for error in matched:
        for match in error.get('hunkMatches', []):
            by_pr.setdefault(match['pr'], []).append((error, match))
    marker_path = Path(artifacts) / 'typecheck-rejections.json'
    previous = {}
    if marker_path.is_file():
        try: previous = json.loads(marker_path.read_text())
        except Exception: previous = {}
    entries = previous.get('prs', {}) if isinstance(previous, dict) else {}
    previous_entries = json.loads(json.dumps(entries))
    row_map = {row.pr: row for row in rows}
    for row in rows:
        pr = row.pr
        if pr in by_pr:
            entries[pr] = {'head': row.head, 'owner': row_owner(row, repo),
                           'status': 'typecheck-rejected-no-strike',
                           'diagnostics': [error['raw'] for error, _ in by_pr[pr]],
                           'hunks': [match for _, match in by_pr[pr]]}
        else:
            entries.setdefault(pr, {'head': row.head, 'status': f'typecheck-{status}-no-strike',
                                    'reason': (tc or {}).get('reason', 'diagnostic did not intersect a unique PR hunk')})
    marker = {'schema': 1, 'base': base, 'summary': str(summary_path), 'prs': entries}
    marker_path.write_text(json.dumps(marker, indent=2) + '\n')
    mailed = []
    for pr, evidence in by_pr.items():
        old = previous_entries.get(pr, {})
        owner = row_owner(row_map[pr], repo)
        if (old.get('head') == row_map[pr].head and old.get('owner') == owner
                and old.get('diagnostics') == [e['raw'] for e, _ in evidence]):
            continue
        lines = []
        for error, match in evidence:
            lines.append(f"{error['raw']}\n닿는 PR hunk {match['path']}:{match['hunk']} · precision={match['precision']} (PR #{pr})\n{match['evidence']}")
        body = (f'[TRAIN typecheck] #{pr} 타입검사 거부 · strike 없음 · 기준 main={base} · head={row_map[pr].head[:12]} · batch={Path(artifacts).name}\n'
                + '\n'.join(lines) + f'\n기록 {marker_path}')
        sent = send_typecheck_owner(owner, body, repo)
        log(f'typecheck rejection marker #{pr} owner={owner} mail_rc={sent.returncode}')
        if sent.returncode == 0:
            entries[pr]['owner'] = owner
            mailed.append((pr, owner))
    if mailed and post_op_summary:
        marker_path.write_text(json.dumps(marker, indent=2) + '\n')
        summary_body = f"[TRAIN] typecheck 귀속 {len(mailed)}건 발송: " + ', '.join(f'#{pr}→{owner}' for pr, owner in mailed)
        subprocess.run(['eln', 'msg', 'post', '--from', 'TRAIN', '--to', 'OP',
                        '--kind', 'report', '--body', summary_body], capture_output=True,
                       text=True, timeout=60)


def enrich_typecheck_summary(summary_path, log_path, pr_files):
    """Recover remote tsc output into the local summary artifact before retry selection."""
    summary_path, log_path = Path(summary_path), Path(log_path)
    data = json.loads(summary_path.read_text())
    typecheck = data.get('typecheck')
    if not isinstance(typecheck, dict) or typecheck.get('status') != 'failed':
        return data
    errors = parse_typecheck_error_lines(log_path.read_text(errors='replace'))
    attributed = attribute_typecheck_errors(errors, pr_files)
    typecheck['errorLines'] = [error['raw'] for error in errors]
    typecheck['errors'] = errors
    typecheck['prFiles'] = {str(pr): sorted(files) for pr, files in pr_files.items()}
    typecheck['attributedPrs'] = attributed
    typecheck['unattributedErrorLines'] = [error['raw'] for error in errors if not error['prs']]
    typecheck['localLog'] = str(log_path)
    summary_path.write_text(json.dumps(data, indent=2) + '\n')
    return data


def typecheck_retry_rows(rows, summary_path):
    """Retry with only PRs whose diagnostics uniquely intersect a changed hunk removed."""
    data = json.loads(Path(summary_path).read_text())
    typecheck = data.get('typecheck')
    if not isinstance(typecheck, dict) or typecheck.get('status') != 'failed':
        return list(rows), []
    marker_path = Path(summary_path).parent / 'typecheck-rejections.json'
    try:
        marker = json.loads(marker_path.read_text())
        entries = marker.get('prs', {}) if isinstance(marker, dict) else {}
    except (OSError, ValueError, TypeError):
        entries = {}
    heads = {row.pr: row.head for row in rows}
    excluded = {str(pr) for pr, entry in entries.items()
                if isinstance(entry, dict) and entry.get('status') == 'typecheck-rejected-no-strike'
                and heads.get(str(pr)) == entry.get('head')}
    return [row for row in rows if row.pr not in excluded], sorted(excluded)


def typecheck_retry_plan(rows, summary_path):
    """Treat attribution that excludes the entire batch as no usable attribution."""
    retry, excluded = typecheck_retry_rows(rows, summary_path)
    if excluded and not retry:
        return list(rows), [], True
    return retry, excluded, False


def typecheck_isolation_partition(rows, outcomes):
    """Exclude singleton-proven failures; all-excluded falls back to the intact batch."""
    by_pr = {str(item.get('pr')): item.get('status') for item in outcomes}
    if len(by_pr) != len(outcomes) or set(by_pr) != {str(row.pr) for row in rows}:
        raise RuntimeError('single-PR typecheck isolation result set mismatch')
    if any(status not in ('passed', 'failed') for status in by_pr.values()):
        raise RuntimeError('single-PR typecheck isolation contains unmeasured result')
    excluded = sorted(pr for pr, status in by_pr.items() if status == 'failed')
    survivors = [row for row in rows if by_pr[str(row.pr)] == 'passed']
    if not survivors:
        return list(rows), []
    return survivors, excluded


def changed_files_by_pr(repo, base, rows):
    result = {}
    for row in rows:
        diff = command(['git', 'diff', '--name-only', base, row.head], repo)
        if diff.returncode:
            raise RuntimeError(f'PR changed-file attribution unavailable #{row.pr}: {diff.stderr[-1000:]}')
        result[row.pr] = sorted({line for line in diff.stdout.splitlines() if line})
    return result


def plan_retry_for_batch(rows, primary_pr_files, *, attributed, attributed_pr_files=None):
    """Pure retry-plan entrypoint shared by the train manager and its simulation replay."""
    retry_rows = list(rows)
    if attributed:
        if not isinstance(attributed_pr_files, dict):
            raise RuntimeError('attributed retry requires a measured per-PR file map')
        retry_pr_files = attributed_pr_files
    else:
        retry_pr_files = primary_pr_files
    return {'stage': 'retry', 'rows': retry_rows, 'pr_files': retry_pr_files,
            'attributed': bool(attributed)}


def classify_batch_gate(repo, base, rows, pr_files):
    """Use the policy classifier on exact per-PR paths; any uncertainty means full gate."""
    decisions = []
    try:
        for row in rows:
            paths = pr_files.get(row.pr)
            if not paths:
                return 'T2', [{'pr': row.pr, 'tier': 'T2', 'rules': ['changed-files-unavailable']}]
            diff = command(['git', 'diff', '--numstat', base, row.head], repo)
            if diff.returncode:
                return 'T2', [{'pr': row.pr, 'tier': 'T2', 'rules': ['changed-line-count-unavailable']}]
            additions = deletions = 0
            for line in diff.stdout.splitlines():
                fields = line.split('\t', 2)
                if len(fields) >= 2:
                    if fields[0].isdigit(): additions += int(fields[0])
                    if fields[1].isdigit(): deletions += int(fields[1])
            changes = [{'path': path, 'additions': 0, 'deletions': 0} for path in paths]
            changes[0]['additions'] = additions
            changes[0]['deletions'] = deletions
            decision = _gate_tier.classify({'changes': changes})
            decisions.append({'pr': row.pr, **decision.as_json()})
    except Exception as exc:
        return 'T2', [{'tier': 'T2', 'rules': [f'classifier-error:{type(exc).__name__}']}]
    tier = 'T2' if any(item['tier'] == 'T2' for item in decisions) else 'T1'
    return tier, decisions


def gate_failure_file_attribution(pr_files, rows, summary_path, artifacts):
    """Resolve introduced-test and always-ratchet paths to changed PR files.

    Attribution is fail-closed: a path must be changed by exactly one member.
    The result is a durable no-ambiguity marker consumed by the retry planner.
    """
    summary_path = Path(summary_path)
    artifacts = Path(artifacts)
    try:
        summary = json.loads(summary_path.read_text())
    except (OSError, ValueError, TypeError):
        return [], []
    normalized = {str(pr): {_repo_path(path) for path in files}
                  for pr, files in pr_files.items()}

    failures = []
    for line in str(summary.get('verdictLine', '')).splitlines():
        if not line.startswith('- introduced: '):
            continue
        path = _repo_path(line[len('- introduced: '):].split(' > ', 1)[0].strip())
        if path:
            failures.append({'cause': 'introduced', 'path': path, 'evidence': line})

    ratchet_path = artifacts / 'remote-artifacts' / 'primary-art' / 'always-ratchets.log'
    if not ratchet_path.is_file():
        ratchet_path = artifacts / 'primary-art' / 'always-ratchets.log'
    if ratchet_path.is_file():
        lines = ratchet_path.read_text(errors='replace').splitlines()
        for fail_index, line in enumerate(lines):
            if not re.match(r'^\(fail\)', line):
                continue
            header_index = next((i for i in range(fail_index - 1, -1, -1)
                                 if re.match(r'^[A-Za-z0-9_./@+-]+\.test\.tsx?:$', lines[i])), None)
            if header_index is None:
                continue
            header = lines[header_index][:-1]
            block = '\n'.join(lines[header_index:fail_index + 1])
            for path in re.findall(r'["\']((?:[A-Za-z0-9_.@+-]+/)+[A-Za-z0-9_.@+-]+)["\']', block):
                path = _repo_path(path)
                if path and not path.endswith('.test.ts'):
                    failures.append({'cause': 'always-ratchet', 'path': path,
                                     'evidence': f'{header}: {path}'})

    # Deduplicate path/cause, then retain only unique file owners.
    owned, attributed = [], set()
    seen = set()
    for failure in failures:
        key = (failure['cause'], failure['path'])
        if key in seen:
            continue
        seen.add(key)
        owners = sorted(pr for pr, files in normalized.items()
                        if failure['path'] in files)
        failure['owners'] = owners
        if len(owners) == 1:
            failure['pr'] = owners[0]
            attributed.add(owners[0])
        owned.append(failure)
    row_heads = {str(row.pr): row.head for row in rows}
    entries = {}
    for pr in sorted(attributed):
        entries[pr] = {'head': row_heads[pr], 'status': 'gate-rejected-no-strike',
                       'failures': [item for item in owned if item.get('pr') == pr]}
    marker = {'schema': 1, 'base': summary.get('base40'),
              'integrationHead': summary.get('head40'), 'summary': str(summary_path),
              'failures': owned, 'prs': entries}
    marker_path = artifacts / 'gate-rejections.json'
    marker_path.write_text(json.dumps(marker, indent=2) + '\n')
    return sorted(attributed), owned


def gate_attributed_retry_rows(rows, artifacts):
    marker_path = Path(artifacts) / 'gate-rejections.json'
    try:
        marker = json.loads(marker_path.read_text())
        entries = marker.get('prs', {}) if isinstance(marker, dict) else {}
    except (OSError, ValueError, TypeError):
        entries = {}
    heads = {str(row.pr): row.head for row in rows}
    excluded = {str(pr) for pr, entry in entries.items()
                if isinstance(entry, dict) and entry.get('status') == 'gate-rejected-no-strike'
                and heads.get(str(pr)) == entry.get('head')}
    remaining = [row for row in rows if str(row.pr) not in excluded]
    return (remaining if remaining else list(rows)), sorted(excluded if remaining else [])


def remote_integration_paths(host, run_id, suffix, home):
    if not re.fullmatch(r'[A-Za-z0-9._-]+', host) or not re.fullmatch(r'[0-9]+', str(run_id)):
        raise ValueError('invalid remote integration identity')
    if not re.fullmatch(r'[A-Za-z0-9._-]+', suffix):
        raise ValueError('invalid remote integration suffix')
    if not str(home).startswith('/'):
        raise ValueError('remote integration home must be absolute')
    root = f'{home}/elanous-hq/seat-state/OP/train-artifacts/batch-{run_id}'
    return (f'{root}/integration-{suffix}', f'{root}/integration-{suffix}.bundle')


def remote_batch_root(home, run_id, suffix):
    if not re.fullmatch(r'[0-9]+', str(run_id)) or not re.fullmatch(r'[A-Za-z0-9._-]+', suffix):
        raise ValueError('invalid remote batch identity')
    if not str(home).startswith('/'):
        raise ValueError('remote batch home must be absolute')
    return f'{home}/elanous-hq/seat-state/OP/train-artifacts/batch-{run_id}/{suffix}'


def build_remote_integration_command(base, rows, worktree, bundle, run_id, suffix):
    """Create the exact PR subset integration tree and bundle in the batch host clone."""
    if not re.fullmatch(r'[0-9a-f]{40}', base):
        raise ValueError('invalid integration base')
    if not rows:
        raise ValueError('cannot build an empty integration')
    generated_pattern = generated_output_ere()
    lines = [
        'set -euo pipefail',
        'umask 022',
        'cd ~/source/elanous-agent',
        'git fetch -q origin main',
        f'git cat-file -e {base}^{{commit}}',
        f'worktree={shlex.quote(worktree)}',
        f'bundle={shlex.quote(bundle)}',
        '[ ! -e "$worktree" ] && [ ! -e "$bundle" ]',
        'mkdir -p "$(dirname "$worktree")"',
        'git worktree add --detach "$worktree" ' + shlex.quote(base),
        'if git remote get-url github >/dev/null 2>&1; then pull_remote=github; else pull_remote=origin; fi',
    ]
    for row in rows:
        if not str(row.pr).isdigit() or not re.fullmatch(r'[0-9a-f]{40}', row.head):
            raise ValueError('invalid integration PR/head')
        ref = f'refs/opt-train/{run_id}/{suffix}/{row.pr}'
        pull_ref = f'refs/pull/{row.pr}/head'
        lines.extend([
            f'git fetch -q "$pull_remote" +{pull_ref}:{pull_ref}',
            f'pulled=$(git rev-parse {pull_ref})',
            f'git update-ref {ref} "$pulled"',
            f'actual=$(git rev-parse {ref})',
            f'[ "$actual" = {row.head} ] || {{ echo "integration head mismatch #{row.pr}:$actual"; exit 41; }}',
            f'if git -C "$worktree" -c user.name=OP-train -c user.email=op-train@local merge --no-ff --no-edit {ref}; then',
            '  :',
            'else',
            '  rc=$?',
            '  if [ -n "$(git -C "$worktree" ls-files -u)" ]; then',
            '    mapfile -t conflict_paths < <(git -C "$worktree" diff --name-only --diff-filter=U)',
            f'    if [ "${{#conflict_paths[@]}}" -gt 0 ] && ! printf "%s\\n" "${{conflict_paths[@]}}" | grep -Ev "^({generated_pattern})$" >/dev/null; then',
            '      git -C "$worktree" checkout --ours -- "${conflict_paths[@]}"',
            '      git -C "$worktree" add -- "${conflict_paths[@]}"',
            '      git -C "$worktree" -c user.name=OP-train -c user.email=op-train@local commit --no-edit',
            '      echo "TRAIN_GENERATED_CONFLICTS_KEPT_FOR_REGEN #{row.pr}"',
            '    else echo "TRAIN_INTEGRATION_CONFLICT #{row.pr}"; exit "$rc"; fi',
            '  else echo "TRAIN_INTEGRATION_MERGE_ERROR #{row.pr} rc=$rc" >&2; exit "$rc"; fi',
            'fi',
        ])
    lines.extend([
        'integration=$(git -C "$worktree" rev-parse HEAD)',
        '[[ "$integration" =~ ^[0-9a-f]{40}$ ]]',
        'git -C "$worktree" bundle create "$bundle" HEAD ' + shlex.quote(base) + ' ' + shlex.quote('^' + base + '^'),
        '[ -s "$bundle" ]',
        'printf "INTEGRATION_HEAD=%s\\nINTEGRATION_BUNDLE=%s\\n" "$integration" "$bundle"',
    ])
    return '\n'.join(lines)


def integrate_rows_remote(host, base, rows, run_id, suffix, resources, remote_homes):
    """Build one integration on its batch host and retain exact cleanup ownership."""
    if host not in remote_homes:
        remote_homes[host] = resolve_remote_home(host)
    worktree, bundle = remote_integration_paths(host, run_id, suffix, remote_homes[host])
    refs = [f'refs/opt-train/{run_id}/{suffix}/{row.pr}' for row in rows]
    resource = {'host': host, 'worktree': worktree, 'bundle': bundle, 'refs': refs}
    resources.append(resource)  # cleanup also covers a partially-created remote worktree
    payload = build_remote_integration_command(base, rows, worktree, bundle, run_id, suffix)
    result = command(ssh_remote_command(host, payload), timeout=900)
    output = (result.stdout or '') + (result.stderr or '')
    if result.returncode:
        failed_merge = re.search(r'^TRAIN_INTEGRATION_CONFLICT #([0-9]+)$', output, re.M)
        detail = output[-1600:]
        if failed_merge:
            raise RuntimeError(f'integration merge failed #{failed_merge.group(1)}: {detail}')
        raise RuntimeError(f'remote integration failed on {host} rc={result.returncode}: {detail}')
    head = re.search(r'^INTEGRATION_HEAD=([0-9a-f]{40})$', output, re.M)
    remote_bundle = re.search(r'^INTEGRATION_BUNDLE=(.+)$', output, re.M)
    if not head or not remote_bundle or remote_bundle.group(1) != bundle:
        raise RuntimeError(f'remote integration result unmeasured on {host}: {output[-1000:]}')
    return {'host': host, 'head': head.group(1), 'bundle': bundle, 'worktree': worktree}


def cleanup_remote_integrations(resources):
    """Remove only the integration worktrees and bundles this invocation created."""
    errors = []
    for item in reversed(resources):
        payload = (
            'set -e; cd ~/source/elanous-agent; '
            f'if [ -e {shlex.quote(item["worktree"])} ]; then '
            f'git worktree remove --force {shlex.quote(item["worktree"])}; fi; '
            f'rm -f -- {shlex.quote(item["bundle"])}; '
            + '; '.join(f'git update-ref -d {shlex.quote(ref)} || true' for ref in item['refs'])
            + '; git worktree prune'
        )
        result = command(ssh_remote_command(item['host'], payload), timeout=180)
        if result.returncode:
            errors.append(f'{item["host"]}:{item["worktree"]} rc={result.returncode}')
    if errors:
        raise RuntimeError('remote integration cleanup failed: ' + '; '.join(errors))


def cleanup_remote_bundle_copies(copies):
    """Remove only cross-host bundle copies staged for retry/handoff gates."""
    errors = []
    for item in reversed(copies):
        result = command(ssh_remote_command(
            item['host'], f'rm -f -- {shlex.quote(item["path"])}'), timeout=60)
        if result.returncode:
            errors.append(f'{item["host"]}:{item["path"]} rc={result.returncode}')
    if errors:
        raise RuntimeError('remote retry bundle cleanup failed: ' + '; '.join(errors))


def select_gate_summary(primary, retry, base, integration, rows, retry_host='retry host'):
    if retry is not None and gate_failed_introduced(primary):
        if gate_is_unmeasured(retry, base, integration):
            raise RuntimeError(f'{retry_host} retry of failed primary remained unmeasured; landing refused')
        return validate_gate(retry, base, integration, rows), 2
    if gate_is_unmeasured(primary, base, integration):
        if retry is None:
            raise RuntimeError(f'unmeasured primary gate requires retry on {retry_host}')
        if gate_is_unmeasured(retry, base, integration):
            raise RuntimeError(f'{retry_host} retry remained unmeasured; landing refused')
        return validate_gate(retry, base, integration, rows), 2
    return validate_gate(primary, base, integration, rows), 1


def merge_gate_receipt_marker(log_path, repo):
    """Merge the validated remote writer marker into the local common-dir registry."""
    text = Path(log_path).read_text()
    markers = re.findall(r'^__GATE_RECEIPTS__([A-Za-z0-9+/=]+)$', text, re.M)
    if not markers:
        return {'saved': 0, 'reason': 'remote receipt marker missing'}
    installed_module = (Path.home() / '.local/share/elanous/current/node_modules/elanous' /
                        'src/self-implement/train-gate-remote.ts').resolve()
    script = (
        f'const m=await import({json.dumps(str(installed_module))}); '
        'const p=m.gateReceiptRegistryPathForRepo(process.cwd()); '
        'if(!p)process.exit(2); '
        'console.log(m.mergeGateReceiptRegistryPayload(process.env.ELANOUS_RECEIPT_PAYLOAD,p));'
    )
    env = {**os.environ, 'ELANOUS_RECEIPT_PAYLOAD': markers[-1]}
    result = subprocess.run(['bun', '-e', script], cwd=repo, env=env, text=True,
                            capture_output=True, timeout=60)
    if result.returncode:
        return {'saved': 0, 'reason': (result.stderr or result.stdout or 'merge helper failed')[-500:]}
    try:
        saved = int(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {'saved': 0, 'reason': 'merge helper returned no count'}
    return {'saved': saved, 'registry': 'git-common-dir/elanous-host-regate/gate-receipts.json'}


def land_single_command(script, run_id, row, side_main, gate_host, summary):
    return ['zsh', str(script), run_id, row.pr, row.head,
            side_main[:12], gate_host, str(summary)]


def remote_worker_setup(remote_art, remote_tmpdir):
    """Keep shared batch artifacts readable while isolating worker temp/state from the host profile."""
    art = shlex.quote(remote_art)
    scratch = shlex.quote(remote_tmpdir)
    state_root = shlex.quote(f'{remote_tmpdir}/state')
    return (
        f"umask 022; mkdir -p {art}; "
        f"umask 077; mkdir -m 700 -p {scratch} {state_root}; "
        f"chmod 700 {scratch} {state_root}; "
        f"export TMPDIR={scratch} ELANOUS_STATE_DIR={state_root}; umask 022; "
    )


def remote_dependency_scratch_cleanup(remote_tmpdir, remote_art):
    """Clean only this invocation's worktree-deps scratch, without changing its gate rc."""
    scratch = shlex.quote(remote_tmpdir)
    art = shlex.quote(remote_art)
    return (
        "cleanup_dependency_scratch() { "
        "cleanup_rc=0; physical_dir() { (CDPATH= cd \"$1\" 2>/dev/null && pwd -P); }; "
        f"artifact_real=$(physical_dir {art}) || cleanup_rc=$?; "
        f"scratch_real=$(physical_dir {scratch}) || cleanup_rc=$?; "
        "if [ \"$cleanup_rc\" -eq 0 ]; then "
        "expected_scratch=\"${artifact_real%/*}/primary-tmp\"; "
        "if [ \"$scratch_real\" != \"$expected_scratch\" ]; then cleanup_rc=1; "
        "else dep_path=\"$scratch_real/state/worktree-deps\"; "
        "if [ -e \"$dep_path\" ] || [ -L \"$dep_path\" ]; then "
        "dep_real=$(physical_dir \"$dep_path\") || cleanup_rc=$?; "
        "if [ \"$cleanup_rc\" -eq 0 ]; then "
        "case \"$dep_real/\" in \"$scratch_real/\"*) "
        "if [ \"$dep_real\" = \"$scratch_real\" ]; then cleanup_rc=1; "
        "else chmod -R u+w -- \"$dep_real\" || cleanup_rc=$?; "
        "if [ \"$cleanup_rc\" -eq 0 ]; then rm -rf -- \"$dep_real\" || cleanup_rc=$?; fi; fi ;; "
        "*) cleanup_rc=1 ;; esac; fi; fi; fi; fi; "
        "printf '[train-batch-cleanup] dependency-scratch rc=%s\\n' \"$cleanup_rc\" >> \"$artifact_real/cleanup.log\" 2>/dev/null || "
        "printf '[train-batch-cleanup] dependency-scratch rc=%s\\n' \"$cleanup_rc\" >&2; "
        "return 0; }; "
    )


def remote_worker_cleanup_trap(remote_tree, remote_tmpdir, remote_art, helper=None):
    """Run cleanup on EXIT while preserving the command's original status."""
    tree = shlex.quote(remote_tree)
    scratch = shlex.quote(remote_tmpdir)
    helper_cleanup = f"rm -f -- {shlex.quote(helper)}; " if helper else ""
    return (
        "cleanup() { cleanup_original_rc=$?; trap - EXIT; "
        "if [ \"$worktree_created\" = 1 ]; then "
        f"{remote_dependency_scratch_cleanup(remote_tmpdir, remote_art)} "
        "cleanup_dependency_scratch; "
        f"git -C ~/source/elanous-agent worktree remove --force {tree} >/dev/null 2>&1 || true; "
        "else "
        f"rmdir -- {shlex.quote(remote_tmpdir + '/state')} {scratch} >/dev/null 2>&1 || true; fi; "
        f"{helper_cleanup}"
        "git -C ~/source/elanous-agent worktree prune >/dev/null 2>&1 || true; "
        "exit \"$cleanup_original_rc\"; }; trap cleanup EXIT; "
    )


def remote_worktree_dependency_prep(remote_art):
    """Install and record dependencies before any gate runs in a fresh remote worktree."""
    art = shlex.quote(remote_art)
    prep_log = shlex.quote(f'{remote_art}/dependency-prepare.log')
    return (
        f"mkdir -p {art}; "
        f"printf '%s\\n' '[worktree-prepare] root bun install --frozen-lockfile' > {prep_log}; "
        f"bun install --frozen-lockfile >> {prep_log} 2>&1 || "
        f"{{ rc=$?; echo \"[worktree-prepare] root install failed rc=$rc\" >> {prep_log}; "
        f"tail -n 30 {prep_log}; exit $rc; }}; "
        f"(cd apps/pwa && bun install --frozen-lockfile) >> {prep_log} 2>&1 || "
        f"{{ rc=$?; echo \"[worktree-prepare] apps/pwa install failed rc=$rc\" >> {prep_log}; "
        f"tail -n 30 {prep_log}; exit $rc; }}; "
        "test -f node_modules/typescript/package.json || "
        f"{{ echo '[worktree-prepare] typescript package missing after frozen install' | tee -a {prep_log}; "
        "exit 86; }; "
        f"echo '[worktree-prepare] dependencies ready; typescript present' >> {prep_log}; "
        "echo WORKTREE_DEPENDENCIES_READY"
    )


def recover_completed_shard_verdict(repo, artifact_dir, base, head):
    # Aggregate the bound per-shard JUnit receipts when the final summary write timed out.
    artifact_dir = Path(artifact_dir)
    try:
        progress = json.loads((artifact_dir / 'progress.json').read_text())
    except (OSError, ValueError):
        return None
    done, total = progress.get('completedShards'), progress.get('totalShards')
    files_done, files_total = progress.get('completedFiles'), progress.get('totalFiles')
    if not (isinstance(done, int) and done > 0 and done == total
            and isinstance(files_done, int) and files_done == files_total):
        return None

    pairs = {}
    pattern = re.compile(r'^shard-(\d+)-(\d+)-(current|baseline)\.result\.json$')
    for result_path in artifact_dir.glob('shard-*-*.result.json'):
        match = pattern.match(result_path.name)
        if not match:
            continue
        shard_id, attempt, side = match.group(1), int(match.group(2)), match.group(3)
        try:
            result = json.loads(result_path.read_text())
        except (OSError, ValueError):
            continue
        junit_path = artifact_dir / Path(str(result.get('junitPath') or '')).name
        if not result.get('junitPath') or not junit_path.is_file() or result.get('signal'):
            continue
        pairs.setdefault(shard_id, {}).setdefault(attempt, {})[side] = (result, junit_path, result_path)

    shards, attempts, details, file_count = [], [], [], 0
    for shard_id in sorted(pairs, key=int):
        complete = [(number, pair) for number, pair in pairs[shard_id].items()
                    if 'current' in pair and 'baseline' in pair]
        if not complete:
            return None
        number, pair = max(complete, key=lambda item: item[0])
        current, current_junit, current_result = pair['current']
        baseline, baseline_junit, baseline_result = pair['baseline']
        cohort = current.get('cohort') or []
        if (current.get('head40') != head or baseline.get('head40') != base
                or cohort != (baseline.get('cohort') or []) or not cohort):
            return None
        file_count += len(cohort)
        key = f'shard-{shard_id}'
        shards.append({'id': key, 'files': cohort})
        attempts.append({'shardId': key, 'attempt': number,
                         'currentJUnitPath': str(current_junit), 'baselineJUnitPath': str(baseline_junit),
                         'currentExitCode': current.get('rc'), 'baselineExitCode': baseline.get('rc'),
                         'currentSignal': current.get('signal'), 'baselineSignal': baseline.get('signal'),
                         'baselineFiles': []})
        details.append({'shardId': key, 'attempt': number, 'files': cohort,
                        'current': {**current, 'junitPath': str(current_junit), 'resultPath': str(current_result)},
                        'baseline': {**baseline, 'junitPath': str(baseline_junit), 'resultPath': str(baseline_result)}})
    if len(shards) != total or file_count != files_total:
        return None

    listed = command(['git', '-C', str(repo), 'ls-tree', '-r', '--name-only', base], timeout=120)
    if listed.returncode:
        return None
    base_files = set(listed.stdout.splitlines())
    for attempt in attempts:
        shard = next(item for item in shards if item['id'] == attempt['shardId'])
        attempt['baselineFiles'] = [file for file in shard['files'] if file in base_files]
    env = os.environ.copy()
    env['OP_TRAIN_AGGREGATE'] = json.dumps({'shards': shards, 'attempts': attempts})
    js = "const fs=require('node:fs');const {aggregateGateTestShards}=await import('./src/self-dev/shard-aggregate.ts');const x=JSON.parse(process.env.OP_TRAIN_AGGREGATE);const a=x.attempts.map(({currentJUnitPath,baselineJUnitPath,...v})=>({...v,currentJUnit:fs.readFileSync(currentJUnitPath,'utf8'),baselineJUnit:fs.readFileSync(baselineJUnitPath,'utf8')}));console.log(JSON.stringify(aggregateGateTestShards(x.shards,a)));"
    aggregate = subprocess.run([str(Path.home() / '.bun/bin/bun'), '-e', js], cwd=repo,
                               env=env, text=True, capture_output=True, timeout=120)
    if aggregate.returncode:
        return None
    try:
        result = json.loads(aggregate.stdout.strip().splitlines()[-1])
        report, verdict = result.get('report') or {}, result.get('status')
    except (ValueError, IndexError, AttributeError):
        return None
    if verdict not in ('passed', 'pass', 'failed', 'unmeasured', 'skipped'):
        return None
    summary = {'base40': base, 'head40': head, 'verdict': verdict,
               'exitCode': 0 if verdict in ('passed', 'pass', 'skipped') else 1,
               'introduced': report.get('introduced', 0), 'preexisting': report.get('preexisting', 0),
               'unknown': report.get('unknown', 0), 'preconditionUnmet': report.get('preconditionUnmet', 0),
               'unrunImporters': report.get('unrunImporters', 0), 'shards': len(shards), 'shardsDetail': details,
               'verdictLine': f'[train-shard-recovery] {verdict}; all {done}/{total} shards and {files_done}/{files_total} files complete; judged from SHA-bound JUnit outputs',
               'trainShardRecovery': {'status': verdict, 'progress': progress,
                                      'source': 'bound per-shard result/JUnit'}}
    (artifact_dir / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    return summary


def build_remote_gate_command(base, integration, remote_bundle, remote_tree, remote_art, remote_remeasure_helper, timeout, shards, remote_path, remote_tmpdir, gate_tier='T1'):
    scratch = shlex.quote(remote_tmpdir)
    helper = shlex.quote(remote_remeasure_helper)
    gate_scope = '--changed '  # OP 11-08 11:15 대표 «게이트 분류에서 전체 게이팅이 안 되게 · 부분 게이팅» — T2 도 반경(--changed) · 원복 = .bak-OP-noT2full-1115
    return (
        f"set -e; export PATH=\"{remote_path}\"; cd ~/source/elanous-agent; "
        f"git fetch -q origin main; git cat-file -e {base}^{{commit}}; "
        f"git fetch -q {remote_bundle} {integration}; "
        + remote_worker_setup(remote_art, remote_tmpdir) +
        f"worktree_created=0; {remote_worker_cleanup_trap(remote_tree, remote_tmpdir, remote_art, remote_remeasure_helper)}"
        f"git worktree add -q --detach {remote_tree} {integration}; "
        f"worktree_created=1; "
        f"cd {remote_tree}; test \"$(git rev-parse HEAD)\" = {integration}; "
        f"{remote_worktree_dependency_prep(remote_art)}; "
        f"echo BATCH_HEAD=$(git rev-parse HEAD); "
        "set +e; "
        f"(timeout -k 10 {timeout} env ELANOUS_TRAIN_GATE=1 ELANOUS_GATE_RECEIPT_REGISTRY_PATH={remote_art}/gate-receipts.json bun bin/elanous.mjs self gate {gate_scope}--base {base} --local "
        f"--shards {shards} --fixed-shard-distribution --include-importers --artifact-dir {remote_art} "
        f"> {remote_art}/gate.log 2>&1; echo $? > {remote_art}/gate.rc) & gate_pid=$!; "
        f"(timeout -k 10 {timeout} bash scripts/ci-typecheck-main-delta.sh {base} "
        f"> {remote_art}/typecheck.log 2>&1; echo $? > {remote_art}/typecheck.rc) & typecheck_pid=$!; "
        f"wait $gate_pid; wait $typecheck_pid; gate_rc=$(cat {remote_art}/gate.rc); typecheck_rc=$(cat {remote_art}/typecheck.rc); "
        f"timeout -k 10 300 bun run test:deterministic {' '.join(TRAIN_ALWAYS_RATCHETS)} "
        f"> {remote_art}/always-ratchets.log 2>&1; ratchet_rc=$?; "
        f"echo $ratchet_rc > {remote_art}/always-ratchets.rc; "
        f"bun -e 'const fs=require(\"node:fs\"); const p=\"{remote_art}/summary.json\"; "
        f"if (!fs.existsSync(p)) process.exit(2); const s=JSON.parse(fs.readFileSync(p,\"utf8\")); "
        f"const rc=Number(fs.readFileSync(\"{remote_art}/typecheck.rc\",\"utf8\").trim()); "
        f"const ratchetRc=Number(fs.readFileSync(\"{remote_art}/always-ratchets.rc\",\"utf8\").trim()); "
        f"const ratchetTests={json.dumps(list(TRAIN_ALWAYS_RATCHETS))}; "
        f"s.gateTier={json.dumps(gate_tier)}; "
        f"s.gateProfile=\"{TRAIN_ALWAYS_RATCHET_PROFILE}\"; "
        f"s.trainAlwaysRatchets={{status:ratchetRc===0?\"passed\":\"failed\",exitCode:ratchetRc,tests:ratchetTests,log:\"always-ratchets.log\"}}; "
        f"if(ratchetRc!==0){{s.verdict=\"failed\";s.exitCode=1;s.verdictLine=(s.verdictLine||\"\")+\"\\n[train-always-ratchets] failed rc=\"+ratchetRc;}} "
        f"const out=fs.readFileSync(\"{remote_art}/typecheck.log\",\"utf8\"); "
        f"const m=out.match(/\\[tsc-main-delta\\] base=([0-9a-f]{{40}}) base_rc=(\\d+) head=([0-9a-f]{{40}}) head_rc=(\\d+) baseline_errors=(\\d+) head_errors=(\\d+) new_errors=(\\d+)/); "
        f"const bound=!!m&&m[1]===\"{base}\"&&m[3]===\"{integration}\"; "
        f"const status=bound&&m[7]===\"0\"?\"passed\":(bound&&Number(m[7])>0?\"failed\":\"unmeasured\"); "
        f"s.typecheck={{status,exitCode:status===\"passed\"?0:rc,base40:\"{base}\",head40:\"{integration}\",log:\"typecheck.log\",...(m?{{baselineErrors:Number(m[5]),headErrors:Number(m[6]),newErrors:Number(m[7])}}:{{}}),...(!bound?{{reason:\"typecheck receipt missing or SHA mismatch\"}}:{{}})}}; "
        f"fs.writeFileSync(p,JSON.stringify(s,null,2)+\"\\n\");'; receipt_rc=$?; "
        f"if [ $receipt_rc -eq 0 ]; then remeasure_out=$(ELANOUS_TRAIN_DEFER_TIMEOUT_REMEASURE=1 python3 {shlex.quote(remote_remeasure_helper)} {shlex.quote(remote_tree)} {shlex.quote(remote_art)} {base} {integration} 2>&1); remeasure_rc=$?; printf '%s\\n' \"$remeasure_out\" | tail -n 5; "
        f"if [ $remeasure_rc -eq 0 ] && [[ \"$remeasure_out\" == *TRAIN_GATE_RC=0* ]]; then gate_rc=0; else gate_rc=1; fi; "
        f"if [ \"$(bun -e 'const s=JSON.parse(require(\"node:fs\").readFileSync(\"{remote_art}/summary.json\",\"utf8\")); process.stdout.write(s.typecheck?.status||\"\")')\" = passed ]; then typecheck_rc=0; fi; fi; "
        f"if [ $ratchet_rc -ne 0 ]; then gate_rc=1; fi; "
        f"echo GATE_RC=$gate_rc; echo TYPECHECK_RC=$typecheck_rc; echo ALWAYS_RATCHETS_RC=$ratchet_rc; "
        f"if [ $gate_rc -eq 0 ] && [ $typecheck_rc -eq 0 ] && [ $ratchet_rc -eq 0 ] && [ $receipt_rc -eq 0 ]; then "
        f"bun -e 'const m=await import(\"./src/self-implement/train-gate-receipt.ts\"); "
        f"const {{execFileSync}}=require(\"node:child_process\"); "
        f"const names=(args)=>execFileSync(\"git\",args,{{encoding:\"utf8\"}}).split(/\\r?\\n/).filter(Boolean); "
        f"const input={{repo:{json.dumps(remote_tree)},commit:{json.dumps(integration)},baseSha:{json.dumps(base)}, "
        f"changedFiles:names([\"diff\",\"--name-only\",{json.dumps(base)},{json.dumps(integration)}]), "
        f"deletedFiles:names([\"diff\",\"--diff-filter=D\",\"--name-only\",{json.dumps(base)},{json.dumps(integration)}]), "
        f"summaryPath:{json.dumps(remote_art + '/summary.json')}}}; "
        f"await m.recordPassedSelfGateReceipt(input);'; "
        f"bun -e 'const fs=require(\"node:fs\");const p=\"{remote_art}/gate-receipts.json\";if(fs.existsSync(p))process.stdout.write(\"__GATE_RECEIPTS__\"+Buffer.from(fs.readFileSync(p)).toString(\"base64\")+\"\\n\")'; fi; "
        f"if [ $receipt_rc -ne 0 ] || [ $ratchet_rc -ne 0 ] || [ ! -f {remote_art}/summary.json ]; then "
        f"printf '%s\\n' {shlex.quote(REMOTE_GATE_TAIL_BEGIN)}; "
        f"tail -n 20 {remote_art}/gate.log {remote_art}/typecheck.log {remote_art}/always-ratchets.log 2>/dev/null || true; "
        f"printf '%s\\n' {shlex.quote(REMOTE_GATE_TAIL_END)}; fi; set -e; "
        f"test -f {remote_art}/summary.json"
    )


def build_remote_timeout_remeasure_command(integration, remote_bundle, remote_tree, remote_art, files,
                                           remote_path, remote_tmpdir):
    """Run each timed-out test file once on a prepared alternate host; do not rerun the bundle gate."""
    if not files or any(not re.fullmatch(r'(?:src|test|scripts)/[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?', f)
                        or '..' in Path(f).parts for f in files):
        raise ValueError('timeout remeasurement requires safe test file paths')
    worktree_q = shlex.quote(remote_tree)
    art_q = shlex.quote(remote_art)
    cleanup = remote_worker_cleanup_trap(remote_tree, remote_tmpdir, remote_art)
    lines = [
        'set -e',
        f'export PATH="$HOME/.bun/bin:"{shlex.quote(remote_path)}',
        'cd ~/source/elanous-agent',
        'git fetch -q origin main',
        f'git fetch -q {shlex.quote(remote_bundle)} {shlex.quote(integration)}',  # OP 11-08 06:2x: 묶음에서 먼저 받고
        f'git cat-file -e {shlex.quote(integration)}^{{commit}}',  # 그다음 확인(순서가 거꾸로라 rc=128)
        remote_worker_setup(remote_art, remote_tmpdir),
        'worktree_created=0',
        cleanup,
        f'git worktree add -q --detach {worktree_q} {shlex.quote(integration)}',
        'worktree_created=1',
        f'cd {worktree_q}',
        f'test "$(git rev-parse HEAD)" = {shlex.quote(integration)}',
        remote_worktree_dependency_prep(remote_art),
        'set +e',
        'failed=0',
    ]
    for index, file in enumerate(files, 1):
        log = f'{remote_art}/timeout-file-{index}.log'
        lines += [
            f'test -f {shlex.quote(file)}',
            f'timeout -k 10 360 bun run test:deterministic {shlex.quote("./" + file)} --timeout 60000 > {shlex.quote(log)} 2>&1',
            'rc=$?',
            f'echo TIMEOUT_FILE_RC_{index}=$rc',
            '[ "$rc" -eq 0 ] || failed=1',
        ]
    lines += [
        'if [ "$failed" -eq 0 ]; then echo TIMEOUT_REMEASURE_STATUS=passed; else echo TIMEOUT_REMEASURE_STATUS=failed; fi',
        'exit "$failed"',
    ]
    # OP 11-08 05:4x: 빈 줄·끝 세미콜론 조각이 ';;' 를 만들어 bash 문법 오류(재측정 매번 rc=2) → 정리 후 결합
    return '; '.join(part for part in (str(l).strip().rstrip(';').strip() for l in lines) if part)


def preserve_remote_artifacts(host, remote_art, summary_path, batch_artifacts):
    """Mirror a remote gate artifact directory into this immutable batch artifact tree and rebind paths."""
    local_art = batch_artifacts / 'remote-artifacts' / Path(remote_art).name
    local_art.mkdir(parents=True, exist_ok=True)
    copied = command(['rsync', '-a', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10',
                      f'{host}:{remote_art}/', str(local_art) + '/'], timeout=180)
    if copied.returncode:
        raise RuntimeError(f'gate artifact preservation failed from {host}:{remote_art}: {copied.stderr[-1000:]}')
    if summary_path is not None:
        local_summary = local_art / 'summary.json'
        if not local_summary.is_file():
            raise RuntimeError(f'preserved gate artifacts have no summary.json: {local_art}')
        data = json.loads(local_summary.read_text())
        prefix = remote_art.rstrip('/') + '/'
        def rebind(value):
            if isinstance(value, dict):
                for key, child in list(value.items()):
                    if key in ('resultPath', 'junitPath') and isinstance(child, str) and child.startswith(prefix):
                        value['remote' + key[0].upper() + key[1:]] = child
                        value[key] = str(local_art / child[len(prefix):])
                    else:
                        rebind(child)
            elif isinstance(value, list):
                for child in value:
                    rebind(child)
        rebind(data)
        data['artifactDirectory'] = str(local_art)
        data['remoteArtifactDirectory'] = remote_art
        rendered = json.dumps(data, indent=2) + '\n'
        local_summary.write_text(rendered)
        summary_path.write_text(rendered)
    return local_art


def build_remote_typecheck_command(base, integration, remote_bundle, remote_tree, remote_art, timeout, remote_tmpdir):
    """Measure one PR's main-delta typecheck without running the aggregate test gate."""
    scratch = shlex.quote(remote_tmpdir)
    return (
        f"set -e; export PATH=\"$HOME/.bun/bin:$PATH\"; cd ~/source/elanous-agent; "
        f"git fetch -q origin main; git cat-file -e {base}^{{commit}}; "
        f"git fetch -q {remote_bundle} {integration}; "
        + remote_worker_setup(remote_art, remote_tmpdir) +
        f"worktree_created=0; {remote_worker_cleanup_trap(remote_tree, remote_tmpdir, remote_art)}"
        f"git worktree add -q --detach {remote_tree} {integration}; "
        f"worktree_created=1; "
        f"cd {remote_tree}; test \"$(git rev-parse HEAD)\" = {integration}; "
        f"{remote_worktree_dependency_prep(remote_art)}; "
        f"set +e; timeout -k 10 {timeout} bash scripts/ci-typecheck-main-delta.sh {base} "
        f"> {remote_art}/typecheck.log 2>&1; rc=$?; set -e; "
        f"TS_RC=$rc bun -e 'const fs=require(\"node:fs\");const out=fs.readFileSync(\"{remote_art}/typecheck.log\",\"utf8\");"
        f"const m=out.match(/\\[tsc-main-delta\\] base=([0-9a-f]{{40}}) base_rc=(\\d+) head=([0-9a-f]{{40}}) head_rc=(\\d+) baseline_errors=(\\d+) head_errors=(\\d+) new_errors=(\\d+)/);"
        f"const bound=!!m&&m[1]===\"{base}\"&&m[3]===\"{integration}\";const rc=Number(process.env.TS_RC);"
        f"const status=bound&&m[7]===\"0\"?\"passed\":(bound&&Number(m[7])>0?\"failed\":\"unmeasured\");"
        f"const s={{base40:\"{base}\",head40:\"{integration}\",typecheck:{{status,exitCode:status===\"passed\"?0:rc,base40:\"{base}\",head40:\"{integration}\",...(m?{{baselineErrors:Number(m[5]),headErrors:Number(m[6]),newErrors:Number(m[7])}}:{{}}),...(!bound?{{reason:\"typecheck receipt missing or SHA mismatch\"}}:{{}})}}}};"
        f"fs.writeFileSync(\"{remote_art}/typecheck-summary.json\",JSON.stringify(s,null,2)+\"\\n\");'; "
        f"test -f {remote_art}/typecheck-summary.json"
    )


def _path_matches_inputs(path, prefixes):
    return any(path == prefix or (prefix.endswith('/') and path.startswith(prefix))
               for prefix in prefixes)


def generated_regen_jobs(pr_files):
    """The UX-sim outputs are deterministic; CLI anatomy runs only when CLI sources changed."""
    all_paths = {path for paths in pr_files.values() for path in paths}
    jobs = ['ux-sim']  # also repairs a stale base-derived catalog before the aggregate gate
    if any(_path_matches_inputs(path, CLI_REGEN_INPUTS) for path in all_paths):
        jobs.append('cli-anatomy')
    return jobs


def build_remote_generated_regen_command(worktree, jobs):
    """Run the fixed generator allowlist against the exact integrated tree and inspect its diff."""
    if not str(worktree).startswith('/') or not jobs or any(job not in ('ux-sim', 'cli-anatomy') for job in jobs):
        raise ValueError('invalid generated-regeneration request')
    lines = ['set -euo pipefail', f'worktree={shlex.quote(str(worktree))}',
             'cd "$worktree"', '[ -z "$(git status --porcelain)" ] || { echo REGEN_DIRTY=1; exit 42; }']
    manual = 'docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md'
    lines.extend([f'manual_before=$(mktemp)', 'deps_log=$(mktemp)',
                  f'git show HEAD:{shlex.quote(manual)} > "$manual_before"',
                  'cleanup_regen() { rm -f -- "$manual_before" "$deps_log"; }', 'trap cleanup_regen EXIT',
                  'timeout 180 bun install --frozen-lockfile > "$deps_log" 2>&1 || { rc=$?; tail -n 40 "$deps_log"; exit "$rc"; }',
                  'test -f node_modules/typescript/package.json || { echo REGEN_TYPESCRIPT_MISSING=1; exit 86; }'])
    if 'ux-sim' in jobs:
        lines.extend([
            f'timeout {GENERATED_REGEN_TIMEOUT} bun scripts/generate-ux-sim-device-manual.ts',
            f'timeout {GENERATED_REGEN_TIMEOUT} bun scripts/generate-sim-world-device-catalogs.ts',
        ])
    if 'cli-anatomy' in jobs:
        lines.append(f'timeout {GENERATED_REGEN_TIMEOUT} bun scripts/docs/generate-cli-anatomy.ts')
    lines.extend([
        f"python3 - \"$manual_before\" {shlex.quote(manual)} <<'PY'",
        'import re, sys',
        'pattern = re.compile(r"(?s)<!-- BEGIN GENERATED MOCK DEVICE CATALOG -->.*?<!-- END GENERATED MOCK DEVICE CATALOG -->")',
        'before, after = (open(path, encoding="utf-8").read() for path in sys.argv[1:])',
        'if pattern.sub("<GENERATED>", before) != pattern.sub("<GENERATED>", after):',
        '    print("REGEN_HUMAN_AUTHORED=docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md")',
        '    sys.exit(0)',
        'PY',
        'if [ "${PIPESTATUS[0]:-0}" -ne 0 ]; then echo REGEN_INSPECTION_FAILED=manual; exit 43; fi',
        'changed=$( { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)',
        'for path in $changed; do',
        '  case "$path" in ' + '|'.join(GENERATED_REGEN_OUTPUTS) + ') ;;',
        '    *) echo "REGEN_UNEXPECTED=$path"; exit 0 ;;',
        '  esac',
        'done',
        'files=$(printf "%s\\n" "$changed" | sed "/^$/d" | paste -sd, -)',
        'printf "REGEN_FILES=%s\\n" "$files"',
        'for path in $changed; do [ -f "$path" ] && printf "REGEN_BLOB=%s=%s\\n" "$path" "$(git hash-object -- "$path")"; done',
    ])
    return '\n'.join(lines)


def run_remote_generated_regen(host, worktree, jobs):
    result = command(ssh_remote_command(host, build_remote_generated_regen_command(worktree, jobs)), timeout=GENERATED_REGEN_TIMEOUT * len(jobs) + 240)
    output = (result.stdout or '') + (result.stderr or '')
    if result.returncode:
        raise RuntimeError(f'generated regeneration failed on {host} rc={result.returncode}: {output[-1200:]}')
    human = re.search(r'^REGEN_HUMAN_AUTHORED=(.+)$', output, re.M)
    unexpected = re.search(r'^REGEN_UNEXPECTED=(.+)$', output, re.M)
    if human or unexpected:
        return {'blockedPath': (human or unexpected).group(1), 'reason': 'human-authored content changed' if human else 'path outside generated-output allowlist', 'files': [], 'blobs': {}}
    files_match = re.search(r'^REGEN_FILES=(.*)$', output, re.M)
    if not files_match:
        raise RuntimeError(f'generated regeneration returned no diff receipt on {host}: {output[-800:]}')
    files = [path for path in files_match.group(1).split(',') if path]
    if any(path not in GENERATED_REGEN_OUTPUTS for path in files):
        raise RuntimeError(f'generated regeneration escaped output allowlist: {files}')
    blobs = {}
    for path, sha in re.findall(r'^REGEN_BLOB=([^=]+)=([0-9a-f]{40,64})$', output, re.M):
        blobs[path] = sha
    if set(blobs) != set(files):
        raise RuntimeError(f'generated regeneration blob receipt mismatch: files={files} blobs={sorted(blobs)}')
    return {'blockedPath': '', 'reason': '', 'files': files, 'blobs': blobs}


def pr_head_branch(repo, pr):
    result = command(['gh', 'pr', 'view', str(pr), '--json', 'headRefName,headRepository'], repo, 30)
    if result.returncode:
        raise RuntimeError(f'cannot inspect candidate PR branch #{pr}: {(result.stderr or result.stdout)[-500:]}')
    try:
        data = json.loads(result.stdout)
        branch = str(data['headRefName'])
        repository = str(data['headRepository']['nameWithOwner'])
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f'candidate PR #{pr} has no same-repository branch metadata') from exc
    local = command(['git', 'remote', 'get-url', 'origin'], repo)
    if local.returncode:
        raise RuntimeError('cannot resolve local origin for generated-output push')
    origin = local.stdout.strip().removesuffix('.git')
    origin = re.sub(r'^[a-zA-Z][a-zA-Z0-9+.-]*://', '', origin)
    origin = re.sub(r'^.*@', '', origin).replace(':', '/', 1)
    origin = origin.split('/', 1)[1] if '/' in origin else origin
    if repository.lower() != origin.lower():
        raise RuntimeError(f'candidate PR #{pr} branch is in {repository}, not origin {origin}; generated output push refused')
    if (not re.fullmatch(r'[A-Za-z0-9._/-]+', branch) or branch.startswith('/')
            or any(part in ('', '.', '..') for part in branch.split('/'))):
        raise RuntimeError(f'candidate PR #{pr} has an unsafe branch name')
    return branch


def build_remote_generated_push_command(worktree, pr, old_head, branch, files, run_id):
    if (not str(worktree).startswith('/') or not re.fullmatch(r'[0-9a-f]{40}', old_head)
            or not re.fullmatch(r'[0-9]+', str(pr)) or not re.fullmatch(r'[0-9]+', str(run_id))
            or not files or any(path not in GENERATED_REGEN_OUTPUTS for path in files)):
        raise ValueError('invalid generated-output branch update')
    candidate = f'{worktree}-regen-{pr}'
    pull_ref = f'refs/opt-train/{run_id}/regen/{pr}'
    lines = ['set -euo pipefail', 'cd ~/source/elanous-agent',
             'if git remote get-url github >/dev/null 2>&1; then pull_remote=github; else pull_remote=origin; fi',
             f'git fetch -q "$pull_remote" +refs/pull/{pr}/head:{pull_ref}',
             f'[ "$(git rev-parse {pull_ref})" = {old_head} ] || {{ echo REGEN_HEAD_MOVED=1; exit 44; }}',
             f'branch_ref={shlex.quote("refs/heads/" + branch)}',
             'branch_head=$(git ls-remote "$pull_remote" "$branch_ref" | awk "NR==1 {print \\$1}")',
             f'[ "$branch_head" = {old_head} ] || {{ echo REGEN_REMOTE_BRANCH_MOVED=1; exit 44; }}',
             f'candidate={shlex.quote(candidate)}',
             f'trap \'cd ~/source/elanous-agent; git worktree remove --force "$candidate" >/dev/null 2>&1 || true; git update-ref -d {pull_ref} >/dev/null 2>&1 || true\' EXIT',
             f'git worktree add -q --detach "$candidate" {old_head}']
    for path in files:
        qpath = shlex.quote(path)
        lines.extend([f'test -f {shlex.quote(str(worktree) + "/" + path)}',
                      f'mkdir -p "$candidate/$(dirname {qpath})"',
                      f'cp -- {shlex.quote(str(worktree) + "/" + path)} "$candidate/{path}"'])
    allow = '|'.join(re.escape(path) for path in GENERATED_REGEN_OUTPUTS)
    lines.extend([
        f'changed=$(cd "$candidate" && {{ git diff --name-only HEAD; git ls-files --others --exclude-standard; }} | sort -u)',
        f'for path in $changed; do [[ "$path" =~ ^({allow})$ ]] || {{ echo "REGEN_UNEXPECTED_CANDIDATE=$path"; exit 45; }}; done',
        'cd "$candidate"', 'git add -- ' + ' '.join(shlex.quote(path) for path in files),
        'if git diff --cached --quiet; then echo REGEN_BRANCH_NO_DIFF=1; exit 0; fi',
        'git -c user.name=OP-train -c user.email=op-train@local commit -m "docs: refresh generated outputs for integrated train"',
        'new_head=$(git rev-parse HEAD)',
        'git push "$pull_remote" "$new_head:$branch_ref"',
        'cd ~/source/elanous-agent',
        'printf "REGEN_PR_HEAD=%s\\n" "$new_head"',
    ])
    return '\n'.join(lines)


def push_remote_generated_outputs(host, worktree, row, branch, files, run_id):
    payload = build_remote_generated_push_command(worktree, row.pr, row.head, branch, files, run_id)
    result = command(ssh_remote_command(host, payload), timeout=180)
    output = (result.stdout or '') + (result.stderr or '')
    if result.returncode:
        raise RuntimeError(f'generated-output candidate update failed #{row.pr} on {host} rc={result.returncode}: {output[-1000:]}')
    match = re.search(r'^REGEN_PR_HEAD=([0-9a-f]{40})$', output, re.M)
    if not match:
        if re.search(r'^REGEN_BRANCH_NO_DIFF=1$', output, re.M):
            return ''
        raise RuntimeError(f'generated-output candidate update unmeasured #{row.pr}: {output[-700:]}')
    return match.group(1)


def update_queue_head(queue, pr, old_head, new_head, old_evidence=None, new_evidence=None):
    """Atomically replace one exact queue head while holding the same lock used by train tools."""
    path = Path(queue)
    lock_path = Path(str(path) + '.lock')
    # OP 11-06 09:3x: the queue lock is a mkdir DIRECTORY (land-enqueue.sh · land-single.sh) — never a flock file,
    # or the leftover file blocks every mkdir lock forever.
    for _ in range(300):
        try:
            lock_path.mkdir()
            break
        except FileExistsError:
            time.sleep(1)
    else:
        raise RuntimeError(f'queue lock busy for generated refresh #{pr}')
    try:
        lines = path.read_text(encoding='utf-8').splitlines(keepends=True)
        replaced = False
        output = []
        for line in lines:
            raw = line.rstrip('\r\n')
            fields = raw.split('\t')
            if len(fields) == 4 and fields[0] == str(pr):
                if fields[1] != old_head:
                    raise RuntimeError(f'queue head moved before generated refresh #{pr}: {fields[1]}')
                if old_evidence is not None and fields[3] != old_evidence:
                    raise RuntimeError(f'queue evidence moved before generated refresh #{pr}: {fields[3]}')
                fields[1] = new_head
                if new_evidence is not None:
                    fields[3] = new_evidence
                line = '\t'.join(fields) + ('\n' if line.endswith('\n') else '')
                replaced = True
            output.append(line)
        if not replaced:
            raise RuntimeError(f'queue row disappeared before generated refresh #{pr}')
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent, prefix=f'.{path.name}.regen-', delete=False) as stream:
            temp = Path(stream.name)
            stream.writelines(output)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, stat.S_IMODE(path.stat().st_mode))
        os.replace(temp, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            lock_path.rmdir()
        except OSError:
            pass


def fetch_generated_candidate_head(repo, pr, row_ref, expected_head, attempts=6, retry_delay=2):
    """Wait for GitHub's pull ref to expose the exact train-pushed refresh head before queue advancement."""
    if not re.fullmatch(r'[0-9a-f]{40}', str(expected_head)) or attempts < 1:
        raise ValueError('invalid expected generated-refresh head or retry count')
    last_detail = 'pull ref not observed'
    for attempt in range(attempts):
        fetched = command(['git', 'fetch', '-q', 'origin', f'+refs/pull/{pr}/head:{row_ref}'], repo, 30)
        if fetched.returncode:
            last_detail = f'fetch rc={fetched.returncode}: {(fetched.stderr or fetched.stdout or "").strip()[-300:]}'
        else:
            observed = command(['git', 'rev-parse', row_ref], repo, 15)
            if observed.returncode == 0:
                actual_head = (observed.stdout or '').strip()
                if actual_head == expected_head:
                    return actual_head
                last_detail = f'expected={expected_head} observed={actual_head or "<empty>"}'
            else:
                last_detail = f'pull ref read rc={observed.returncode}: {(observed.stderr or observed.stdout or "").strip()[-300:]}'
        if attempt + 1 < attempts:
            time.sleep(retry_delay)
    raise RuntimeError(f'generated candidate head mismatch after push #{pr}: {last_detail}; attempts={attempts}')


def generated_refresh_chain(repo, reviewed_head, current_head):
    """Return proof only when every commit R..H is the train's generated-output refresh."""
    if not re.fullmatch(r'[0-9a-f]{40}', str(reviewed_head)) or not re.fullmatch(r'[0-9a-f]{40}', str(current_head)):
        return None, 'invalid reviewed/current head'
    ancestor = command(['git', 'merge-base', '--is-ancestor', reviewed_head, current_head], repo, 30)
    if ancestor.returncode != 0:
        return None, 'reviewed head is not an ancestor of current head'
    commits_result = command(['git', 'rev-list', '--reverse', f'{reviewed_head}..{current_head}'], repo, 30)
    if commits_result.returncode:
        return None, 'commit range unavailable'
    commits = [line.strip() for line in commits_result.stdout.splitlines() if line.strip()]
    if not commits:
        return None, 'no refresh commit between reviewed and current head'
    previous = reviewed_head
    changed_files = []
    for commit in commits:
        parents = command(['git', 'rev-list', '--parents', '-n', '1', commit], repo, 30)
        parent_fields = (parents.stdout or '').split()
        if parents.returncode or parent_fields != [commit, previous]:
            return None, f'non-linear/non-refresh ancestry at {commit[:12]}'
        metadata = command(['git', 'show', '-s', '--format=%s%x00%an%x00%ae%x00%cn%x00%ce', commit], repo, 30)
        values = (metadata.stdout or '').rstrip('\n').split('\x00')
        if metadata.returncode or len(values) != 5:
            return None, f'commit metadata unavailable at {commit[:12]}'
        subject, author_name, author_email, committer_name, committer_email = values
        if (subject != TRAIN_REFRESH_SUBJECT
                or (author_name, author_email) != TRAIN_REFRESH_AUTHOR
                or (committer_name, committer_email) != TRAIN_REFRESH_AUTHOR):
            return None, f'non-train refresh commit at {commit[:12]}'
        files_result = command(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', commit], repo, 30)
        files = [line.strip() for line in (files_result.stdout or '').splitlines() if line.strip()]
        if files_result.returncode or not files:
            return None, f'changed paths unavailable at {commit[:12]}'
        allowed = set(GENERATED_REGEN_OUTPUTS)
        invalid = [path for path in files if not (path.startswith('docs/generated/') or path in allowed)]
        if invalid:
            return None, f'non-generated path at {commit[:12]}: {invalid[0]}'
        changed_files.extend(files)
        previous = commit
    if previous != current_head:
        return None, 'refresh chain does not end at current head'
    return {'commits': commits, 'changedFiles': sorted(set(changed_files))}, ''


def resolve_review_result_path(review_ref, evidence_path, repo):
    path = Path(str(review_ref)).expanduser()
    candidates = [path] if path.is_absolute() else [
        Path(evidence_path).parent / path,
        Path(repo) / path,
        Path.home() / '.elanous/review-results' / path,
    ]
    return next((candidate.resolve() for candidate in candidates if candidate.is_file()), None)


def write_json_atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent,
                                     prefix=f'.{path.name}.', suffix='.tmp', delete=False) as stream:
        temp = Path(stream.name)
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def prepare_generated_refresh_review_carry(repo, row, current_head):
    """Create an auditable exact-head review receipt only for a verified train refresh chain."""
    chain, reason = generated_refresh_chain(repo, row.head, current_head)
    if chain is None:
        return None, reason
    evidence_path = Path(row.evidence).expanduser()
    try:
        evidence = json.loads(evidence_path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        return None, f'queue evidence unreadable: {exc}'
    review_path = resolve_review_result_path(evidence.get('reviewResult', ''), evidence_path, repo)
    if review_path is None:
        return None, 'source review result missing'
    try:
        review = json.loads(review_path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        return None, f'source review unreadable: {exc}'
    if str(review.get('pr', '')) != str(row.pr) or str(review.get('headCommit', '')).lower() != row.head.lower():
        return None, 'source review PR/head does not match queued reviewed head'
    review_check = command(['jq', '-e', '--arg', 'h', row.head,
                            '-f', str(TRAIN_REFRESH_REVIEW_OK), str(review_path)], repo, 15)
    if review_check.returncode:
        return None, 'source review is not PASS/WARN with zero must-fix at reviewed head'

    carry = {
        'schema': TRAIN_REFRESH_REVIEW_SCHEMA,
        'pr': str(row.pr),
        'reviewedHead': row.head,
        'carriedHead': current_head,
        'subject': TRAIN_REFRESH_SUBJECT,
        'trainIdentity': {'name': TRAIN_REFRESH_AUTHOR[0], 'email': TRAIN_REFRESH_AUTHOR[1]},
        'commits': chain['commits'],
        'changedFiles': chain['changedFiles'],
        'sourceReview': str(review_path),
        'sourceEvidence': str(evidence_path.resolve()),
    }
    carried_review = dict(review)
    carried_review['headCommit'] = current_head
    carried_review['currentHeadCommit'] = current_head
    carried_review['trainGeneratedRefreshCarry'] = carry
    review_root = Path.home() / '.elanous/review-results'
    carried_review_path = review_root / f'train-refresh-carry-{row.pr}-{current_head[:12]}.json'
    write_json_atomic(carried_review_path, carried_review)
    carried_evidence = dict(evidence)
    carried_evidence['reviewResult'] = str(carried_review_path)
    carried_evidence['trainGeneratedRefreshCarry'] = carry
    evidence_root = Path.home() / 'elanous-hq/seat-state/OP'
    carried_evidence_path = evidence_root / f'overlap-evidence-{row.pr}-refresh-{current_head[:12]}.json'
    write_json_atomic(carried_evidence_path, carried_evidence)
    return str(carried_evidence_path), ''


def send_generated_owner_notice(prs, blocked_path, reason, run_id):
    """Fail closed and notify OP with exact owners/paths so owner mail can be routed without guessing."""
    body = (f'OPT train {run_id}: generated refresh stopped · PRs={",".join(str(pr) for pr in prs)} '
            f'· path={blocked_path} · reason={reason}. No generated commit was pushed; route to the path owner.')
    result = command(['eln', 'msg', 'post', '--from', 'OPT', '--to', 'OP', '--kind', 'report', '--body', body], timeout=30)
    if result.returncode:
        log(f'generated refresh owner notice failed: {(result.stderr or result.stdout)[-300:]}')


def verify_remote_generated_outputs(host, worktree, blobs, jobs, integration_head):
    # Whole-file hashes are not a valid invariant for generated manuals: Git may
    # carry authored edits around the generated marker block through integration.
    # Re-run the canonical generators on the exact final integration instead;
    # a clean second run proves the generated region/snapshots are current there.
    verified = run_remote_generated_regen(host, worktree, jobs)
    if verified['blockedPath']:
        raise RuntimeError(f'regenerated output verification blocked at {verified["blockedPath"]}: {verified["reason"]}')
    mismatches = []
    for path in verified['files']:
        expected = blobs.get(path, '<not-in-first-generation>')
        actual = verified['blobs'].get(path, '<missing-blob>')
        if expected != actual:
            mismatches.append(f'{path}: first={expected} final-regeneration={actual}')
    if mismatches:
        raise RuntimeError('generated output is not stable on exact re-integration: '
                           + '; '.join(mismatches))
    lines = ['set -euo pipefail', f'worktree={shlex.quote(str(worktree))}']
    for path in blobs:
        lines.append(f'printf "REGEN_VERIFY_CURRENT={path}=%s\\n" "$(git -C "$worktree" hash-object -- {shlex.quote(path)})"')
    result = command(ssh_remote_command(host, '\n'.join(lines)), timeout=60)
    output = (result.stdout or '') + (result.stderr or '')
    current = dict(re.findall(r'^REGEN_VERIFY_CURRENT=([^=]+)=([0-9a-f]{40,64})$', output, re.M))
    if result.returncode or set(current) != set(blobs):
        raise RuntimeError(f'generated output verification hashes unmeasured on {host}: {output[-800:]}')
    drift = [f'{path}:{blobs[path]}->{current[path]}' for path in blobs if blobs[path] != current[path]]
    log(f'generated refresh verification stable host={host} head={integration_head[:12]} '
        f'jobs={",".join(jobs)} whole-file-drift={";".join(drift) if drift else "none"}')


def commit_remote_generated_integration(host, artifact, base, files):
    worktree, bundle = str(artifact.get('worktree', '')), str(artifact.get('bundle', ''))
    if (not worktree.startswith('/') or not bundle.startswith('/')
            or not re.fullmatch(r'[0-9a-f]{40}', base) or not files
            or any(path not in GENERATED_REGEN_OUTPUTS for path in files)):
        raise ValueError('invalid integrated generated-output commit')
    quoted_files = ' '.join(shlex.quote(path) for path in files)
    payload = '\n'.join([
        'set -euo pipefail', 'cd ~/source/elanous-agent',
        f'worktree={shlex.quote(worktree)}', f'bundle={shlex.quote(bundle)}',
        f'git -C "$worktree" add -- {quoted_files}',
        'git -C "$worktree" diff --cached --quiet && { echo GENERATED_TREE_NO_DIFF=1; exit 42; }',
        'git -C "$worktree" -c user.name=OP-train -c user.email=op-train@local commit -m "docs: regenerate outputs on integrated train tree"',
        'integration=$(git -C "$worktree" rev-parse HEAD)',
        '[[ "$integration" =~ ^[0-9a-f]{40}$ ]]',
        'rm -f -- "$bundle"',
        f'git -C "$worktree" bundle create "$bundle" HEAD {shlex.quote(base)} {shlex.quote("^" + base + "^")}',
        '[ -s "$bundle" ]',
        'printf "REGENERATED_INTEGRATION_HEAD=%s\\n" "$integration"',
    ])
    result = command(ssh_remote_command(host, payload), timeout=180)
    output = (result.stdout or '') + (result.stderr or '')
    if result.returncode:
        raise RuntimeError(f'generated integration commit failed on {host} rc={result.returncode}: {output[-1000:]}')
    match = re.search(r'^REGENERATED_INTEGRATION_HEAD=([0-9a-f]{40})$', output, re.M)
    if not match:
        raise RuntimeError(f'generated integration head unmeasured on {host}: {output[-700:]}')
    return match.group(1)


def regenerate_integrated_tree_once(args, queue, repo, rows, pr_files, artifact, attempt, manifest,
                                    integration_resources, remote_homes):
    """Regenerate once after all merges and commit only to the disposable integrated tree."""
    jobs = generated_regen_jobs(pr_files)
    if not jobs:
        return artifact, artifact['head'], rows, pr_files, False
    generated = run_remote_generated_regen(args.host, artifact['worktree'], jobs)
    if generated['blockedPath']:
        send_generated_owner_notice([row.pr for row in rows], generated['blockedPath'], generated['reason'], args.run_id)
        raise RuntimeError(f"generated regeneration stopped without commit: {generated['reason']} at {generated['blockedPath']}")
    if not generated['files']:
        manifest['generatedRegeneration'] = {'jobs': jobs, 'status': 'unchanged', 'attempt': attempt}
        return artifact, artifact['head'], rows, pr_files, False

    committed_head = commit_remote_generated_integration(args.host, artifact, args.base, generated['files'])
    updated_artifact = {**artifact, 'head': committed_head}
    manifest['generatedRegeneration'] = {
        'jobs': jobs, 'status': 'committed-to-integrated-tree', 'attempt': attempt,
        'files': generated['files'], 'blobs': generated['blobs'], 'commit': committed_head,
    }
    manifest['integrationHead'] = committed_head
    Path(args.artifacts, 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return updated_artifact, committed_head, rows, pr_files, True


def run_live(args):
    if not args.op_watching or not args.authorize:
        raise ValueError('requires OP watching and explicit authorization')
    gate_hosts = live_gate_hosts()
    retry_host = resolve_retry_host(args.host, getattr(args, 'retry_host', ''))
    if args.host not in gate_hosts or retry_host not in gate_hosts:
        raise ValueError(f'live gate/retry host must be one of {gate_hosts}')
    exclude = parse_exclude(getattr(args, 'exclude', ''))
    if not args.land_single or not args.land_single.is_file():
        raise ValueError('existing land-single.sh required')
    if not re.fullmatch(r'[0-9]+', args.run_id):
        raise ValueError('run id must be numeric for land-single.sh')
    if args.side_main != args.base:
        raise ValueError('side main must match the aggregate gate base')
    queue, repo = Path(args.queue).resolve(), Path(args.repo).resolve()
    args.artifacts = args.artifacts.resolve() if args.artifacts else None
    wait_queue_lock_clear(queue, 'at start')
    batch_lock_handle = acquire(getattr(args, 'lock', '') or (str(queue) + '.batch.lock'), args.host)  # 열차마다 자기 잠금(--lock) · 기본은 옛 이름
    lock = batch_lock_handle[0]
    integration_resources = []
    remote_bundle_copies = []
    remote_homes = {}
    direct_claim = None
    try:
        selection_lock = acquire_claim_selection_lock(queue)
        try:
            shared_exclude, direct_claim = reserve_claims_for_live_batch(
                queue, args.host, lock, set(args.authorize.split(',')),
                allow_preflight_overlap=args.allow_preflight_overlap and args.preflight_only)
            exclude.update(shared_exclude)
        finally:
            release_claim_selection_lock(selection_lock)
        snapshot = queue.read_bytes()
        queued = read_queue(queue)
        memory_excluded = memory_skip_set(queued, args.base)
        rows = [r for r in queued if r.pr not in exclude and r.pr not in memory_excluded]  # claims·기측정 PR 제외
        chosen, deferred = select(rows, merge_conflicts(repo, args.base, rows), args.limit)
        if not chosen:
            raise RuntimeError('no conflict-free rows')
        if set(args.authorize.split(',')) != {r.pr for r in chosen}:
            raise RuntimeError('authorization must exactly match selected PRs: '
                               f'authorized={sorted(set(args.authorize.split(",")), key=int)} '
                               f'selected={sorted({r.pr for r in chosen}, key=int)} '
                               f'excluded={sorted(exclude, key=int)} '
                               f'memoryExcluded={sorted(memory_excluded, key=int)} '
                               f'deferred={deferred}')
        if args.preflight_only:
            row = chosen[0]
            previous = _memory.exact_rows(row.pr, row.head.lower(), args.base.lower(), 'solo-check')
            if any(item.get('status') in ('passed', 'failed', 'precondition-unmet', 'conflict')
                   for item in previous):
                raise RuntimeError(f'same PR/head/base solo preflight already measured: #{row.pr}')
        status = command(['git', 'status', '--porcelain'], repo)
        if status.returncode or status.stdout.strip():
            raise RuntimeError('source worktree must be clean and measurable')
        if not chosen_still_queued(queue, chosen):  # OP 10-28 20:0x: 다른 열차의 착지가 줄을 줄여도 고른 PR 이 같은 head 로 남았으면 계속
            raise RuntimeError('queue changed during preflight (chosen PR removed or head moved)')
        if not args.artifacts or args.artifacts.exists():
            raise RuntimeError('use a new run-specific artifact directory')
        args.artifacts.mkdir(parents=True)
        manifest = {'base': args.base, 'queueSha256': hashlib.sha256(snapshot).hexdigest(),
                    'members': [{'pr': r.pr, 'head': r.head} for r in chosen],
                    'gateProfile': TRAIN_ALWAYS_RATCHET_PROFILE,
                    'alwaysRatchets': list(TRAIN_ALWAYS_RATCHETS),
                    'deferred': deferred + [{'pr': p, 'reason': 'same PR/head/base already measured in train-memory.jsonl'} for p in sorted(memory_excluded)],
                    'host': args.host, 'excluded': sorted(set(exclude) | memory_excluded),
                    'lock': str(lock)}
        batch_host_result = remote_merge_conflicts(args.host, args.base, chosen,
                                                  args.run_id, remote_homes)
        batch_host_conflicts = batch_host_result['conflicts']
        head_mismatches = batch_host_result['head_mismatches']
        manifest['batchHostMergeTree'] = {
            'host': args.host,
            'members': [{'pr': row.pr, 'head': row.head} for row in chosen],
            'conflicts': sorted(batch_host_conflicts, key=int),
            'headMismatches': [{'pr': pr, **details} for pr, details in sorted(head_mismatches.items(), key=lambda item: int(item[0]))],
            'decision': ('head-mismatch-dropped' if head_mismatches else
                         'clean' if not batch_host_conflicts else 'conflict'),
        }
        if head_mismatches:
            chosen, stale_rows = defer_head_mismatches(chosen, head_mismatches)
            deferred.extend(stale_rows)
            for stale in stale_rows:
                row = next(item for item in rows if item.pr == stale['pr'])
                owner, sent = notify_head_mismatch_owner(row, head_mismatches[str(row.pr)], repo)
                log(f'batch head mismatch #{row.pr} dropped only this row; owner={owner} mail_rc={sent.returncode}')
            args.authorize = ','.join(row.pr for row in chosen)
            manifest['members'] = [row.as_dict() for row in chosen]
            manifest['deferred'] = deferred + [
                {'pr': p, 'reason': 'same PR/head/base already measured in train-memory.jsonl'}
                for p in sorted(memory_excluded, key=int)]
        (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        if batch_host_conflicts:
            raise RuntimeError(f'batch-host merge-tree found conflict(s) in authorized selection: {sorted(batch_host_conflicts, key=int)}')
        if not chosen:
            raise RuntimeError('all authorized batch rows had a remote head mismatch; stale rows dropped and owners notified')
        try:
            pr_files = changed_files_by_pr(repo, args.base, chosen)
            integration_rows = list(chosen)
            integration_conflicts = []
            integration_attempt = 0
            while True:
                integration_attempt += 1
                try:
                    integration_artifact = integrate_rows_remote(
                        args.host, args.base, integration_rows, args.run_id,
                        f'primary-{integration_attempt}', integration_resources, remote_homes)
                    integration = integration_artifact['head']
                    break
                except RuntimeError as exc:
                    conflict = re.search(r'integration merge failed #([0-9]+):', str(exc))
                    if not conflict:
                        raise
                    failed_pr = conflict.group(1)
                    failed_row = next((row for row in integration_rows if row.pr == failed_pr), None)
                    if failed_row is None or len(integration_rows) - 1 < 1:
                        raise
                    reason = f'integration-conflict: {str(exc)[-1000:]}'
                    park_script = Path.home() / 'elanous-hq/seat-state/OP/tools/train-park.py'
                    namespace = {'__name__': 'train_park_conflict', '__file__': str(park_script)}
                    exec(compile(park_script.read_text(), str(park_script), 'exec'), namespace)
                    conflict_detail = str(exc)[-1600:]
                    conflict_paths = sorted(set(re.findall(
                        r'(?i)(?:merge conflict in|conflict in|CONFLICT[^:]*: )\s*([^\s]+)', conflict_detail)))
                    park_context = {'bundle_members': [str(r.pr) for r in integration_rows],
                                    'integration_head': 'not-built (merge failed before gate integration commit)',
                                    'failed_stage': 'integration-merge',
                                    'file_line': ','.join(f'{path}:unknown' for path in conflict_paths) or 'merge-conflict:unknown'}
                    parked = namespace['park'](args.queue, failed_pr, failed_row.head,
                                               reason or f'integration-conflict #{failed_pr}', args.run_id,
                                               conflict_detail, park_context)
                    if parked is None:
                        raise RuntimeError(f'conflict PR #{failed_pr} could not be safely parked')
                    integration_conflicts.append({'pr': failed_pr, 'head': failed_row.head,
                                                   'reason': reason})
                    integration_rows = [row for row in integration_rows if row.pr != failed_pr]
                    manifest['integrationConflictParked'] = integration_conflicts
                    manifest['members'] = [row.as_dict() for row in integration_rows]
                    (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                    log(f'integration conflict #{failed_pr} parked; restarting with {[r.pr for r in integration_rows]}')
            pre_regen_artifact = integration_artifact
            pre_regen_head = integration
            pre_regen_rows = [Row(row.pr, row.head, row.tree, row.evidence) for row in integration_rows]
            pre_regen_pr_files = {str(pr): list(paths) for pr, paths in pr_files.items()}
            regeneration_failed = False
            try:
                integration_artifact, integration, integration_rows, pr_files, regenerated = regenerate_integrated_tree_once(
                    args, queue, repo, integration_rows, pr_files, integration_artifact,
                    integration_attempt, manifest, integration_resources, remote_homes)
            except Exception as exc:
                regeneration_failed = True
                integration_artifact, integration = pre_regen_artifact, pre_regen_head
                integration_rows, pr_files = pre_regen_rows, pre_regen_pr_files
                reason = str(exc)[-1200:]
                event = {'type': 'generated-regeneration-skipped', 'status': 'skipped-failed',
                         'jobs': generated_regen_jobs(pre_regen_pr_files), 'reason': reason,
                         'integrationHead': pre_regen_head, 'attempt': integration_attempt}
                manifest['generatedRegeneration'] = event
                manifest.setdefault('events', []).append(event)
                (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                log(f'generated regeneration skipped after failure; continuing pinned gate at {pre_regen_head[:12]}: {reason}')
                regenerated = False
            if regenerated:
                integration_attempt += 1
                log(f'generated-only refresh pushed; re-integrated exact PR heads at {integration[:12]} before gate')
            manifest['members'] = [row.as_dict() for row in integration_rows]
            manifest['queueSha256'] = hashlib.sha256(queue.read_bytes()).hexdigest()
            manifest['integrationHead'] = integration
            (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            chosen = integration_rows
            if not chosen_still_queued(queue, chosen):
                if regeneration_failed:
                    log('selected queue head changed during failed regeneration; continue gate on the pinned pre-hook integration')
                else:
                    raise RuntimeError('queue changed before gate (chosen PR removed or head moved)')
            remote_id = args.run_id
            summary = args.artifacts / 'summary.json'

            def invoke_gate(host, suffix, summary_path, log_path, gate_bundle, gate_integration, gate_rows, gate_pr_files):
                home_result = command(['ssh', '-o', 'ConnectTimeout=10', host, 'printf %s "$HOME"'], timeout=30)
                if home_result.returncode or not home_result.stdout.strip().startswith('/'):
                    raise RuntimeError(f'cannot resolve persistent artifact home on {host}')
                remote_root = remote_batch_root(home_result.stdout.strip(), remote_id, suffix)
                remote_tree = f'{remote_root}-worktree'
                remote_tmpdir = f'{remote_root}-tmp'
                remote_art = f'{remote_root}-art'
                remote_bundle = gate_bundle['bundle'] if host == gate_bundle['host'] else f'{remote_root}.bundle'
                remeasure_helper = Path(__file__).with_name('train-gate-remeasure.py')
                if not remeasure_helper.is_file():
                    raise RuntimeError(f'train gate remeasurement helper missing: {remeasure_helper}')
                if host != gate_bundle['host']:
                    command(ssh_remote_command(host, f'umask 022; mkdir -p {shlex.quote(str(Path(remote_root).parent))}'), timeout=30)
                    remote_bundle_copies.append({'host': host, 'path': remote_bundle})
                    transfer = command(scp_transfer(f'{gate_bundle["host"]}:{gate_bundle["bundle"]}',
                                                     f'{host}:{remote_bundle}'), timeout=120)
                    if transfer.returncode:
                        raise RuntimeError(f'integration bundle transfer {gate_bundle["host"]} to {host} failed: {transfer.stderr[-1000:]}')
                else:
                    command(ssh_remote_command(host, f'umask 022; mkdir -p {shlex.quote(str(Path(remote_root).parent))}'), timeout=30)
                helper_remote = f'{remote_root}-train-gate-remeasure.py'
                helper_transfer = command(scp_transfer(remeasure_helper, f'{host}:{helper_remote}'), timeout=60)
                if helper_transfer.returncode:
                    raise RuntimeError(f'train gate remeasurement helper transfer to {host} failed: {helper_transfer.stderr[-1000:]}')
                gate_timeout = gate_timeout_for_host(host, args.gate_timeout)
                gate_tier, tier_decisions = classify_batch_gate(repo, args.base, gate_rows, gate_pr_files)
                manifest['gateTier'] = {'tier': gate_tier, 'decisions': tier_decisions,
                                        'rule': 'highest-member-tier-wins; unknown=>T2'}
                (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                log(f"gate tier={gate_tier} members=" + ','.join(
                    f"#{item.get('pr')}:{item.get('tier')}[{','.join(item.get('rules', []))}]"
                    for item in tier_decisions))
                payload = build_remote_gate_command(args.base, gate_integration, remote_bundle,
                                                   remote_tree, remote_art, helper_remote,
                                                   gate_timeout, args.shards,
                                                   remote_path_for_host(host), remote_tmpdir, gate_tier)
                with log_path.open('w') as out:
                    result = subprocess.run(ssh_remote_command(host, payload), text=True,
                                            stdout=out, stderr=subprocess.STDOUT,
                                            timeout=gate_timeout + 300)
                infra = remote_setup_infra_detail(log_path) if result.returncode else ''
                try:
                    preserved_art = preserve_remote_artifacts(
                        host, remote_art, summary_path if result.returncode == 0 else None, args.artifacts)
                except RuntimeError as exc:
                    # OP 11-05: a remote setup failure (e.g. disk full before the worktree exists)
                    # leaves no artifact dir; report the setup cause, not «rsync change_dir».
                    if result.returncode and 'change_dir' in str(exc):
                        raise RuntimeError(f'aggregate gate setup/unmeasured rc={result.returncode} on {host}; '
                                           f'remote artifacts absent; {infra or "setup failed before artifacts"}'
                                           f'\nsee {log_path}') from exc
                    raise
                recovered = None
                if result.returncode and not infra and not (preserved_art / 'summary.json').is_file():
                    recovered = recover_completed_shard_verdict(repo, preserved_art, args.base, gate_integration)
                    if recovered is not None:
                        summary_path.write_text(json.dumps(recovered, indent=2) + '\n')
                if result.returncode and infra and recovered is None:
                    raise RuntimeError(f'aggregate gate setup/unmeasured rc={result.returncode} on {host}; {infra}\nsee {log_path}')
                if result.returncode and recovered is None:
                    remote_tail = remote_gate_log_tail(log_path.read_text())
                    detail = f'\nremote gate.log tail (last 20 lines):\n{remote_tail}' if remote_tail else ''
                    raise RuntimeError(f'aggregate gate setup/unmeasured rc={result.returncode} on {host}; artifacts={preserved_art};{detail}\nsee {log_path}')
                if not (preserved_art / 'summary.json').is_file() and recovered is None:
                    raise RuntimeError(f'gate summary missing after artifact preservation from {host}:{remote_art}')
                summary_data = json.loads(summary_path.read_text())
                typecheck = summary_data.get('typecheck')
                if isinstance(typecheck, dict) and typecheck.get('status') == 'failed':
                    local_tsc_log = preserved_art / 'typecheck.log'
                    if not local_tsc_log.is_file():
                        raise RuntimeError(f'preserved typecheck log missing: {local_tsc_log}')
                    enrich_typecheck_summary(summary_path, local_tsc_log, gate_pr_files)
                refreshed = json.loads(summary_path.read_text())
                refreshed_tc = refreshed.get('typecheck') if isinstance(refreshed, dict) else None
                if not isinstance(refreshed_tc, dict) or refreshed_tc.get('status') != 'passed':
                    local_tsc_log = preserved_art / 'typecheck.log'
                    record_typecheck_rejections(repo, args.base, gate_rows, summary_path, args.artifacts,
                                                local_tsc_log if local_tsc_log.is_file() else None)
                remote_head = re.search(r'^BATCH_HEAD=([0-9a-f]{40})$', log_path.read_text(), re.M)
                if not remote_head or remote_head.group(1) != gate_integration:
                    raise RuntimeError(f'{host} integration head mismatch')
                if recovered is not None:
                    return int(recovered['exitCode'])
                gate_rc = re.search(r'^GATE_RC=([0-9]+)$', log_path.read_text(), re.M)
                if not gate_rc:
                    raise RuntimeError(f'{host} gate exit code missing')
                return int(gate_rc.group(1))

            def invoke_timeout_remeasure(host, files, gate_bundle, gate_integration):
                if host == args.host:
                    raise RuntimeError('timeout-only remeasurement must use a different host')
                home_result = command(['ssh', '-o', 'ConnectTimeout=10', host, 'printf %s "$HOME"'], timeout=30)
                if home_result.returncode or not home_result.stdout.strip().startswith('/'):
                    raise RuntimeError(f'cannot resolve timeout remeasurement home on {host}')
                suffix = f'timeout-remeasure-{host}'
                remote_root = remote_batch_root(home_result.stdout.strip(), remote_id, suffix)
                remote_tree = f'{remote_root}-worktree'
                remote_tmpdir = f'{remote_root}-tmp'
                remote_art = f'{remote_root}-art'
                remote_bundle = gate_bundle['bundle'] if host == gate_bundle['host'] else f'{remote_root}.bundle'
                command(ssh_remote_command(host, f'umask 022; mkdir -p {shlex.quote(str(Path(remote_root).parent))}'), timeout=30)
                if host != gate_bundle['host']:
                    remote_bundle_copies.append({'host': host, 'path': remote_bundle})
                    transfer = command(scp_transfer(f'{gate_bundle["host"]}:{gate_bundle["bundle"]}',
                                                     f'{host}:{remote_bundle}'), timeout=120)
                    if transfer.returncode:
                        raise RuntimeError(f'timeout integration bundle transfer to {host} failed: {transfer.stderr[-1000:]}')
                payload = build_remote_timeout_remeasure_command(
                    gate_integration, remote_bundle, remote_tree, remote_art, files,
                    remote_path_for_host(host), remote_tmpdir)
                log_path = args.artifacts / f'timeout-remeasure-{host}.stdout.log'
                try:
                    with log_path.open('w') as out:
                        result = subprocess.run(ssh_remote_command(host, payload), text=True,
                                                stdout=out, stderr=subprocess.STDOUT, timeout=420)
                except subprocess.TimeoutExpired:
                    return {'status': 'unmeasured', 'host': host, 'files': files, 'log': str(log_path)}
                text = log_path.read_text()
                status = 'passed' if result.returncode == 0 and 'TIMEOUT_REMEASURE_STATUS=passed' in text else 'failed'
                return {'status': status, 'host': host, 'files': files, 'returncode': result.returncode,
                        'log': str(log_path), 'output': text[-2000:]}

            def isolate_typecheck(host, row, suffix, gate_bundle, gate_integration):
                home_result = command(['ssh', '-o', 'ConnectTimeout=10', host, 'printf %s "$HOME"'], timeout=30)
                if home_result.returncode or not home_result.stdout.strip().startswith('/'):
                    raise RuntimeError(f'cannot resolve persistent artifact home on {host}')
                remote_root = remote_batch_root(home_result.stdout.strip(), remote_id, suffix)
                remote_tree = f'{remote_root}-worktree'
                remote_tmpdir = f'{remote_root}-tmp'
                remote_art = f'{remote_root}-art'
                remote_bundle = gate_bundle['bundle'] if host == gate_bundle['host'] else f'{remote_root}.bundle'
                if host != gate_bundle['host']:
                    command(ssh_remote_command(host, f'umask 022; mkdir -p {shlex.quote(str(Path(remote_root).parent))}'), timeout=30)
                    remote_bundle_copies.append({'host': host, 'path': remote_bundle})
                    transfer = command(scp_transfer(f'{gate_bundle["host"]}:{gate_bundle["bundle"]}',
                                                     f'{host}:{remote_bundle}'), timeout=120)
                    if transfer.returncode:
                        raise RuntimeError(f'isolation bundle transfer {gate_bundle["host"]} to {host} failed #{row.pr}: {transfer.stderr[-1000:]}')
                else:
                    command(ssh_remote_command(host, f'umask 022; mkdir -p {shlex.quote(str(Path(remote_root).parent))}'), timeout=30)
                payload = build_remote_typecheck_command(args.base, gate_integration, remote_bundle,
                                                        remote_tree, remote_art, args.gate_timeout, remote_tmpdir)
                log_path = args.artifacts / f'typecheck-isolation-{row.pr}.stdout.log'
                with log_path.open('w') as out:
                    result = subprocess.run(ssh_remote_command(host, payload), text=True,
                                            stdout=out, stderr=subprocess.STDOUT,
                                            timeout=args.gate_timeout + 300)
                if result.returncode:
                    raise RuntimeError(f'single-PR typecheck isolation failed #{row.pr} on {host}; see {log_path}')
                summary_path = args.artifacts / f'typecheck-isolation-{row.pr}.json'
                preserved_art = preserve_remote_artifacts(host, remote_art, None, args.artifacts)
                copied = command(scp_transfer(f'{host}:{remote_art}/typecheck-summary.json', summary_path), timeout=60)
                if copied.returncode:
                    raise RuntimeError(f'isolation summary copy failed #{row.pr}: {copied.stderr[-1000:]} artifacts={preserved_art}')
                data = json.loads(summary_path.read_text())
                typecheck = data.get('typecheck')
                if (not isinstance(typecheck, dict) or typecheck.get('base40') != args.base
                        or typecheck.get('head40') != gate_integration):
                    raise RuntimeError(f'single-PR typecheck receipt unbound #{row.pr}')
                if typecheck.get('status') not in ('passed', 'failed'):
                    raise RuntimeError(f'single-PR typecheck unmeasured #{row.pr}: {typecheck.get("reason", "no reason")}')
                return typecheck

            primary_pr_files = pr_files
            first_gate_rc = invoke_gate(args.host, 'primary', summary,
                                        args.artifacts / 'remote-gate.stdout.log',
                                        integration_artifact, integration, chosen, primary_pr_files)
            retry_summary = None
            gate_host = args.host
            timeout_files = gate_timeout_only_files(summary)
            timeout_only_attempted = bool(timeout_files)
            first_failed = gate_failed_introduced(summary)
            if timeout_files:
                timeout_lock = None
                timeout_owner = None
                timeout_host = retry_host
                if timeout_host == args.host:
                    handoff = reserve_unmeasured_handoff(queue, {args.host})
                    if handoff is not None:
                        timeout_host, timeout_lock, timeout_owner = handoff
                timeout_result = {'status': 'unmeasured', 'host': timeout_host, 'files': timeout_files,
                                  'reason': 'no different host available'}
                # OP 11-08 06:15: 같은 호스트 재측정은 invoke_timeout_remeasure 가 거부(«must use a different host») → 05:2x 변경 되돌림
                if timeout_host != args.host:
                    try:
                        timeout_result = invoke_timeout_remeasure(
                            timeout_host, timeout_files, integration_artifact, integration)
                    finally:
                        if timeout_lock is not None:
                            release(timeout_lock, timeout_owner)
                summary_data = json.loads(summary.read_text())
                summary_data['trainTimeoutRemeasurement'] = timeout_result
                if timeout_result.get('status') == 'passed':
                    summary_data['trainOriginalGate'] = {
                        'verdict': summary_data.get('verdict'), 'exitCode': summary_data.get('exitCode')}
                    summary_data['verdict'] = 'passed'
                    summary_data['exitCode'] = 0
                    summary_data['verdictLine'] = str(summary_data.get('verdictLine', '')) + (
                        f"\n[train-timeout-remeasure] {len(timeout_files)} timed-out file(s) passed once "
                        f"on alternate host {timeout_host}; introduced=0")
                    first_failed = False
                else:
                    first_failed = True
                summary.write_text(json.dumps(summary_data, indent=2) + '\n')
            retry_rows, typecheck_excluded, attribution_fallback = (
                typecheck_retry_plan(chosen, summary) if first_failed else (chosen, [], False))
            gate_excluded, gate_failures = ([], [])
            if first_failed:
                gate_excluded, gate_failures = gate_failure_file_attribution(
                    pr_files, chosen, summary, args.artifacts)
                excluded = set(typecheck_excluded) | set(gate_excluded)
                survivors = [row for row in chosen if row.pr not in excluded]
                if survivors:
                    retry_rows = survivors
                else:
                    # Never manufacture an empty retry or strike every member
                    # when the failing file cannot be isolated from the batch.
                    typecheck_excluded, gate_excluded = [], []
                    retry_rows = list(chosen)
                gate_marker = args.artifacts / 'gate-rejections.json'
                if gate_excluded:
                    marker = json.loads(gate_marker.read_text())
                    manifest['gateExcludedPrs'] = gate_excluded
                    manifest['gateAttribution'] = str(gate_marker)
                    manifest['gateFailures'] = gate_failures
                    (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                    rows_by_pr = {str(row.pr): row for row in chosen}
                    for pr in gate_excluded:
                        row = rows_by_pr[pr]
                        owner = row_owner(row, repo)
                        details = marker.get('prs', {}).get(pr, {}).get('failures', [])
                        evidence = '\n'.join(f"{item['cause']}: {item['path']} · {item['evidence']}"
                                             for item in details)
                        body = (f'[TRAIN gate 귀속] #{pr} gate 실패 파일 소유 · strike 는 이 PR 에만 · '
                                f'base={args.base[:12]} head={row.head[:12]} run={remote_id}\n'
                                f'{evidence}\n기록 {gate_marker}')
                        sent = send_typecheck_owner(owner, body, repo)
                        log(f'gate rejection marker #{pr} owner={owner} mail_rc={sent.returncode}')
            retry_integration, retry_artifact = integration, integration_artifact
            retry_attributed = bool(typecheck_excluded or gate_excluded)
            retry_plan = plan_retry_for_batch(
                retry_rows, primary_pr_files, attributed=retry_attributed,
                attributed_pr_files=(changed_files_by_pr(repo, args.base, retry_rows)
                                    if retry_attributed else None))
            retry_rows, retry_pr_files = retry_plan['rows'], retry_plan['pr_files']
            if (first_failed or gate_is_unmeasured(summary, args.base, integration)) and not timeout_only_attempted:
                if typecheck_excluded or gate_excluded:
                    retry_artifact = integrate_rows_remote(
                        args.host, args.base, retry_rows, args.run_id,
                        'attributed-retry', integration_resources, remote_homes)
                    retry_integration = retry_artifact['head']
                    retry_artifact, retry_integration, retry_rows, retry_pr_files, _ = regenerate_integrated_tree_once(
                        args, queue, repo, retry_rows, retry_pr_files, retry_artifact,
                        integration_attempt + 1, manifest, integration_resources, remote_homes)
                    manifest['typecheckExcludedPrs'] = typecheck_excluded
                    manifest['typecheckAttribution'] = str(summary)
                    manifest['gateExcludedPrs'] = gate_excluded
                    manifest['gateAttribution'] = (str(args.artifacts / 'gate-rejections.json')
                                                   if gate_excluded else None)
                    if attribution_fallback:
                        manifest['typecheckIsolationFallback'] = 'all-attributed -> no attribution; retry intact batch'
                    manifest['typecheckRetryMembers'] = [{'pr': r.pr, 'head': r.head} for r in retry_rows]
                    (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                # OP 10-28 20:4x: 열차 N개 — 재판정은 기본 «자기 호스트»(--retry-host). 남의 열차 호스트로 가면 두 게이트가 겹쳐 baseline 이 OOM(SIGKILL)으로 unmeasured 가 된다(193133).
                retry_summary = args.artifacts / f'summary-{retry_host}-retry.json'
                retry_plan = plan_retry_for_batch(
                    retry_rows, primary_pr_files, attributed=retry_attributed,
                    attributed_pr_files=retry_pr_files if retry_attributed else None)
                retry_rows = retry_plan['rows']
                retry_pr_files = retry_plan['pr_files']
                retry_gate_rc = invoke_gate(
                    retry_host, 'retry', retry_summary,
                    args.artifacts / f'remote-gate-{retry_host}.stdout.log',
                    retry_artifact, retry_integration, retry_rows, retry_pr_files)
                gate_host = retry_host
                manifest['gateRetry'] = {'from': args.host, 'to': retry_host,
                                         'firstExitCode': first_gate_rc,
                                         'firstVerdict': 'failed' if first_failed else 'unmeasured',
                                         'summary': str(retry_summary), 'integrationHead': retry_integration,
                                         'members': [{'pr': r.pr, 'head': r.head} for r in retry_rows],
                                         'excludedByTypecheck': typecheck_excluded,
                                         'excludedByGateAttribution': gate_excluded}
                (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                # Repeated infrastructure/unmeasured on the same host is not a PR strike.
                # Reserve another train slot and pass the identical integration there.
                if retry_needs_unmeasured_handoff(retry_summary, args.base, retry_integration):
                    handoff = reserve_unmeasured_handoff(queue, {args.host, retry_host})
                    if handoff is None:
                        manifest['gateFailover'] = {'status': 'no-unreserved-train-host',
                                                    'afterHost': retry_host}
                    else:
                        handoff_host, handoff_lock, handoff_owner = handoff
                        handoff_summary = args.artifacts / f'summary-{handoff_host}-handoff.json'
                        try:
                            handoff_pr_files = changed_files_by_pr(repo, args.base, retry_rows)
                            invoke_gate(handoff_host, 'handoff', handoff_summary,
                                        args.artifacts / f'remote-gate-{handoff_host}-handoff.stdout.log',
                                        retry_artifact,
                                        retry_integration, retry_rows, handoff_pr_files)
                        finally:
                            release(handoff_lock, handoff_owner)
                        final_failover = json.loads(handoff_summary.read_text())
                        manifest['gateFailover'] = {'status': final_failover.get('verdict', 'unknown'),
                                                    'from': retry_host, 'to': handoff_host,
                                                    'summary': str(handoff_summary),
                                                    'integrationHead': retry_integration}
                        retry_summary = handoff_summary
                        retry_host = handoff_host
                        gate_host = handoff_host
                    (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            _, gate_invocations = select_gate_summary(
                summary, retry_summary, args.base, retry_integration, retry_rows, retry_host)
            if retry_summary is not None:
                summary = retry_summary
            final_summary = json.loads(summary.read_text())
            final_status = final_preflight_status(final_summary)
            if args.preflight_only:
                row = retry_rows[0]
                details = {'host': gate_host, 'summary': str(summary),
                           'integrationHead': retry_integration,
                           'typecheck': (final_summary.get('typecheck') or {}).get('status'),
                           'tests': final_summary.get('verdict'), 'mainMerge': 'passed',
                           'artifacts': str(args.artifacts)}
                memory_append(row.pr, row.head, args.base, 'solo-check', final_status,
                              run_id=remote_id, **details)
                preflight_result = {'status': final_status, 'pr': row.pr, 'head': row.head,
                                    'base': args.base, **details}
                (args.artifacts / 'preflight-result.json').write_text(
                    json.dumps(preflight_result, indent=2) + '\n')
                if final_status != 'passed':
                    owner = row_owner(row, repo)
                    body = (f'[TRAIN preflight] #{row.pr} 단독 사전 검문 {final_status} · '
                            f'head={row.head[:12]} base={args.base[:12]} host={gate_host} · '
                            f'typecheck={details["typecheck"]} · gate={details["tests"]} · '
                            f'산출물 {args.artifacts}')
                    sent = send_typecheck_owner(owner, body, repo)
                    log(f'solo preflight #{row.pr} status={final_status} owner={owner} mail_rc={sent.returncode}')
                else:
                    log(f'solo preflight #{row.pr} passed; cached PR/head/base in train-memory.jsonl')
                manifest['preflight'] = preflight_result
                (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                return preflight_result
            for row in retry_rows:
                memory_append(row.pr, row.head, args.base, 'batch-gate', final_status,
                              run_id=remote_id, host=gate_host,
                              summary=str(summary), integrationHead=retry_integration,
                              members=[item.pr for item in retry_rows])
            for pr in typecheck_excluded:
                row = next((item for item in chosen if item.pr == pr), None)
                if row:
                    memory_append(row.pr, row.head, args.base, 'batch-gate', 'failed',
                                  run_id=remote_id, host=gate_host,
                                  summary=str(summary), excludedByTypecheck=True,
                                  members=[item.pr for item in chosen])
            for pr in gate_excluded:
                row = next((item for item in chosen if str(item.pr) == str(pr)), None)
                if row:
                    memory_append(row.pr, row.head, args.base, 'batch-gate', 'failed',
                                  run_id=remote_id, host=args.host,
                                  summary=str(args.artifacts / 'gate-rejections.json'),
                                  excludedByGateAttribution=True,
                                  members=[item.pr for item in chosen])
            receipt_log = (args.artifacts / 'remote-gate.stdout.log' if gate_invocations == 1
                           else args.artifacts / f'remote-gate-{retry_host}.stdout.log')
            receipt_merge = merge_gate_receipt_marker(receipt_log, repo)
            manifest['gateReceiptMerge'] = receipt_merge
            (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            if not chosen_still_queued(queue, chosen):
                if regeneration_failed:
                    event = {'type': 'landing-skipped-after-regeneration-failure',
                             'status': 'gated-not-landed', 'integrationHead': integration,
                             'reason': 'selected queue head changed while the non-blocking regeneration hook failed'}
                    manifest.setdefault('events', []).append(event)
                    manifest['generatedRegeneration']['landing'] = event
                    (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                    result = {'schema': 1, 'status': 'gated-not-landed', 'base': args.base,
                              'queueSha256': hashlib.sha256(snapshot).hexdigest(), 'prs': [],
                              'integrationHead': integration, 'reason': event['reason'],
                              'gateInvocations': gate_invocations}
                    (args.artifacts / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
                    log('gate completed on pinned pre-hook integration; stale queue heads were not landed')
                    return result
                raise RuntimeError('queue changed before landing (chosen PR removed or head moved)')
            wait_queue_lock_clear(queue, 'before landing')
            landed = []
            for row in retry_rows:
                result = command(land_single_command(args.land_single, remote_id, row,
                                                     args.side_main, gate_host, summary),
                                 timeout=args.land_timeout)  # OP 10-27 19:4x: land-single 은 main12 를 요구 — 40자를 넘기면 착지 단계에서 거부
                if result.returncode:
                    raise RuntimeError(f'land-single refused #{row.pr}: {(result.stderr or result.stdout)[-1200:]}')
                merge = re.search(r'^MERGED ([0-9a-f]{12,40})$', result.stdout, re.M)
                if not merge:
                    raise RuntimeError(f'land-single gave no merge SHA for #{row.pr}')
                landed.append({'pr': row.pr, 'head': row.head, 'merge': merge.group(1)})
                (args.artifacts / 'landed.json').write_text(json.dumps(landed, indent=2) + '\n')
            if landed:
                merged_list = ', '.join(f"#{item['pr']} {item['merge'][:12]}" for item in landed)
                report = f'[TRAIN] 묶음 {args.run_id} 착지 {merged_list} · host={gate_host}'
                posted = subprocess.run(['eln', 'msg', 'post', '--from', 'TRAIN', '--to', 'OP',
                                         '--kind', 'report', '--body', report],
                                        capture_output=True, text=True, timeout=60)
                manifest['batchReport'] = {'body': report, 'returnCode': posted.returncode,
                                           'output': (posted.stdout or posted.stderr)[-500:]}
                (args.artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            result = {'schema': 1, 'status': 'landed', 'base': args.base,
                      'queueSha256': hashlib.sha256(snapshot).hexdigest(), 'prs': landed,
                      'deferred': deferred + [
                          {'pr': pr, 'reason': 'integrated-branch typecheck error attribution',
                           'summary': str(summary), 'retryMembers': [r.pr for r in retry_rows]}
                          for pr in typecheck_excluded],
                      'gateInvocations': gate_invocations,
                      'typecheckExcludedPrs': typecheck_excluded,
                      'gateExcludedPrs': gate_excluded}
            (args.artifacts / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
            return result
        finally:
            try:
                cleanup_remote_bundle_copies(remote_bundle_copies)
            finally:
                cleanup_remote_integrations(integration_resources)
    finally:
        try:
            release_acquired_lock(batch_lock_handle)
        finally:
            release_direct_claim(direct_claim, lock)


def main(argv=None):
    p = argparse.ArgumentParser()
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--live', action='store_true')
    p.add_argument('--queue', required=True); p.add_argument('--repo', required=True); p.add_argument('--base', required=True)
    p.add_argument('--limit', type=int, choices=range(1, 6), default=4); p.add_argument('--host', default='node-b')
    p.add_argument('--express', action='store_true')  # 대표 10-28 «열차 급행 — 단독으로 · 급할 때»: --limit 1 은 --express 와 함께만
    p.add_argument('--artifacts', type=Path); p.add_argument('--authorize', default=''); p.add_argument('--op-watching', action='store_true')
    p.add_argument('--land-single', type=Path); p.add_argument('--summary', type=Path); p.add_argument('--integration-head', default='')
    p.add_argument('--side-main', default=''); p.add_argument('--run-id', default='')
    p.add_argument('--gate-timeout', type=int, default=3600); p.add_argument('--land-timeout', type=int, default=3600)
    p.add_argument('--shards', type=int, default=12)
    p.add_argument('--exclude', default='')  # 다른 열차가 잡은 PR(쉼표) — dry-run·live 둘 다 같은 값을 준다
    p.add_argument('--retry-host', default='')  # 생략하면 원 배치 호스트(args.host); manager 할당을 명시 전달
    p.add_argument('--lock', default='')  # 열차별 배치 잠금 디렉터리(예: land-queue.tsv.batch.lock.node-c)
    p.add_argument('--preflight-only', action='store_true')
    p.add_argument('--allow-preflight-overlap', action='store_true', help='OP-authorized same-PR parallel preflight; forbidden for landing')
    a = p.parse_args(argv)
    coupled_gate_bundle = {'34447', '34448', '34455', '34457', '34458'}
    if a.limit == 5 and (not a.express or set(a.authorize.split(',')) != coupled_gate_bundle):
        raise ValueError('limit 5 is reserved for the coupled gate-fix express bundle')
    if a.limit == 1 and not a.express: raise ValueError('limit 1 requires --express (급행 · 단독 열차)')
    if a.preflight_only and (not a.express or a.limit != 1):
        raise ValueError('--preflight-only requires --express --limit 1')
    if a.allow_preflight_overlap and not a.preflight_only:
        raise ValueError('--allow-preflight-overlap requires --preflight-only')
    if not re.fullmatch(r'[0-9a-f]{40}', a.base): raise ValueError('base must be a full SHA')
    if a.live:
        if min(a.gate_timeout, a.land_timeout, a.shards) <= 0:
            raise ValueError('timeouts and shards must be positive')
        try:
            run_live(a)
        except Exception as exc:
            if a.authorize and a.run_id:
                append_refusal_event(a, str(exc))
            raise
    else: print(json.dumps(make_plan(a.queue, a.repo, a.base, a.limit, parse_exclude(a.exclude)), indent=2))
    return 0

if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as exc:
        print(f'BATCH REFUSED: {exc}', file=sys.stderr)
        sys.exit(2)
# Live refuses before gate/landing until the observed aggregate-gate artifact schema binds exact base,
# integration head, ordered PR heads, verdict, introduced, unknown, and unrun importer counts.
# Landing must call the existing guarded land-single.sh; queue removal remains active-loop owned.
# Active train-loop.sh/am-one.sh are untouched; a 2+ PR OP-attended canary remains required.
