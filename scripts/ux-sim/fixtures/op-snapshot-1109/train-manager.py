#!/usr/bin/env python3
"""Single queue manager: measure each PR/head/base once, then assign approved trains to worker slots."""
from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import socket
import time
from datetime import datetime

ROOT = Path.home() / 'elanous-hq/seat-state/OP'
TOOLS = ROOT / 'tools'
QUEUE = ROOT / 'land-queue.tsv'
HOSTS = ROOT / 'train-hosts.tsv'
TRAIN_ARTIFACTS = ROOT / 'train-artifacts'
REPO = Path.home() / 'elanous-hq/work/OP-release-0238'
MEMORY_HELPER = TOOLS / 'train-memory.py'
MEMORY_SPEC = importlib.util.spec_from_file_location('train_memory_manager', MEMORY_HELPER)
MEMORY = importlib.util.module_from_spec(MEMORY_SPEC)
MEMORY_SPEC.loader.exec_module(MEMORY)
BATCH_HELPER = Path.home() / 'elanous-hq/seat-state/OPT/train-batch-live.py'
BATCH_SPEC = importlib.util.spec_from_file_location('train_batch_manager', BATCH_HELPER)
BATCH = importlib.util.module_from_spec(BATCH_SPEC)
BATCH_SPEC.loader.exec_module(BATCH)
TIER_LANES_PATH = TOOLS / 'gate-tier-lanes.py'
TIER_LANES_SPEC = importlib.util.spec_from_file_location('train_gate_tier_lanes', TIER_LANES_PATH)
TIER_LANES = importlib.util.module_from_spec(TIER_LANES_SPEC)
TIER_LANES_SPEC.loader.exec_module(TIER_LANES)
MANAGER_DIR = ROOT / 'train-manager'
ASSIGN_DIR = MANAGER_DIR / 'assignments'
WORKER_DIR = MANAGER_DIR / 'workers'
PID_FILE = ROOT / 'train-manager.pid'
LOG = ROOT / 'train-manager.log'
CLOSED_QUEUE_EVENTS = MANAGER_DIR / 'closed-queue-removals.jsonl'
AMG = TOOLS / 'train-conflict-resolve.sh'
AMG_LOCK = ROOT / 'train-conflict-resolve.lock'
ACTIVE_HOSTS = ('aws1', 'aws2', 'aws3', 'host-e-wsl', 'gcp1', 'gcp2', 'minim5', 'node-c', 'mshq', 'node-b')  # elangram-wsl draining after SSH timeout; exclude new assignments.
SHARDS = {'aws1': 16, 'aws2': 16, 'aws3': 16, 'gcp1': 16, 'minim5': 12, 'node-c': 8, 'gcp2': 8, 'node-b': 16, 'host-e-wsl': 8, 'mshq': 16, 'elangram-wsl': 12}
# 03:5x OP load rebalance: caps affect new assignments only; in-flight slot workers drain normally.
HOST_CAPS = {'aws1': 3, 'aws3': 0,  # OP 11-05 07:5x aws1 재합류
             'aws2': 0, 'gcp1': 0, 'minim5': 2,  # OP 11-04 22:2x 대표 «aws1 일 끝나면 stop · minim5·node-b·wsl 로»
             'node-c': 0, 'gcp2': 0,  # OP 22:0x 1시간 점검: aws1 16/16·gcp2 8/8 = 100% → −1  # OP 11-03 20:1x 대표 «기차 소화량을 늘려라» · 원격 부하 40%↓ → +1
             'host-e-wsl': 2, 'mshq': 1, 'node-b': 3}  # OP 11-05 03:35 wsl 2칸(#35036 wsl 묶음 shards 2·primary-art 보존 통과) · mshq 122% → 1 · OP 11-05 03:3x wsl 1칸으로 되돌림(UX: #35035 묶음은 no-tests·shards 0 — 측정·rsync 미증명) · OP 11-05 02:58 wsl 2칸 복귀(#35035 wsl 묶음 착지) · OP 11-05 02:5x wsl 1칸 시험 복귀(#35035 preflight 통과) · OP 11-05 01:3x mshq 83% → 3→2 · OP 11-04 23:4x wsl 드레인: aggregate gate unmeasured rc=1 ~10 · rsync primary-art code 23 ~6  # OP 07:5x rebalance: GCP slots by load; gcp2/mshq +1, node-c/minim5/gcp1 reduced; node-b normal.
SLOT_PREFIX = {'aws1': (5, 15, 25, 35, 45, 55, 65), 'aws2': (4, 14, 24, 34, 44), 'aws3': (10, 20, 30, 40), 'gcp1': (9, 19, 29),
               'minim5': (8, 18, 28, 38), 'node-c': (7,), 'gcp2': (6, 16, 26), 'host-e-wsl': (1, 11, 21, 31, 41, 51), 'mshq': (3, 13, 23, 73, 33, 83, 93), 'elangram-wsl': (33, 43), 'node-b': (2, 12, 22, 32, 42, 52, 62)}
# OP: 0.3.8 cut 04:30 KST; every host drains at T-1h.
STOP_AT = {host: '202611100330' for host in ACTIVE_HOSTS}
ALWAYS_RATCHET_PROFILE = 'train-always-ratchets-v1'
EXPRESS_ORDER = ('34423', '34428', '34422')
EXPRESS_ORDER_FILE = MANAGER_DIR / 'express-order.tsv'
GATE_0245_FILE = MANAGER_DIR / 'gate-0245-prs.tsv'
EXPRESS_INDEPENDENT_FILE = MANAGER_DIR / 'express-independent-prs.tsv'
OP_EXPRESS_FILE = MANAGER_DIR / 'op-express-prs.tsv'
EXPRESS_DISCOVERY_AT = 0.0
OPEN_PR_CACHE = None
OPEN_PR_CACHE_AT = 0.0
OPEN_PR_BASE_CACHE = {}
EXPRESS_FORBIDDEN_HEADS = {
    '34363': 'e5f654768321f8b0fe25904e4c6a6124c45a0401',
    '34453': 'bd0ad10b7fc17cf31b672247d1eb87237cbac10d',
}
URGENT_RELEASE_REPAIR_PRS = set()
GATE_FIX_COUPLED_BUNDLE = ()
MUST_0246_ORDER = ('34374', '34246', '34472', '34460', '34461', '34473', '34465', '34470', '34453', '34454', '34439', '34405',
                   '34466', '34433', '34422', '34411', '34450', '34462', '34468')
OP_EXPRESS_GROUPS = (('34454', '34449'),)
OP_EXPRESS_FIRST = ('34505', '34551')
HELD_NEW_ASSIGNMENT_SLOTS = {('aws1', 4), ('aws2', 4), ('gcp1', 4), ('host-e-wsl', 4)}  # 03:00 load rebalance: retain in-flight; lower gcp1/aws2 after completion; node-b slots reopened through 05:15.
OP_EXPRESS_HOST_PREFER = {'34505': ('node-b',), '34646': ('minim5', 'node-c')}
TYPECHECK_HOLDS = MANAGER_DIR / 'typecheck-author-holds.json'
TYPECHECK_HOLD_THRESHOLD = 2
MANUAL_TYPECHECK_REPAIR_WAITS = {
    '34490': {'head': 'df08815845616682580fb4c1929613e0dbc3e51b',
              'reason': 'owner repair head 61064da8 pending Terra r7'},
}
TICK_ASSIGNMENTS = []
TICK_EXCLUSIONS = set()
DOCS_ONLY_GATE_FALLBACK = set()
AUTOPSY_QUEUE = Path.home() / 'elanous-hq/seat-state/OPT/TRAIN-AUTOPSY-QUEUE.tsv'
EXCLUSION_EVENTS = MANAGER_DIR / 'candidate-exclusions.jsonl'
EXCLUSION_ALERTS = MANAGER_DIR / 'candidate-exclusion-alerts.json'
REFUSAL_EVENTS = MANAGER_DIR / 'refusal-events.jsonl'
PARKED = ROOT / 'land-queue.parked.tsv'
AMG_FAILURE_EVENTS = MANAGER_DIR / 'amg-failures.jsonl'
AMG_FAILURE_CURSOR = MANAGER_DIR / 'amg-failures.cursor'
LIGHT_LAND_LOCK = MANAGER_DIR / 'light-land.lock'
DOCS_ONLY_EXTENSIONS = ('.md', '.json')
DOCS_ONLY_ALLOWED_PATHS = ('release/public/docs/**/*.md', 'website/pages.json')


def log(message):
    line = f"{datetime.now().astimezone().strftime('%m-%d %H:%M:%S')} [train-manager] {message}"
    with LOG.open('a', encoding='utf-8') as stream:
        stream.write(line + '\n')
    print(line, flush=True)


def append_locked_jsonl(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(str(path) + '.lock')
    line = json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n'
    with lock_path.open('a', encoding='utf-8') as lock_stream:
        fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX)
        with path.open('a', encoding='utf-8') as stream:
            stream.write(line)
            stream.flush()
            os.fsync(stream.fileno())
        fcntl.flock(lock_stream.fileno(), fcntl.LOCK_UN)


def append_autopsy_queue(pr, head, base, reason, conflict_files):
    AUTOPSY_QUEUE.parent.mkdir(parents=True, exist_ok=True)
    files = '|'.join(sorted(set(str(item).replace('\t', ' ').replace('\n', ' ') for item in conflict_files)))
    fields = [str(pr), head.lower(), base.lower(), str(reason).replace('\t', ' '), files or 'unknown']
    line = '\t'.join(fields) + '\n'
    lock_path = Path(str(AUTOPSY_QUEUE) + '.lock')
    with lock_path.open('a', encoding='utf-8') as lock_stream:
        fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX)
        try:
            existing = AUTOPSY_QUEUE.read_text(encoding='utf-8').splitlines()
        except OSError:
            existing = []
        if '\t'.join(fields) not in existing:
            with AUTOPSY_QUEUE.open('a', encoding='utf-8') as stream:
                stream.write(line)
                stream.flush()
                os.fsync(stream.fileno())
        fcntl.flock(lock_stream.fileno(), fcntl.LOCK_UN)


def send_op_report(body):
    result = subprocess.run(['eln', 'msg', 'post', '--from', 'TRAIN', '--to', 'OP',
                             '--kind', 'report', '--body', body],
                            capture_output=True, text=True, timeout=60)
    log(f'OP report rc={result.returncode}: {body}')


def record_candidate_exclusion(row, base, reason, next_action, conflict_files=(), occurrence_id=''):
    identity = (str(row.pr), row.head.lower(), base.lower(), occurrence_id or 'tick')
    if identity in TICK_EXCLUSIONS:
        return 0
    TICK_EXCLUSIONS.add(identity)
    # Count persistent unique-tick exclusion records for this exact PR head; a new base is new evidence.
    matches = []
    try:
        for line in EXCLUSION_EVENTS.read_text(encoding='utf-8').splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if str(event.get('pr')) == str(row.pr) and str(event.get('head', '')).lower() == row.head.lower():
                matches.append(event)
    except OSError:
        pass
    count = len(matches) + 1
    append_locked_jsonl(EXCLUSION_EVENTS, {
        'at': datetime.now().astimezone().isoformat(timespec='seconds'), 'pr': str(row.pr),
        'head': row.head.lower(), 'base': base.lower(), 'reason': reason,
        'nextAction': next_action, 'conflictFiles': list(conflict_files),
        'occurrenceId': occurrence_id, 'count': count,
    })
    if reason == 'main-merge-conflict':
        append_autopsy_queue(row.pr, row.head, base, reason, conflict_files)
        next_action = 'autopsy-queue'
    log(f'candidate excluded #{row.pr} head={row.head[:12]} base={base[:12]} reason={reason} '
        f'next={next_action} repeated={count}')
    if count >= 3 and reason == 'main-merge-conflict':
        park_path = TOOLS / 'train-park.py'
        try:
            namespace = {'__name__': 'train_park_conflict', '__file__': str(park_path)}
            exec(compile(park_path.read_text(encoding='utf-8'), str(park_path), 'exec'), namespace)
            owner = namespace['park'](
                str(QUEUE), str(row.pr), row.head,
                f'integration-conflict: same-head main merge conflict {count}x',
                'main-merge-conflict',
                f'base={base}; conflictFiles={"|".join(conflict_files) or "unknown"}',
                {'bundle_members': [str(row.pr)], 'integration_head': base,
                 'failed_stage': 'main-merge-conflict', 'file_line': 'unknown'})
            if owner is not None:
                next_action = 'parked-after-3-main-merge-conflicts'
                log(f'auto-parked main-merge-conflict #{row.pr} head={row.head[:12]} count={count} owner={owner}')
            else:
                log(f'auto-park skipped main-merge-conflict #{row.pr} head={row.head[:12]}: queue row absent or head changed')
        except Exception as exc:
            log(f'auto-park failed main-merge-conflict #{row.pr} head={row.head[:12]}: {type(exc).__name__}: {exc}')
    if count >= 3 and not reason.startswith('amg-'):
        try:
            alerts = json.loads(EXCLUSION_ALERTS.read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError):
            alerts = {}
        alert_key = f'{row.pr}:{row.head.lower()}'
        if alert_key not in alerts:
            alerts[alert_key] = {'count': count, 'lastReason': reason}
            temp = EXCLUSION_ALERTS.with_name(EXCLUSION_ALERTS.name + '.tmp')
            temp.write_text(json.dumps(alerts, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            os.replace(temp, EXCLUSION_ALERTS)
            send_op_report(f'반복 후보 제외 #{row.pr} head={row.head[:12]} {count}회 · 마지막 사유={reason} · 다음 수={next_action}')
    return count


def conflict_files_from_output(output):
    found = []
    for line in (output or '').splitlines():
        match = re.match(r'^CONFLICT [^:]+:\s*(.*)$', line)
        if match:
            path = match.group(1).strip()
            path = re.sub(r'^Merge conflict in\s+', '', path)
            if path:
                found.append(path)
    return sorted(set(found))


def process_amg_failures(rows, base):
    if not AMG_FAILURE_EVENTS.exists():
        return
    try:
        offset = int(AMG_FAILURE_CURSOR.read_text(encoding='utf-8').strip())
    except (OSError, ValueError):
        offset = AMG_FAILURE_EVENTS.stat().st_size
        AMG_FAILURE_CURSOR.parent.mkdir(parents=True, exist_ok=True)
        AMG_FAILURE_CURSOR.write_text(f'{offset}\n', encoding='utf-8')
        return
    with AMG_FAILURE_EVENTS.open('rb') as stream:
        stream.seek(offset)
        chunk = stream.read()
    if not chunk:
        return
    complete = chunk.rsplit(b'\n', 1)
    if len(complete) == 1:
        return
    consumed = len(complete[0]) + 1
    AMG_FAILURE_CURSOR.write_text(f'{offset + consumed}\n', encoding='utf-8')
    queue_heads = {str(row.pr): row.head.lower() for row in rows}
    for raw in complete[0].splitlines():
        try:
            event = json.loads(raw)
        except (ValueError, TypeError):
            log('ignored malformed AMG failure event')
            continue
        pr = str(event.get('pr', ''))
        head = str(event.get('head', '')).lower()
        event_base = str(event.get('base', '')).lower()
        if queue_heads.get(pr) != head or len(event_base) != 40:
            log(f'ignored stale AMG failure #{pr} head={head[:12]}')
            continue
        row = next((item for item in rows if str(item.pr) == pr), None)
        if row is None:
            continue
        reason = str(event.get('reason') or 'unknown AMG failure')
        files = event.get('conflictFiles') or []
        record_candidate_exclusion(row, event_base, 'amg-resolution-failed',
                                   'Railwright ladder: 1 structural union → 3 isolated merge/tests → 4 reimplementation; ledger only', files,
                                   str(event.get('at', event.get('eventId', ''))))
        try:
            prior_events = [json.loads(line) for line in EXCLUSION_EVENTS.read_text(encoding='utf-8').splitlines()]
        except (OSError, ValueError):
            prior_events = []
        count = sum(1 for item in prior_events
                    if str(item.get('pr')) == pr and str(item.get('head', '')).lower() == head
                    and str(item.get('reason', '')).startswith('amg-resolution-failed'))
        log(f'AMG failure retained in Railwright ledger #{pr} head={head[:12]} count={count} '
            f'conflictFiles={"|".join(files) or 'unknown'}; no retry, autopsy enqueue, or OP mail')

def memory_rows(pr, head, base, event_type):
    return MEMORY.exact_rows(str(pr), head.lower(), base.lower(), event_type)


def passed_gate_receipt(row, base, event):
    """Return the reusable green summary only when its exact-key gate authorizes this PR."""
    summary_path = Path(str(event.get('summary') or ''))
    if not summary_path.is_file():
        return None, 'passed gate summary is missing; rerun preflight'
    try:
        summary = json.loads(summary_path.read_text(encoding='utf-8'))
        batch_dir = summary_path.parent
        manifest_path = batch_dir / 'manifest.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, ValueError, TypeError):
        return None, 'passed gate summary or manifest is unreadable; rerun preflight'
    tests = list(BATCH.TRAIN_ALWAYS_RATCHETS)
    green = (
        # OP 11-05 00:4x: batch-live 와 같은 판정 — no-tests skip(shards 0·회귀 0)도 초록 영수증이다
        (summary.get('verdict') == 'passed'
         or (summary.get('verdict') == 'skipped' and summary.get('artifactsUnavailable') == 'no-tests'
             and summary.get('shards') == 0
             and all(summary.get(k) == 0 for k in ('introduced', 'unknown', 'unrunImporters'))))
        and summary.get('exitCode') == 0
        and summary.get('base40', '').lower() == base.lower()
        and summary.get('gateProfile') == ALWAYS_RATCHET_PROFILE
        and summary.get('trainAlwaysRatchets', {}).get('status') == 'passed'
        and summary.get('trainAlwaysRatchets', {}).get('exitCode') == 0
        and summary.get('trainAlwaysRatchets', {}).get('tests') == tests
        and summary.get('typecheck', {}).get('status') == 'passed'
        and summary.get('typecheck', {}).get('newErrors') == 0
        and manifest.get('base', '').lower() == base.lower()
        and manifest.get('gateProfile') == ALWAYS_RATCHET_PROFILE
        and manifest.get('alwaysRatchets') == tests
    )
    members = manifest.get('gateRetry', {}).get('members')
    if not isinstance(members, list):
        members = manifest.get('members', [])
    member = any(str(item.get('pr')) == str(row.pr)
                 and str(item.get('head', '')).lower() == row.head.lower()
                 for item in members if isinstance(item, dict))
    if not green or not member:
        return None, 'passed memory lacks an exact green gate receipt/member; rerun preflight'
    if event.get('integrationHead') and str(event['integrationHead']).lower() != str(summary.get('head40', '')).lower():
        return None, 'passed memory integration head differs from summary; rerun preflight'
    return str(summary_path), ''


def docs_only_files(row):
    """Allow release Markdown and the static website page index JSON only."""
    try:
        result = subprocess.run(['gh', 'pr', 'view', str(row.pr), '-R', 'ElanvitalAI/elanous',
                                 '--json', 'headRefOid,files'], capture_output=True, text=True, timeout=30)
        if result.returncode:
            return None, f'GitHub file list unavailable rc={result.returncode}'
        value = json.loads(result.stdout)
        if str(value.get('headRefOid', '')).lower() != row.head.lower():
            return None, 'PR head changed since queue observation'
        files = sorted({str(item.get('path', '')) for item in value.get('files', [])})
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError) as exc:
        return None, f'GitHub file list unavailable: {type(exc).__name__}'
    if not files:
        return None, 'empty changed-file list'
    allowed = all((path == 'website/pages.json' or
                   (path.startswith('release/public/docs/') and path.endswith('.md')))
                  and Path(path).suffix.lower() in DOCS_ONLY_EXTENSIONS for path in files)
    if not allowed:
        return None, 'changed files exceed docs-only allowlist'
    return files, ''


def light_land_docs_only(rows, base):
    """Use the HQ single-concurrency lane for a measured docs-only no-tests preflight."""
    candidates = []
    for row in rows:
        history = [event for event in MEMORY.events()
                   if event.get('eventType') == 'solo-check'
                   and str(event.get('key', {}).get('pr')) == str(row.pr)
                   and str(event.get('key', {}).get('head', '')).lower() == row.head.lower()]
        if not history:
            continue
        event = history[-1]
        if (event.get('status') != 'unmeasured' or event.get('tests') != 'skipped'
                or event.get('typecheck') != 'passed' or event.get('mainMerge') != 'passed'):
            continue
        # A docs-only receipt is merely a light-land shortcut. Any failure to
        # prove the shortcut must fall through to the normal gate path.
        DOCS_ONLY_GATE_FALLBACK.add((str(row.pr), row.head.lower()))
        summary_path = Path(str(event.get('summary') or ''))
        try:
            summary = json.loads(summary_path.read_text(encoding='utf-8'))
            batch_dir = summary_path.parent
            manifest = json.loads((batch_dir / 'manifest.json').read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError) as exc:
            log(f'docs-only shortcut unavailable #{row.pr}: evidence read failed ({type(exc).__name__}); normal gate fallback')
            continue
        tests = list(BATCH.TRAIN_ALWAYS_RATCHETS)
        if not (summary.get('verdict') == 'skipped' and summary.get('artifactsUnavailable') == 'no-tests'
                and summary.get('gateProfile') == ALWAYS_RATCHET_PROFILE
                and summary.get('trainAlwaysRatchets', {}).get('status') == 'passed'
                and summary.get('trainAlwaysRatchets', {}).get('exitCode') == 0
                and summary.get('trainAlwaysRatchets', {}).get('tests') == tests
                and summary.get('typecheck', {}).get('status') == 'passed'
                and summary.get('typecheck', {}).get('newErrors') == 0
                and manifest.get('gateProfile') == ALWAYS_RATCHET_PROFILE
                and manifest.get('alwaysRatchets') == tests
                and any(str(item.get('pr')) == str(row.pr)
                        and str(item.get('head', '')).lower() == row.head.lower()
                        for item in manifest.get('members', []) if isinstance(item, dict))):
            log(f'docs-only shortcut unavailable #{row.pr}: receipt precondition failed; normal gate fallback')
            continue
        files, problem = docs_only_files(row)
        if files is None:
            log(f'docs-only shortcut unavailable #{row.pr}: {problem}; normal gate fallback')
            continue
        candidates.append((row, event, summary_path, files))
    if not candidates:
        return False
    if not LIGHT_LAND_LOCK.parent.exists():
        LIGHT_LAND_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with LIGHT_LAND_LOCK.open('a', encoding='utf-8') as lane_lock:
        try:
            fcntl.flock(lane_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log('docs-only light-land lane busy; concurrency=1')
            return True
        row, event, summary_path, files = candidates[0]
        if not main_merge(row, base):
            log(f'docs-only light-land held #{row.pr}: current-base mainMerge not passed')
            return True
        authority = {
            'schema': 'elanous.train.docs-only-land.v1', 'status': 'passed',
            'pr': str(row.pr), 'head': row.head.lower(), 'landingBase': base.lower(),
            'preflightBase': str(event.get('key', {}).get('base', '')).lower(),
            'summary': str(summary_path), 'changedFiles': files,
            'extensions': list(DOCS_ONLY_EXTENSIONS), 'allowedPaths': list(DOCS_ONLY_ALLOWED_PATHS),
            'mainMergePassed': True, 'typecheckPassed': True, 'alwaysRatchetsPassed': True,
        }
        authority_path = summary_path.parent / 'docs-only-land-authority.json'
        authority_path.write_text(json.dumps(authority, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        claim = ROOT / 'train-claims/claim-train-light-land.tsv'
        claim.write_text(f'{os.getpid()}\tHQ\t{LIGHT_LAND_LOCK}\t{row.pr}\n', encoding='utf-8')
        run_id = str(int(time.time()) * 10 + 7)
        host = str(event.get('host') or 'gcp2')
        command = ['zsh', str(TOOLS / 'train-1016/night-train/land-single.sh'), run_id,
                   str(row.pr), row.head, base[:12], host, str(summary_path)]
        log(f'docs-only light-land authorized #{row.pr} files={",".join(files)} '
            f'extensions={",".join(DOCS_ONLY_EXTENSIONS)} paths={";".join(DOCS_ONLY_ALLOWED_PATHS)} '
            f'mainMerge=passed typecheck=passed alwaysRatchets=passed concurrency=1')
        try:
            result = subprocess.run(command, cwd=Path.home() / 'elanous-hq/seats/OP',
                                    capture_output=True, text=True, timeout=2400)
            output = (result.stdout or '') + (result.stderr or '')
            match = re.search(r'REPORT_PENDING batch=\d+ pr=\d+ head=([0-9a-f]{12})', output)
            if result.returncode == 0 and match:
                status = subprocess.run(['gh', 'pr', 'view', str(row.pr), '-R', 'ElanvitalAI/elanous',
                                         '--json', 'mergeCommit'], capture_output=True, text=True, timeout=30)
                merged_sha = json.loads(status.stdout).get('mergeCommit', {}).get('oid', '') if status.returncode == 0 else ''
                append_memory(row, base, 'docs-only-light-land', 'passed', runId=run_id,
                              mergeSha=merged_sha, summary=str(summary_path), changedFiles=files)
                log(f'docs-only light-land merged #{row.pr} sha={merged_sha} run={run_id}')
            else:
                log(f'docs-only light-land failed #{row.pr} rc={result.returncode} output={(output.strip()[-1200:])}')
        except (OSError, subprocess.TimeoutExpired) as exc:
            log(f'docs-only light-land error #{row.pr}: {type(exc).__name__}: {exc}')
        finally:
            claim.unlink(missing_ok=True)
        return True


def light_land_gate_tier_t0(rows, base):
    """Direct-land only exact T0 evidence with a proven remote test receipt."""
    for row in rows:
        try:
            evidence = json.loads(Path(row.evidence).read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError) as exc:
            log(f'T0 direct lane fallback #{row.pr}: queue evidence unreadable ({type(exc).__name__})')
            continue
        tier = evidence.get('gateTier') if isinstance(evidence, dict) else None
        if not TIER_LANES.is_t0_remote_test_candidate(evidence):
            continue  # docs-only uses the existing separately guarded light-land path.
        if not TIER_LANES.remote_test_receipt_matches_base(evidence, base):
            log(f'T0 direct lane fallback #{row.pr}: remote-test receipt is for another base')
            continue
        try:
            live = subprocess.run(['gh', 'pr', 'view', str(row.pr), '-R', 'ElanvitalAI/elanous',
                                   '--json', 'headRefOid,baseRefName,files'], capture_output=True, text=True, timeout=30)
            data = json.loads(live.stdout) if live.returncode == 0 else {}
            live_head = str(data.get('headRefOid', '')).lower()
            base_ref = str(data.get('baseRefName', ''))
            files = sorted({str(item.get('path', '')) for item in data.get('files', [])
                            if isinstance(item, dict) and isinstance(item.get('path'), str)})
        except (OSError, subprocess.TimeoutExpired, ValueError, TypeError) as exc:
            log(f'T0 direct lane fallback #{row.pr}: PR head/files unavailable ({type(exc).__name__})')
            continue
        decision = TIER_LANES.direct_squash_decision(
            evidence, expected_pr=int(row.pr), expected_head=row.head,
            observed_head=live_head, current_base=base)
        if base_ref != 'main':
            log(f'T0 direct lane fallback #{row.pr}: PR base is {base_ref or "unmeasured"}, expected main')
            continue
        if decision.get('action') != 'head-pinned-squash' or decision.get('localChecks'):
            log(f'T0 direct lane fallback #{row.pr}: {decision.get("reason", "local checks remain")}')
            continue
        if not files or not main_merge(row, base):
            log(f'T0 direct lane held #{row.pr}: empty changed-file list or main merge not passed')
            continue
        host = ''
        try:
            host = next((line.split('\t')[0] for line in HOSTS.read_text(encoding='utf-8').splitlines()
                         if len(line.split('\t')) >= 5 and line.split('\t')[4] == 'yes'), '')
        except OSError:
            pass
        if not host:
            log(f'T0 direct lane held #{row.pr}: no enabled land-single host')
            return True
        authority = {'schema': 'elanous.train.gate-tier-t0-land.v1', 'status': 'passed',
                     'pr': str(row.pr), 'head': row.head.lower(), 'base': base.lower(),
                     'gateTier': tier, 'gate': evidence.get('gate'), 'localChecks': [],
                     'changedFiles': files}
        authority_dir = MANAGER_DIR / 't0-authority'
        authority_dir.mkdir(parents=True, exist_ok=True)
        authority_path = authority_dir / f'{row.pr}-{row.head.lower()}-{base.lower()}.json'
        authority_path.write_text(json.dumps(authority, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        run_id = str(int(time.time()) * 10 + 7)
        command = ['zsh', str(TOOLS / 'train-1016/night-train/land-single.sh'), run_id,
                   str(row.pr), row.head, base[:12], host, str(authority_path)]
        LIGHT_LAND_LOCK.parent.mkdir(parents=True, exist_ok=True)
        lane_lock = LIGHT_LAND_LOCK.open('a', encoding='utf-8')
        try:
            fcntl.flock(lane_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lane_lock.close()
            log('T0 direct lane busy; concurrency=1')
            return True
        claim = ROOT / 'train-claims/claim-train-light-land.tsv'
        claim.write_text(f'{os.getpid()}\tHQ\t{LIGHT_LAND_LOCK}\t{row.pr}\n', encoding='utf-8')
        log(f'T0 direct lane authorized #{row.pr} head={row.head[:12]} base={base[:12]} '
            f'files={len(files)} remoteTestReceipt=passed currentMainMerge=passed concurrency=1')
        try:
            result = subprocess.run(command, cwd=Path.home() / 'elanous-hq/seats/OP',
                                    capture_output=True, text=True, timeout=2400)
            output = (result.stdout or '') + (result.stderr or '')
            log(f'T0 direct lane #{row.pr} rc={result.returncode} output={output.strip()[-1200:]}')
        except (OSError, subprocess.TimeoutExpired) as exc:
            log(f'T0 direct lane error #{row.pr}: {type(exc).__name__}: {exc}')
        finally:
            claim.unlink(missing_ok=True)
            fcntl.flock(lane_lock.fileno(), fcntl.LOCK_UN)
            lane_lock.close()
        return True
    return False


def current_express_order():
    try:
        rows = [line.strip() for line in EXPRESS_ORDER_FILE.read_text(encoding='utf-8').splitlines()
                if line.strip() and not line.lstrip().startswith('#')]
    except OSError:
        return EXPRESS_ORDER
    if any(not row.isdigit() for row in rows) or len(rows) != len(set(rows)):
        log('invalid express-order.tsv; using built-in order')
        return EXPRESS_ORDER
    return tuple(rows)


def current_op_express_order():
    """Read PRs OP explicitly authorized for express outside title-prefix matching."""
    try:
        rows = [line.split('\t', 1)[0].strip()
                for line in OP_EXPRESS_FILE.read_text(encoding='utf-8').splitlines()
                if line.strip() and not line.lstrip().startswith('#')]
    except OSError:
        return ()
    if any(not row.isdigit() for row in rows) or len(rows) != len(set(rows)):
        log('invalid op-express-prs.tsv; ignoring OP express entries')
        return ()
    return tuple(rows)


def discover_gate_regression_express(rows, order):
    """Promote registered 0.2.45 gate fixes by their explicit title prefix."""
    global EXPRESS_DISCOVERY_AT, OPEN_PR_CACHE, OPEN_PR_CACHE_AT, OPEN_PR_BASE_CACHE
    now = time.monotonic()
    if now - EXPRESS_DISCOVERY_AT < 30:
        return order
    EXPRESS_DISCOVERY_AT = now
    queue_heads = {str(row.pr): row.head.lower() for row in rows}
    try:
        result = subprocess.run(
            ['gh', 'pr', 'list', '-R', 'ElanvitalAI/elanous', '--state', 'open',
             '--limit', '1000', '--json', 'number,title,headRefOid,baseRefName'],
            capture_output=True, text=True, timeout=20)
        if result.returncode:
            log(f'gate-regression express discovery unavailable rc={result.returncode}')
            return order
        prs = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        log(f'gate-regression express discovery unavailable: {type(exc).__name__}')
        return order
    OPEN_PR_CACHE, OPEN_PR_BASE_CACHE = open_pr_snapshot(prs)
    OPEN_PR_CACHE_AT = now
    candidates = []
    for item in prs:
        pr = str(item.get('number', ''))
        title = str(item.get('title', '')).strip().lower()
        head = str(item.get('headRefOid', '')).lower()
        if pr in queue_heads and queue_heads[pr] == head and title.startswith(('gate-0245:', 'gate-0246:')):
            candidates.append(pr)
    candidates = sorted(set(candidates), key=int)
    try:
        existing_gate = [line.strip() for line in GATE_0245_FILE.read_text(encoding='utf-8').splitlines()
                         if line.strip().isdigit()]
    except OSError:
        existing_gate = []
    gate_members = candidates
    if gate_members != existing_gate:
        temp = GATE_0245_FILE.with_name(GATE_0245_FILE.name + '.tmp')
        temp.write_text(''.join(f'{pr}\n' for pr in gate_members), encoding='utf-8')
        os.replace(temp, GATE_0245_FILE)
    try:
        independent = [line.strip() for line in EXPRESS_INDEPENDENT_FILE.read_text(encoding='utf-8').splitlines()
                       if line.strip().isdigit()]
    except OSError:
        independent = []
    independent = sorted(set(independent + gate_members), key=int)
    temp = EXPRESS_INDEPENDENT_FILE.with_name(EXPRESS_INDEPENDENT_FILE.name + '.tmp')
    temp.write_text(''.join(f'{pr}\n' for pr in independent), encoding='utf-8')
    os.replace(temp, EXPRESS_INDEPENDENT_FILE)
    updated = tuple(candidates)
    if updated != order:
        temp = EXPRESS_ORDER_FILE.with_name(EXPRESS_ORDER_FILE.name + '.tmp')
        temp.write_text(''.join(f'{pr}\n' for pr in updated), encoding='utf-8')
        os.replace(temp, EXPRESS_ORDER_FILE)
        log(f'promoted registered gate-regression PRs to express front: {",".join(candidates)}')
    return updated


def open_pr_snapshot(prs):
    """Return open PR ids and their observed base refs; missing bases stay unmeasured."""
    bases = {}
    for item in prs:
        pr = str(item.get('number', ''))
        if pr:
            bases[pr] = str(item.get('baseRefName') or '')
    return set(bases), bases


def filter_open_queue_rows(rows, base):
    """Dispatch only GitHub-open PRs with a measured main base."""
    if OPEN_PR_CACHE is None or time.monotonic() - OPEN_PR_CACHE_AT >= 30:
        return None
    kept = []
    for row in rows:
        pr = str(row.pr)
        if pr not in OPEN_PR_CACHE:
            log(f'skip non-open queue PR #{row.pr} before assignment')
            continue
        base_ref = OPEN_PR_BASE_CACHE.get(pr, '')
        if base_ref != 'main':
            reason = 'pr-base-not-main' if base_ref else 'pr-base-unmeasured'
            record_candidate_exclusion(
                row, base, reason,
                'retarget the PR to main and keep it queued; train dispatch resumes after the base is observed as main')
            continue
        kept.append(row)
    return kept


def prune_closed_queue_rows(rows, protected_prs=()):
    """Remove GitHub-confirmed closed/merged queue rows and leave one durable receipt."""
    if OPEN_PR_CACHE is None or time.monotonic() - OPEN_PR_CACHE_AT >= 30:
        return rows
    protected = {str(pr) for pr in protected_prs}
    closed = {}
    for row in rows:
        pr = str(row.pr)
        if pr in OPEN_PR_CACHE or pr in protected:
            continue
        try:
            result = subprocess.run(['gh', 'pr', 'view', pr, '-R', 'ElanvitalAI/elanous',
                                     '--json', 'state,headRefOid,mergedAt'],
                                    capture_output=True, text=True, timeout=20)
            if result.returncode:
                log(f'closed queue prune unavailable #{pr} rc={result.returncode}; row retained')
                continue
            value = json.loads(result.stdout)
            state = str(value.get('state', '')).upper()
            if state not in ('CLOSED', 'MERGED'):
                log(f'closed queue prune unexpected state #{pr} state={state or "missing"}; row retained')
                continue
            closed[pr] = {'state': 'MERGED' if value.get('mergedAt') else 'CLOSED',
                          'remoteHead': str(value.get('headRefOid', '')).lower(),
                          'mergedAt': value.get('mergedAt')}
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, AttributeError, TypeError) as exc:
            log(f'closed queue prune unavailable #{pr}: {type(exc).__name__}; row retained')
    if not closed:
        return rows

    lock = Path(str(QUEUE) + '.lock')
    for _ in range(60):
        try:
            lock.mkdir()
            break
        except FileExistsError:
            time.sleep(.25)
    else:
        log('closed queue prune skipped: queue lock timeout')
        return rows
    removed = []
    try:
        lines = QUEUE.read_text(encoding='utf-8').splitlines()
        kept = []
        for line in lines:
            fields = line.split('\t')
            pr = fields[0] if fields else ''
            candidate = closed.get(pr)
            if candidate and len(fields) == 4:
                expected = next((row for row in rows if str(row.pr) == pr), None)
                if expected and fields[1] == expected.head.lower():
                    removed.append({'pr': pr, 'queuedHead': fields[1], 'state': candidate['state'],
                                    'remoteHead': candidate['remoteHead'], 'mergedAt': candidate['mergedAt']})
                    continue
                if expected:
                    log(f'closed queue prune race #{pr}: row head changed; retained')
            kept.append(line)
        if not removed:
            return read_queue()
        temporary = QUEUE.with_name(f'{QUEUE.name}.closed-prune-{os.getpid()}.tmp')
        temporary.write_text(''.join(line + '\n' for line in kept), encoding='utf-8')
        os.replace(temporary, QUEUE)
        removed_prs = {item['pr'] for item in removed}
        for path, split_at in ((ROOT / 'land-queue.front.tsv', 1), (ROOT / 'land-queue.times', 1)):
            if not path.exists():
                continue
            side_lines = path.read_text(encoding='utf-8').splitlines()
            side_kept = [line for line in side_lines
                         if not line or line.startswith('#') or line.split('\t', 1)[0] not in removed_prs]
            side_tmp = path.with_name(f'{path.name}.closed-prune-{os.getpid()}.tmp')
            side_tmp.write_text(''.join(line + '\n' for line in side_kept), encoding='utf-8')
            os.replace(side_tmp, path)
    finally:
        lock.rmdir()

    if removed:
        CLOSED_QUEUE_EVENTS.parent.mkdir(parents=True, exist_ok=True)
        with CLOSED_QUEUE_EVENTS.with_suffix('.lock').open('a', encoding='utf-8') as lock_stream:
            fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX)
            with CLOSED_QUEUE_EVENTS.open('a', encoding='utf-8') as stream:
                for item in removed:
                    event = {'schema': 'elanous.train.closed-queue-removal.v1',
                             'at': datetime.now().astimezone().isoformat(timespec='seconds'), **item}
                    stream.write(json.dumps(event, ensure_ascii=False, separators=(',', ':')) + '\n')
                stream.flush()
                os.fsync(stream.fileno())
            fcntl.flock(lock_stream.fileno(), fcntl.LOCK_UN)
        for item in removed:
            log(f'closed queue row removed #{item["pr"]} state={item["state"]} '
                f'head={item["queuedHead"][:12]} receipt={CLOSED_QUEUE_EVENTS.name}')
    return read_queue()


def current_base():
    subprocess.run(['eln', 'git', 'fetch', 'origin', 'main'], cwd=Path.home() / 'elanous-hq/seats/OP',
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
    result = subprocess.run(['git', '-C', str(Path.home() / 'elanous-hq/seats/OP'),
                             'rev-parse', 'origin/main'], capture_output=True, text=True, timeout=20)
    sha = result.stdout.strip().lower()
    return sha if result.returncode == 0 and len(sha) == 40 else ''


def lock_owner_alive(host, lock):
    """Check owner PID where the lock owner process actually runs; unknown stays locked."""
    try:
        owner = json.loads((lock / 'owner.json').read_text(encoding='utf-8'))
        pid = int(owner.get('pid', 0))
        machine = str(owner.get('machine', '')).lower()
        logical_host = str(owner.get('logicalHost', host)).strip() or host
        if pid <= 1:
            return None
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None

    local_names = {socket.gethostname().lower(), socket.gethostname().split('.')[0].lower()}
    try:
        local_names.add(subprocess.run(['hostname', '-s'], capture_output=True, text=True,
                                       timeout=2).stdout.strip().lower())
    except (OSError, subprocess.TimeoutExpired):
        pass
    if machine in local_names:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return None

    # Legacy records have no machine field. Probe the manager host first because
    # train-batch-live workers historically ran here; then check the logical host.
    if not machine:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            pass
        except PermissionError:
            return True
        except OSError:
            return None
    target = logical_host if machine in local_names or not machine else machine
    # If a runtime hostname is not an SSH alias, the registered logical host is.
    if machine and target == machine and machine not in (host.lower(), logical_host.lower()):
        target = logical_host
    try:
        probe = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', target,
                                f'kill -0 {pid} >/dev/null 2>&1'],
                               capture_output=True, text=True, timeout=7)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if probe.returncode == 0:
        return True
    if probe.returncode == 255:
        return None
    return False

def reap_dead_slot_lock(host, lock):
    if not lock.is_dir():
        return False
    alive = lock_owner_alive(host, lock)
    if alive is not False:
        return False
    # Re-read the owner immediately before rename so a replaced live lock is kept.
    try:
        owner_before = (lock / 'owner.json').read_text(encoding='utf-8')
        owner = json.loads(owner_before)
        pid = int(owner.get('pid', 0))
        started = float(owner.get('started', 0))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False
    # Let a fresh lock finish mkdir→owner.json before any stale decision.
    if pid <= 1 or time.time() - started < 5 or lock_owner_alive(host, lock) is not False:
        return False
    stale = lock.with_name(f'{lock.name}.stale-dead-owner-{datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")}-{pid}')
    try:
        lock.rename(stale)
    except OSError:
        return False
    log(f'stale dead-owner lock reaped host={host} lock={lock.name} pid={pid} renamed={stale.name}')
    return True


HOST_CAPS_TSV = MANAGER_DIR / 'host-caps.tsv'  # OP 11-05 08:0x cloud-join/leave 가 쓴다 · 매 tick 읽는다(재기동 불요)
_HOST_CAPS_SEEN = None


def effective_host_caps():
    """HOST_CAPS ⊕ host-caps.tsv(host<TAB>cap[<TAB>note]) — 파일이 없거나 줄이 이상하면 그 줄만 무시하고 dict 값을 쓴다."""
    global _HOST_CAPS_SEEN
    caps = dict(HOST_CAPS)
    try:
        lines = HOST_CAPS_TSV.read_text(encoding='utf-8').splitlines()
    except OSError:
        lines = []
    for line in lines:
        if not line.strip() or line.startswith('#'):
            continue
        fields = line.split('\t')
        if len(fields) >= 2 and fields[0] in ACTIVE_HOSTS and fields[1].strip().isdigit():
            caps[fields[0]] = int(fields[1].strip())
    if caps != _HOST_CAPS_SEEN:
        changed = {h: caps[h] for h in caps if _HOST_CAPS_SEEN is None or _HOST_CAPS_SEEN.get(h) != caps[h]}
        log(f'host-caps effective={caps} changed={changed} overlay={HOST_CAPS_TSV.name if lines else "none"}')
        _HOST_CAPS_SEEN = caps
    return caps


def worker_slots():
    hosts = {}
    for line in HOSTS.read_text(encoding='utf-8').splitlines():
        fields = line.split('\t')
        if len(fields) >= 8 and fields[7] == 'yes':
            hosts[fields[0]] = fields
    result = []
    now = datetime.now().strftime('%Y%m%d%H%M')
    caps = effective_host_caps()
    for host in ACTIVE_HOSTS:
        if host not in hosts or now >= STOP_AT[host]:
            continue
        # OP 15:1x: aws1/3 is the single permanent repair-reserved slot.
        # Other formerly reserved slots are regular capacity after the 0.2.45 cut.
        capacity = max(0, caps.get(host, 0))
        prefixes = SLOT_PREFIX.get(host, ())
        if capacity == 0 or not prefixes:
            continue
        if capacity > len(prefixes):
            log(f'host capacity exceeds run-id prefixes host={host} cap={capacity} prefixes={len(prefixes)}; clamped')
        slots = tuple(range(1, min(capacity, len(prefixes)) + 1))
        if host == 'node-b' and now >= '202611030513':
            slots = slots[:6]  # temporary seventh slot closes before the 05:30 gate-protection window
        memory_gib = int(hosts[host][8]) if len(hosts[host]) > 8 and hosts[host][8].isdigit() else None
        if memory_gib is not None:
            slots = slots[:max(memory_gib // 16, 3) if host == 'host-e-wsl' else memory_gib // 16]
        for slot in slots:
            if (host, slot) in HELD_NEW_ASSIGNMENT_SLOTS:
                continue
            suffix = '' if slot == 1 else f'.{slot}'
            lock = Path(f'{QUEUE}.batch.lock.{host}{suffix}')
            # Reap a dead owner's lock even when its worker PID has already exited.
            reap_dead_slot_lock(host, lock)
            pid_path = WORKER_DIR / f'{host}-{slot}.pid'
            try:
                pid = int(pid_path.read_text().strip())
                os.kill(pid, 0)
            except (OSError, ValueError):
                continue
            assign = ASSIGN_DIR / f'{host}-{slot}.json'
            running = ASSIGN_DIR / f'{host}-{slot}.json.running'
            if not lock.exists() and not assign.exists() and not running.exists():
                result.append({'host': host, 'slot': slot, 'pid': pid, 'lock': str(lock),
                               'expressOnly': host == 'aws1' and slot == 3})
    return result


def read_queue():
    return BATCH.read_queue(QUEUE)


def typecheck_author_holds(rows):
    """Hold the same PR head for author repair after two attributed train typecheck failures."""
    try:
        previous = json.loads(TYPECHECK_HOLDS.read_text(encoding='utf-8'))
    except (OSError, ValueError, TypeError):
        previous = {}
    holds = previous.get('prs', {}) if isinstance(previous, dict) else {}
    current = {str(row.pr): row.head.lower() for row in rows}
    runs = {}
    for event in MEMORY.events():
        key = event.get('key', {})
        pr = str(key.get('pr', ''))
        head = str(key.get('head', '')).lower()
        if (event.get('eventType') != 'batch-gate' or event.get('status') != 'failed'
                or not event.get('excludedByTypecheck') or current.get(pr) != head):
            continue
        run_id = event.get('runId') or event.get('eventId')
        runs.setdefault(pr, set()).add((key.get('base'), run_id))
    held = set()
    for pr, identities in runs.items():
        if len(identities) < TYPECHECK_HOLD_THRESHOLD:
            continue
        head = current.get(pr)
        prior = holds.get(pr, {})
        holds[pr] = {'head': head, 'count': len(identities), 'runs': sorted(run for _, run in identities),
                     'reason': 'two-or-more-same-head-typecheck-attributions', 'manual': False}
        held.add(pr)
        if prior.get('head') != head or prior.get('count', 0) < TYPECHECK_HOLD_THRESHOLD:
            row = next(row for row in rows if str(row.pr) == pr)
            owner_mail(row, f'[TRAIN typecheck] #{pr} head {head[:12]} 저자 수리 대기 · 열차 tsc-main-delta 귀속 {len(identities)}회 · strike 없음. 수정 head로 재등록하면 hold가 풀립니다.')
            log(f'typecheck author hold #{pr} head={head[:12]} count={len(identities)}')
    # Explicit repair waits are source-controlled and head-scoped, so a concurrent tick
    # cannot erase an OP-directed wait; any replacement queue head releases it.
    for pr, marker in MANUAL_TYPECHECK_REPAIR_WAITS.items():
        if current.get(pr) == marker['head']:
            holds[pr] = {'head': marker['head'], 'count': 5 if pr == '34490' else 0, 'runs': [],
                         'reason': marker['reason'], 'manual': True}
    # A new registered head releases both explicit and automatic holds.
    for pr, marker in list(holds.items()):
        if current.get(pr) != str(marker.get('head', '')).lower():
            del holds[pr]
            log(f'typecheck author hold released #{pr}: queue head changed')
            continue
        if marker.get('manual'):
            held.add(pr)
            log(f'typecheck author hold active #{pr} head={marker["head"][:12]} reason={marker.get("reason", "repair-wait")}')
    TYPECHECK_HOLDS.parent.mkdir(parents=True, exist_ok=True)
    temp = TYPECHECK_HOLDS.with_name(TYPECHECK_HOLDS.name + '.tmp')
    temp.write_text(json.dumps({'schema': 1, 'prs': holds}, indent=2) + '\n', encoding='utf-8')
    os.replace(temp, TYPECHECK_HOLDS)
    return held


def append_memory(row, base, event_type, status, **details):
    from types import SimpleNamespace
    MEMORY.append(SimpleNamespace(source='train-manager', event_type=event_type,
                                  pr=str(row.pr), head=row.head, base=base, run_id='',
                                  status=status, data=json.dumps(details, ensure_ascii=False)))


def owner_mail(row, body):
    owner = BATCH.row_owner(row, REPO)
    # Seat routing policy: MK work goes to OP; BENCH/GOALAUTH are forwarded by OPT.
    if owner == 'MK':
        owner = 'OP'
    elif owner in ('BENCH', 'GOALAUTH'):
        owner = 'OPT'
    p = BATCH.send_typecheck_owner(owner, body, REPO)
    log(f'owner notice #{row.pr} -> {owner} rc={p.returncode}')


def main_merge(row, base):
    ref = f'refs/train-manager/pr/{row.pr}'
    fetch = subprocess.run(['git', '-C', str(REPO), 'fetch', 'origin',
                            f'+refs/pull/{row.pr}/head:{ref}'], capture_output=True, text=True, timeout=90)
    if fetch.returncode:
        record_candidate_exclusion(row, base, 'pr-head-fetch-failed',
                                   'retry on next manager tick after PR head fetch recovers')
        append_memory(row, base, 'solo-check', 'unmeasured', mainMerge='pr-head-fetch-failed',
                      diagnostic=(fetch.stderr or fetch.stdout)[-1200:])
        return False
    p = subprocess.run(['git', 'merge-tree', '--write-tree', base, row.head], cwd=REPO,
                       capture_output=True, text=True, timeout=60)
    if p.returncode == 0:
        append_memory(row, base, 'main-merge', 'passed', host='manager-local')
        return True
    reason = 'main-merge-conflict' if p.returncode == 1 else 'main-merge-unmeasured'
    status = 'conflict' if p.returncode == 1 else 'unmeasured'
    diagnostics = (p.stdout or '') + '\n' + (p.stderr or '')
    files = conflict_files_from_output(diagnostics)
    if status == 'conflict':
        record_candidate_exclusion(row, base, reason, 'autopsy-queue', files)
    else:
        record_candidate_exclusion(row, base, reason,
                                   'retry main merge preflight on next tick; alert OP after 3 exclusions')
    append_memory(row, base, 'solo-check', status, mainMerge=reason,
                  diagnostic=diagnostics[-1200:], conflictFiles=files)
    return False


def seen_solo(row, base):
    rows = memory_rows(row.pr, row.head, base, 'solo-check')
    terminal = [event for event in rows if event.get('status') in ('passed', 'failed', 'precondition-unmet', 'conflict')]
    for event in reversed(terminal):
        summary_path = event.get('summary')
        if summary_path:
            try:
                summary = json.loads(Path(summary_path).read_text(encoding='utf-8'))
                receipt = summary.get('trainAlwaysRatchets')
                if (summary.get('gateProfile') == ALWAYS_RATCHET_PROFILE
                        and isinstance(receipt, dict)
                        and receipt.get('tests') == list(BATCH.TRAIN_ALWAYS_RATCHETS)
                        and receipt.get('status') in ('passed', 'failed')
                        and receipt.get('exitCode') is not None):
                    return event
            except (OSError, ValueError, TypeError):
                pass
            # An old gate receipt predates the mandatory radius-independent suite.
            continue
        if event.get('status') == 'conflict':
            return event
        return event
    # Only one unmeasured attempt per tuple. This avoids a hot retry loop; a later base/head is a new key.
    return rows[-1] if rows else None


SOLO_REUSE_MAX_DELTA_FILES = 400
_SOLO_REUSE_CACHE = {}


def reused_solo(row, base):
    """OP 11-03 22:1x - «오늘 바로»: main 이 움직일 때마다 같은 head 사전검증을 다시 돌리지 않는다.
    옛 base 에서 passed 인 사전검증이 있고 옛 base→지금 base 사이 main 변경 파일이 PR 변경 파일과 겹치지 않으면 재사용.
    묶음 단계가 통합 게이트를 다시 돌므로 안전망은 그대로다. git 이 하나라도 실패하면 None(평소대로 사전검증)."""
    key = (str(row.pr), row.head.lower(), base.lower())
    if key in _SOLO_REUSE_CACHE:
        return _SOLO_REUSE_CACHE[key]
    result = None
    try:
        prior = [event for event in MEMORY.events()
                 if event.get('eventType') == 'solo-check' and event.get('status') == 'passed'
                 and event['key'].get('pr') == str(row.pr) and event['key'].get('head') == row.head.lower()
                 and event['key'].get('base') != base.lower()]
        for event in reversed(prior):
            old = event['key']['base']
            checked = seen_solo(row, old)
            if not checked or checked.get('status') != 'passed':
                continue
            def git(*args):
                return subprocess.run(['git', '-C', str(REPO), *args], capture_output=True, text=True, timeout=60)
            if git('merge-base', '--is-ancestor', old, base).returncode != 0:
                continue
            delta = git('diff', '--name-only', old, base)
            mb = git('merge-base', old, row.head)
            if delta.returncode or mb.returncode:
                continue
            own = git('diff', '--name-only', mb.stdout.strip(), row.head)
            if own.returncode:
                continue
            delta_files = {line for line in delta.stdout.splitlines() if line}
            own_files = {line for line in own.stdout.splitlines() if line}
            if not own_files or len(delta_files) > SOLO_REUSE_MAX_DELTA_FILES:
                continue
            overlap = delta_files & own_files
            if overlap:
                log(f'solo-reuse refused #{row.pr} head={row.head[:12]} old={old[:12]} overlap={sorted(overlap)[:5]}')
                break
            log(f'solo-reuse #{row.pr} head={row.head[:12]} old={old[:12]} -> base={base[:12]} delta={len(delta_files)} own={len(own_files)}')
            result = dict(checked, reusedFromBase=old)
            break
    except Exception as error:  # 판정 실패는 평소 사전검증으로
        log(f'solo-reuse error #{row.pr}: {error}')
        result = None
    _SOLO_REUSE_CACHE[key] = result
    return result


def busy_prs():
    prs = set()
    for path in list(ASSIGN_DIR.glob('*.json')) + list(ASSIGN_DIR.glob('*.json.running')):
        try:
            data = json.loads(path.read_text())
            prs.update(str(pr) for pr in data.get('prs', []) if str(pr).isdigit())
        except Exception:
            continue
    try:
        for path in (ROOT / 'train-claims').glob('claim-*.tsv'):
            fields = path.read_text().strip().split('\t')
            if len(fields) >= 4:
                prs.update(pr for pr in fields[3].split(',') if pr.isdigit())
    except OSError:
        pass
    return prs


def rebase_pending_assignments(base, rows):
    """Queued assignments are unstarted; keep them on the live origin/main base."""
    queued_heads = {str(row.pr): row.head.lower() for row in rows}
    rebased = 0
    for path in ASSIGN_DIR.glob('*.json'):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get('base', '').lower() == base:
            continue
        heads = data.get('heads', {})
        prs = [str(pr) for pr in data.get('prs', [])]
        if not prs or set(prs) != set(heads) or any(queued_heads.get(pr) != str(heads[pr]).lower() for pr in prs):
            log(f'pending assignment stale queue membership; left untouched file={path.name}')
            continue
        data['base'] = base
        data['preflightSummary'] = ''
        temp = path.with_name(path.name + '.base-update.tmp')
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(temp, path)
        rebased += 1
        log(f'pending assignment rebased file={path.name} prs={",".join(prs)} base={base[:12]}')
    return rebased


def make_assignment(slot, stage, rows, base, all_rows, preflight_summary=''):
    global TICK_ASSIGNMENTS
    host, number = slot['host'], slot['slot']
    prefixes = SLOT_PREFIX.get(host, ())
    if not isinstance(number, int) or number < 1 or number > len(prefixes):
        raise ValueError(f'run-id prefix unavailable for host slot {host}/{number}')
    now_id = str(int(datetime.now().strftime('%H%M%S')) * 10 + number)
    run_id = f'{prefixes[number - 1]}{now_id}'
    selected = {row.pr for row in rows}
    # Exclude every row still on the canonical queue, including CLOSED/MERGED
    # entries filtered out of the manager's open-candidate set.
    all_rows = read_queue()
    data = {
        'schema': 'elanous.train.assignment.v1', 'createdAt': datetime.now().astimezone().isoformat(timespec='seconds'),
        'host': host, 'slot': number, 'workerPid': slot['pid'], 'stage': stage,
        'base': base, 'id': run_id, 'runId': run_id,
        'prs': [row.pr for row in rows], 'heads': {row.pr: row.head for row in rows},
        'exclude': [row.pr for row in all_rows if row.pr not in selected],
        'shards': SHARDS[host], 'retryHost': host,
        'preflightSummary': preflight_summary,
        'gateProfile': ALWAYS_RATCHET_PROFILE,
    }
    target = ASSIGN_DIR / f'{host}-{number}.json'
    temp = target.with_suffix('.json.tmp')
    temp.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    os.replace(temp, target)
    TICK_ASSIGNMENTS.append(data)
    log(f'assign stage={stage} host={host}/{number} prs={",".join(data["prs"])} base={base[:12]} run={run_id}')


def is_rootless_cleanup_refusal(event):
    """Detect host-side rm permission failures from the preserved remote gate log."""
    reason = str(event.get('reason', ''))
    reason_lower = reason.lower()
    if (event.get('infra') is True or 'no space left on device' in reason_lower
            or 'host-infra:' in reason_lower
            or ('podman' in reason_lower and 'overlay' in reason_lower
                and ('permission denied' in reason_lower or 'operation not permitted' in reason_lower))):
        return True

    artifacts = Path(str(event.get('artifacts') or ''))
    try:
        artifact_dir = artifacts.resolve(strict=True)
        artifact_dir.relative_to(TRAIN_ARTIFACTS.resolve(strict=True))
    except (OSError, ValueError):
        return False
    host = str(event.get('host') or '')
    names = ['remote-gate.stdout.log']
    if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', host):
        names.append(f'remote-gate-{host}.stdout.log')
    for name in names:
        path = artifact_dir / name
        try:
            with path.open('rb') as stream:
                stream.seek(max(0, path.stat().st_size - 512_000))
                tail = stream.read().decode('utf-8', errors='replace')
        except OSError:
            continue
        if re.search(r'(?im)^rm:.*(?:permission denied|operation not permitted)\s*$', tail):
            return True
    return False


def start_amg_if_idle(free_slots):
    # OP 22:20: AMG has 0 successful resolutions; conflicts go directly to Railwright.
    log('manager AMG preflight skipped; Railwright owns conflict-ladder stage 2')
    return False


def auto_park_repeated_refusals(rows, active_prs):
    """Park a queued PR/head after two distinct completed batch refusals."""
    events = []
    try:
        for line in REFUSAL_EVENTS.read_text(encoding='utf-8').splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            events.append(event)
    except OSError:
        return set()
    current = {str(row.pr): row for row in rows}
    # OP 11-04 03:37: a re-queued (unparked) head must earn two NEW refusals — events at/before
    # that head's latest park row are already adjudicated (#34885 re-parked from stale 01:4x runs).
    last_park = {}
    try:
        for line in PARKED.read_text(encoding='utf-8').splitlines():
            cols = line.split('\t')
            if len(cols) >= 3 and cols[0][:4].isdigit() and 'T' in cols[0][:11]:
                key = (cols[1].strip(), cols[2].strip().lower())
                last_park[key] = max(last_park.get(key, ''), cols[0][:16])
    except OSError:
        pass
    grouped = {}
    for event in events:
        pr, head = str(event.get('pr', '')), str(event.get('head', '')).lower()
        if pr not in current or current[pr].head.lower() != head or pr in active_prs:
            continue
        if str(event.get('at', ''))[:16] <= last_park.get((pr, head), ''):
            continue
        run_id = str(event.get('runId', ''))
        if not run_id:
            continue
        # OP 11-05 11:0x: host infrastructure refusals (disk full · setup before artifacts) are not PR strikes.
        if is_rootless_cleanup_refusal(event):
            continue
        # Aggregate gate timeouts are unmeasured infrastructure outcomes, not PR strikes.
        if 'aggregate gate setup/unmeasured' in str(event.get('reason', '')).lower():
            continue
        if 'need at least two conflict-free rows' in str(event.get('reason', '')).lower():
            # A singleton selection is a valid solo landing; this legacy floor is a train rule refusal, not a PR strike.
            continue
        grouped.setdefault((pr, head), {})[run_id] = event
    parked = set()
    park_path = TOOLS / 'train-park.py'
    try:
        namespace = {'__name__': 'train_park_auto', '__file__': str(park_path)}
        exec(compile(park_path.read_text(encoding='utf-8'), str(park_path), 'exec'), namespace)
    except Exception as exc:
        log(f'auto-park unavailable: {type(exc).__name__}: {exc}')
        return parked
    for (pr, head), by_run in grouped.items():
        if len(by_run) < 2:
            continue
        row = current[pr]
        reasons = list(by_run.values())
        latest = reasons[-1]
        reason = str(latest.get('reason') or 'same-head repeated train refusal')
        run_ids = sorted(by_run)
        # Do not turn an unattributed member of a failed bundle into an individual strike.
        # The batch-level train-park pass reruns each introduced test against candidates.
        artifacts = Path(str(latest.get('artifacts') or ''))
        try:
            manifest = json.loads((artifacts / 'manifest.json').read_text(encoding='utf-8'))
            rejections = json.loads((artifacts / 'gate-rejections.json').read_text(encoding='utf-8'))
            members = manifest.get('members') or []
            unattributed = any(
                item.get('cause') == 'introduced' and not item.get('owners')
                for item in (rejections.get('failures') or [])
                if isinstance(item, dict)
            )
        except (OSError, ValueError, TypeError, AttributeError):
            members, unattributed = [], False
        if len(members) > 1 and unattributed:
            log(f'auto-park deferred #{pr} head={head[:12]} bundle={len(members)} '
                f'runs={run_ids}: introduced owner unresolved; per-PR train-park attribution owns disposition')
            continue
        context = {'bundle_members': [pr], 'integration_head': 'unknown',
                   'failed_stage': 'train-batch-refusal', 'file_line': 'unknown'}
        try:
            owner = namespace['park'](str(QUEUE), pr, head,
                                      f'same-head refusal 2+: {reason}', ','.join(run_ids),
                                      f'실패 이름: {reason}', context)
        except Exception as exc:
            log(f'auto-park failed #{pr} head={head[:12]}: {type(exc).__name__}: {exc}')
            continue
        if owner is None:
            continue
        owner = 'OP' if owner == 'MK' else 'OPT' if owner in ('BENCH', 'GOALAUTH') else owner
        log(f'auto-parked #{pr} head={head[:12]} refusals={len(by_run)} owner={owner}; owner notice sent by train-park')
        parked.add(pr)
    return parked

def repeated_unattributed_bundle_members(rows):
    """Pin a PR/head to singleton gates after two unresolved bundle runs until attribution."""
    queued = {str(row.pr): row.head.lower() for row in rows}
    unresolved_runs = {}
    latest_unresolved = {}
    try:
        events = [json.loads(line) for line in REFUSAL_EVENTS.read_text(encoding='utf-8').splitlines()]
    except (OSError, ValueError, TypeError):
        events = []

    def event_time(value):
        try:
            return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        except (TypeError, ValueError):
            return None

    for event in events:
        run_id = str(event.get('runId', ''))
        artifacts = Path(str(event.get('artifacts') or ''))
        reason = str(event.get('reason') or '').lower()
        repeated_unmeasured = 'aggregate gate setup/unmeasured' in reason
        if not run_id or not artifacts:
            continue
        try:
            manifest = json.loads((artifacts / 'manifest.json').read_text(encoding='utf-8'))
            try:
                rejections = json.loads((artifacts / 'gate-rejections.json').read_text(encoding='utf-8'))
            except (OSError, ValueError):
                rejections = {}
            members = tuple(sorted((str(item['pr']), str(item['head']).lower())
                                   for item in manifest.get('members', [])
                                   if isinstance(item, dict) and item.get('pr') and item.get('head')))
            failures = [item for item in rejections.get('failures', []) if isinstance(item, dict)]
            unresolved = (any(item.get('cause') == 'introduced' and not item.get('owners')
                              for item in failures) or repeated_unmeasured)
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            continue
        if len(members) < 2 or not unresolved:
            continue
        at = event_time(event.get('at'))
        for pr, head in members:
            if queued.get(pr) != head:
                continue
            key = (pr, head)
            unresolved_runs.setdefault(key, {})[run_id] = at
            if at and (key not in latest_unresolved or at > latest_unresolved[key]):
                latest_unresolved[key] = at

    # A later exact-head batch-gate pass or attributed failure is the cause judgement
    # that releases the solo pin. Count only unresolved bundle runs after that event.
    adjudicated_at = {}
    for event in MEMORY.events():
        key_data = event.get('key', {})
        key = (str(key_data.get('pr', '')), str(key_data.get('head', '')).lower())
        if (event.get('eventType') != 'batch-gate' or key[0] not in queued
                or queued[key[0]] != key[1]):
            continue
        resolved = (event.get('status') == 'passed'
                    or (event.get('status') == 'failed' and event.get('excludedByGateAttribution') is True))
        at = event_time(event.get('at'))
        if resolved and at and (key not in adjudicated_at or at > adjudicated_at[key]):
            adjudicated_at[key] = at

    forced = set()
    for key, runs in unresolved_runs.items():
        resolution = adjudicated_at.get(key)
        unresolved_after = [at for at in runs.values() if at and (resolution is None or at > resolution)]
        if len(unresolved_after) >= 2 and latest_unresolved.get(key) and (
                resolution is None or latest_unresolved[key] > resolution):
            forced.add(key[0])
    return forced


def groupable_members(rows, forced_solo):
    """Return eligible bundle members in queue order, excluding PRs pinned to singleton gates."""
    return [row for row in rows if str(row.pr) not in forced_solo]


def tick():
    global TICK_ASSIGNMENTS, TICK_EXCLUSIONS
    global DOCS_ONLY_GATE_FALLBACK
    TICK_ASSIGNMENTS = []
    TICK_EXCLUSIONS = set()
    DOCS_ONLY_GATE_FALLBACK = set()
    base = current_base()
    if not base:
        log('base fetch/resolve failed; dispatch paused')
        return
    rows = read_queue()
    if not rows:
        log(f'tick base={base[:12]} queue=0 idle')  # OP 11-05 04:4x 빈 줄도 tick 을 찍는다(무로그 = 멈춤 오판)
        return
    process_amg_failures(rows, base)
    rebase_pending_assignments(base, rows)
    express_order = discover_gate_regression_express(rows, current_express_order())
    rows = prune_closed_queue_rows(rows, busy_prs())
    op_express_order = current_op_express_order()
    express_order = tuple(dict.fromkeys((*express_order, *op_express_order)))
    open_rows = filter_open_queue_rows(rows, base)
    if open_rows is None:
        log('GitHub open-state snapshot unavailable; assignment paused fail-closed')
        return
    rows = open_rows
    auto_parked = auto_park_repeated_refusals(rows, busy_prs())
    if auto_parked:
        rows = [row for row in rows if str(row.pr) not in auto_parked]
    if light_land_docs_only(rows, base):
        return
    if light_land_gate_tier_t0(rows, base):
        return
    held_typecheck = typecheck_author_holds(rows)
    if held_typecheck:
        for row in rows:
            if str(row.pr) in held_typecheck:
                record_candidate_exclusion(row, base, 'typecheck-author-hold',
                                           'author repair wait; dispatch resumes when head changes')
        rows = [row for row in rows if str(row.pr) not in held_typecheck]
        log(f'typecheck author repair holds excluded from dispatch: {sorted(held_typecheck, key=int)}')
    if not rows:
        return
    express_rank = {pr: index for index, pr in enumerate(express_order)}
    slots = worker_slots()
    active_prs = busy_prs()
    free = [slot for slot in slots]
    regular_free = [slot for slot in free if not slot.get('expressOnly')]
    # AMG disabled: conflict resolution is handled by Railwright, never as dispatch preflight.
    ready, needs_solo, cached_gate_ready = [], [], []
    must_rank = {pr: index for index, pr in enumerate(MUST_0246_ORDER)}
    ordered_rows = sorted(rows, key=lambda row: (
        0 if str(row.pr) in must_rank else 1,
        must_rank.get(str(row.pr), len(must_rank)),
        express_rank[str(row.pr)] if str(row.pr) in express_rank else len(express_rank),
        rows.index(row)))
    for row in ordered_rows:
        if str(row.pr) in EXPRESS_FORBIDDEN_HEADS and row.head.lower() == EXPRESS_FORBIDDEN_HEADS[str(row.pr)]:
            record_candidate_exclusion(row, base, 'policy-forbidden-head',
                                       'hold this exact head; dispatch only after an approved replacement head')
            continue
        if row.pr in active_prs:
            continue
        batch_history = memory_rows(row.pr, row.head, base, 'batch-gate')
        if batch_history:
            latest_gate = batch_history[-1]
            if latest_gate.get('status') == 'passed':
                summary_path, receipt_problem = passed_gate_receipt(row, base, latest_gate)
                if summary_path:
                    cached_gate_ready.append((row, summary_path))
                    continue
                record_candidate_exclusion(row, base, 'passed-gate-receipt-unusable', receipt_problem)
                needs_solo.append((row, set()))
                continue
            if latest_gate.get('status') in ('failed', 'precondition-unmet', 'conflict'):
                statuses = str(latest_gate.get('status'))
                record_candidate_exclusion(row, base, f'exact-gate-memory:{statuses}',
                                           'reuse the latest exact PR/head/base verdict; wait for a new key')
                continue
        if any(event.get('status') in ('failed', 'precondition-unmet', 'conflict') for event in batch_history):
            statuses = ','.join(sorted({str(event.get('status')) for event in batch_history
                                        if event.get('status') in ('failed', 'precondition-unmet', 'conflict')}))
            record_candidate_exclusion(row, base, f'exact-gate-memory:{statuses}',
                                       'reuse exact PR/head/base verdict; wait for a new key')
            continue
        if (str(row.pr), row.head.lower()) in DOCS_ONLY_GATE_FALLBACK:
            needs_solo.append((row, set()))
            log(f'docs-only shortcut fallback to normal gate #{row.pr} head={row.head[:12]}')
            continue
        solo = seen_solo(row, base)
        if solo is None and os.environ.get('TRAIN_SOLO_REUSE', '1') != '0':
            solo = reused_solo(row, base)  # OP 11-03 22:1x: main 이동만으로 사전검증을 다시 돌지 않는다
        if solo and solo.get('status') == 'passed':
            ready.append(row)
            continue
        if solo and solo.get('status') in ('failed', 'precondition-unmet', 'conflict'):
            prior_reason = str(solo.get('mainMerge') or '')
            if solo.get('status') == 'conflict' and prior_reason == 'main-merge-conflict':
                diagnostic = str(solo.get('diagnostic') or '')
                files = solo.get('conflictFiles') or conflict_files_from_output(diagnostic)
                record_candidate_exclusion(row, base, 'main-merge-conflict', 'autopsy-queue', files)
            else:
                record_candidate_exclusion(row, base, f'solo-check-{solo.get("status")}',
                                           'use existing solo evidence; retry only after a new head/base or repaired precondition')
            continue
        if solo and solo.get('status') == 'unmeasured' and solo.get('mainMerge'):
            record_candidate_exclusion(row, base, 'solo-unmeasured-main-merge',
                                       'retry the preflight when fetch/main state recovers; count repeats for OP triage')
            continue
        # unmeasured is attempted on a second, different worker once; thereafter wait for a new key or OP.
        if solo and solo.get('status') == 'unmeasured':
            tried = {event.get('host') for event in memory_rows(row.pr, row.head, base, 'solo-check')}
            needs_solo.append((row, tried))
        else:
            needs_solo.append((row, set()))
    # Once readiness is known, prefer exact-base solo-passed candidates within
    # each MUST/express priority tier; queue position only breaks ties.
    solo_ready_ids = {row.pr for row in ready}
    ordered_rows.sort(key=lambda row: (
        0 if str(row.pr) in must_rank else 1,
        must_rank.get(str(row.pr), len(must_rank)),
        express_rank[str(row.pr)] if str(row.pr) in express_rank else len(express_rank),
        0 if row.pr in solo_ready_ids else 1,
        rows.index(row)))
    ready.sort(key=lambda row: ordered_rows.index(row))
    assigned = set()
    forced_solo = repeated_unattributed_bundle_members(rows)
    # Reserve singleton gate assignments before any path can bundle these PRs.
    for row in ready:
        if str(row.pr) not in forced_solo:
            continue
        slot = next((candidate for candidate in free if not candidate.get('expressOnly')), None)
        if slot is None:
            break
        make_assignment(slot, 'group', [row], base, rows)
        free.remove(slot)
        assigned.add(row.pr)
        log(f'unattributed/unmeasured bundle split to solo gate #{row.pr} head={row.head[:12]} '
            f'slot={slot["host"]}/{slot["slot"]} base={base[:12]}')
    # Keep two aws1 express slots busy with the next registered express items.
    # Gate runs may overlap; land-single still enforces the shared order barrier.
    express_active = {pr for pr in active_prs if pr in express_rank}
    express_priority = set(express_rank) | URGENT_RELEASE_REPAIR_PRS
    op_express_set = set(op_express_order)
    express_candidates = {row.pr: row for row in ready
                          if str(row.pr) in express_priority
                          and (str(row.pr) not in must_rank or str(row.pr) in op_express_set)}
    express_candidates.update({row.pr: row for row, _ in needs_solo
                               if str(row.pr) in express_priority
                               and (str(row.pr) not in must_rank or str(row.pr) in op_express_set)})
    express_candidates = sorted(
        express_candidates.values(),
        key=lambda row: (0 if str(row.pr) == '34438' else 1 if str(row.pr) in express_rank else 2,
                         express_rank.get(str(row.pr), len(express_rank)), rows.index(row)))
    express_capacity = max(0, 5 - len(express_active))
    express_slots = [slot for slot in free if slot.get('expressOnly')]
    # A PR OP explicitly put in op-express-prs.tsv is a single-PR express
    # assignment, independent of MUST ordering/capacity. It must never fall
    # through into an ordinary group when all express slots are occupied.
    op_candidates = [row for row in express_candidates
                     if str(row.pr) in op_express_set and row.pr not in active_prs]
    op_first_rank = {pr: i for i, pr in enumerate(OP_EXPRESS_FIRST)}
    op_candidates.sort(key=lambda row: (0 if str(row.pr) in op_first_rank else 1,
                                        op_first_rank.get(str(row.pr), len(op_first_rank)),
                                        op_express_order.index(str(row.pr)) if str(row.pr) in op_express_order else len(op_express_order)))
    # A passed exact-key gate is already the full authorization receipt. Reuse it
    # for guarded land-single instead of excluding the PR or paying for another gate.
    for row, summary_path in cached_gate_ready:
        if row.pr in active_prs or row.pr in assigned:
            continue
        if not free:
            log(f'cached passed gate waiting for free landing slot #{row.pr}')
            break
        slot = free[0]
        make_assignment(slot, 'express', [row], base, rows, summary_path)
        free.remove(slot)
        if slot in express_slots:
            express_slots.remove(slot)
        assigned.add(row.pr)
        log(f'cached exact passed gate dispatched directly to land-single #{row.pr} '
            f'slot={slot["host"]}/{slot["slot"]} summary={summary_path}')
    for row in op_candidates:
        preferred_hosts = OP_EXPRESS_HOST_PREFER.get(str(row.pr), ())
        if preferred_hosts:
            eligible = [slot for host in preferred_hosts for slot in free
                        if slot['host'] == host and not slot.get('expressOnly')]
        else:
            eligible = [slot for slot in free if slot.get('expressOnly')]
            eligible += [slot for slot in free if not slot.get('expressOnly')]
        if not eligible:
            log(f'OP express waiting for free slot #{row.pr}')
            break
        slot = eligible[0]
        solo = seen_solo(row, base)
        if row in ready:
            make_assignment(slot, 'express', [row], base, rows,
                            str((solo or {}).get('summary') or ''))
        else:
            if not main_merge(row, base):
                continue
            make_assignment(slot, 'express', [row], base, rows)
        free.remove(slot)
        if slot in express_slots:
            express_slots.remove(slot)
        assigned.add(row.pr)
        log(f'OP single express dispatched #{row.pr} slot={slot["host"]}/{slot["slot"]}')
    # OP 12:47: these five gate fixes must share one integration base so the
    # ratchet and nightly-condense repairs are present while validating 34447/34448.
    coupled_rows = {str(row.pr): row for row in ordered_rows
                    if str(row.pr) in GATE_FIX_COUPLED_BUNDLE and str(row.pr) not in active_prs}
    coupled_ready = [coupled_rows[pr] for pr in GATE_FIX_COUPLED_BUNDLE if pr in coupled_rows]
    coupled_slot = next((slot for slot in free if slot['host'] in ('aws1', 'gcp1')), None)
    coupled_reserved_slot = None
    coupled_waiting = False
    if (GATE_FIX_COUPLED_BUNDLE and len(coupled_ready) == len(GATE_FIX_COUPLED_BUNDLE)
            and not any(str(row.pr) in forced_solo for row in coupled_ready)):
        if coupled_slot is None:
            coupled_waiting = True
            log('coupled gate-fix express bundle waiting for aws1/gcp1 slot')
        elif all(main_merge(row, base) for row in coupled_ready):
            make_assignment(coupled_slot, 'express', groupable_members(coupled_ready, forced_solo), base, rows)
            free.remove(coupled_slot)
            if coupled_slot in express_slots:
                express_slots.remove(coupled_slot)
            assigned.update(row.pr for row in coupled_ready)
            log(f'coupled gate-fix express bundle dispatched prs={",".join(str(row.pr) for row in coupled_ready)} '
                f'slot={coupled_slot["host"]}/{coupled_slot["slot"]} base={base[:12]}')
        else:
            coupled_waiting = True
            log('coupled gate-fix express bundle held: at least one member fails main-merge preflight')
    elif GATE_FIX_COUPLED_BUNDLE and any(pr in coupled_rows for pr in GATE_FIX_COUPLED_BUNDLE):
        coupled_waiting = True
        coupled_reserved_slot = coupled_slot
        missing = [pr for pr in GATE_FIX_COUPLED_BUNDLE if pr not in coupled_rows]
        log(f'coupled gate-fix express bundle waiting for inactive/open members: {",".join(missing)}')
    # OP 14:5x explicitly authorized this three-PR gate/warm-pool express group.
    for group_ids in OP_EXPRESS_GROUPS:
        group_map = {str(row.pr): row for row in ordered_rows if str(row.pr) in group_ids}
        if len(group_map) != len(group_ids) or any(pr in active_prs for pr in group_ids):
            continue
        express_slot = next((slot for host in ('aws1', 'aws2', 'minim5') for slot in free
                             if slot['host'] == host), None)
        if express_slot is None:
            log(f'OP express group waiting for aws1/aws2/minim5 slot prs={",".join(group_ids)}')
            break
        members = groupable_members([group_map[pr] for pr in group_ids], forced_solo)
        if len(members) != len(group_ids):
            log(f'OP express group held for singleton gate members prs={",".join(group_ids)}')
            break
        if not all(main_merge(row, base) for row in members):
            log(f'OP express group held by main-merge preflight prs={",".join(group_ids)}')
            break
        # Multi-PR express work must use the normal group execution path. The
        # express worker path is a single-PR preflight/land path.
        make_assignment(express_slot, 'group', members, base, rows)
        free.remove(express_slot)
        assigned.update(row.pr for row in members)
        log(f'OP priority group dispatched prs={",".join(group_ids)} '
            f'slot={express_slot["host"]}/{express_slot["slot"]} base={base[:12]}')
        break
    urgent_candidates = [row for row in express_candidates
                         if str(row.pr) not in OP_EXPRESS_HOST_PREFER
                         and str(row.pr) in URGENT_RELEASE_REPAIR_PRS
                         and str(row.pr) not in GATE_FIX_COUPLED_BUNDLE
                         and str(row.pr) not in must_rank]
    for row in urgent_candidates:
        eligible = [slot for slot in express_slots if slot is not coupled_reserved_slot]
        eligible += [slot for slot in free if slot not in express_slots and slot is not coupled_reserved_slot]
        slot = eligible[0] if eligible else None
        if slot is None:
            break
        solo = seen_solo(row, base)
        if row in ready:
            make_assignment(slot, 'express', [row], base, rows,
                            str((solo or {}).get('summary') or ''))
        else:
            if not main_merge(row, base):
                continue
            make_assignment(slot, 'express', [row], base, rows)
        free.remove(slot)
        if slot in express_slots:
            express_slots.remove(slot)
        assigned.add(row.pr)
        log(f'priority express dispatched #{row.pr} slot={slot["host"]}/{slot["slot"]}')
    urgent_waiting = any(row.pr not in assigned for row in urgent_candidates)
    if urgent_waiting:
        log(f'urgent express waiting for free slots: {",".join(str(row.pr) for row in urgent_candidates if row.pr not in assigned)}')
    else:
        nonurgent_express = [row for row in express_candidates
                             if str(row.pr) not in URGENT_RELEASE_REPAIR_PRS
                             and str(row.pr) not in GATE_FIX_COUPLED_BUNDLE
                             and (str(row.pr) not in must_rank or str(row.pr) in op_express_set)]
        nonurgent_capacity = max(0, express_capacity - len(assigned))
        nonurgent_slots = [slot for slot in express_slots
                           if slot is not coupled_reserved_slot]
        for row in nonurgent_express:
            if nonurgent_capacity <= 0:
                break
            if str(row.pr) in OP_EXPRESS_HOST_PREFER:
                preferred_hosts = OP_EXPRESS_HOST_PREFER[str(row.pr)]
                eligible = [slot for host in preferred_hosts for slot in free
                            if slot['host'] == host and not slot.get('expressOnly')
                            and slot is not coupled_reserved_slot]
            else:
                eligible = list(nonurgent_slots)
                # OP-authorized express may use another idle host when aws1/3 is busy.
                if str(row.pr) in op_express_set:
                    eligible += [slot for slot in free if not slot.get('expressOnly')
                                 and slot is not coupled_reserved_slot]
            if not eligible:
                continue
            slot = eligible[0]
            if slot in nonurgent_slots:
                nonurgent_slots.remove(slot)
                express_slots.remove(slot)
            solo = seen_solo(row, base)
            if row in ready:
                make_assignment(slot, 'express', [row], base, rows,
                                str((solo or {}).get('summary') or ''))
            else:
                if not main_merge(row, base):
                    continue
                make_assignment(slot, 'express', [row], base, rows)
            free.remove(slot); assigned.add(row.pr)
            nonurgent_capacity -= 1
            log(f'priority express dispatched #{row.pr} slot={slot["host"]}/{slot["slot"]}')
        must_pending_before_solo = any(
            str(row.pr) in must_rank and row.pr not in active_prs and row.pr not in assigned
            for row in ordered_rows)
        ready_group_waiting = (
            not urgent_waiting
            and any(not slot.get('expressOnly') and slot is not coupled_reserved_slot for slot in free)
            and any(row.pr not in active_prs and row.pr not in assigned
                    and str(row.pr) not in GATE_FIX_COUPLED_BUNDLE for row in ready))
        for row, tried in needs_solo:
            # Do not spend the newly freed regular slot on another singleton
            # preflight while passed candidates are waiting for their bundle gate.
            if ready_group_waiting:
                continue
            if (str(row.pr) in express_rank or str(row.pr) in GATE_FIX_COUPLED_BUNDLE
                    or str(row.pr) in must_rank):
                continue
            if must_pending_before_solo:
                continue
            slot = next((candidate for candidate in free if not candidate.get('expressOnly')
                         and candidate['host'] not in tried
                         and candidate is not coupled_reserved_slot), None)
            if not slot:
                continue
            if not main_merge(row, base):
                continue
            # A prior main-merge-only event is factored into the solo result; it does not consume a separate assignment.
            make_assignment(slot, 'preflight', [row], base, rows)
            free.remove(slot); assigned.add(row.pr)
    # 0.2.46 MUST PRs go straight to normal shared-base groups; the PR-specific
    # gate already attributes failures, so do not spend a slot on singleton preflight.
    must_candidates = []
    for row in ordered_rows:
        pr = str(row.pr)
        if (pr not in must_rank or pr in op_express_set or pr in forced_solo or row.pr in active_prs or row.pr in assigned
                or (pr in EXPRESS_FORBIDDEN_HEADS and row.head.lower() == EXPRESS_FORBIDDEN_HEADS[pr])):
            continue
        prior_gate = memory_rows(row.pr, row.head, base, 'batch-gate')
        if any(event.get('status') in ('passed', 'failed', 'precondition-unmet', 'conflict')
               for event in prior_gate):
            continue
        solo = seen_solo(row, base)
        if solo and solo.get('status') in ('failed', 'precondition-unmet', 'conflict'):
            continue
        if main_merge(row, base):
            must_candidates.append(row)
    # OP 14:5x: keep regular slots occupied with bounded 1–4 PR groups.
    # Explicit priority PRs lead; afterward candidates follow canonical queue order.
    for slot in [candidate for candidate in free if not candidate.get('expressOnly')]:
        if not must_candidates:
            # Fill remaining regular slots from the queue after priority members.
            fillers = []
            for row in ordered_rows:
                if len(fillers) >= 4:
                    break
                pr = str(row.pr)
                if row.pr in active_prs or row.pr in assigned or pr in must_rank or pr in op_express_set or pr in forced_solo:
                    continue
                if pr in EXPRESS_FORBIDDEN_HEADS and row.head.lower() == EXPRESS_FORBIDDEN_HEADS[pr]:
                    continue
                history = memory_rows(row.pr, row.head, base, 'batch-gate')
                if any(event.get('status') in ('passed', 'failed', 'precondition-unmet', 'conflict') for event in history):
                    continue
                solo = seen_solo(row, base)
                if solo and solo.get('status') in ('failed', 'precondition-unmet', 'conflict'):
                    continue
                if main_merge(row, base):
                    fillers.append(row)
            if not fillers:
                break
            group = fillers[:4]
            make_assignment(slot, 'group', group, base, rows)
            free.remove(slot)
            assigned.update(row.pr for row in group)
            log(f'queue-fill group dispatched prs={",".join(str(row.pr) for row in group)} '
                f'slot={slot["host"]}/{slot["slot"]} base={base[:12]}')
            continue
        group = must_candidates[:4]
        if len(group) < 4:
            companions = []
            for row in ordered_rows:
                if len(group) + len(companions) >= 4:
                    break
                pr = str(row.pr)
                if row.pr in active_prs or row.pr in assigned or row in group or pr in must_rank or pr in op_express_set or pr in forced_solo:
                    continue
                if pr in EXPRESS_FORBIDDEN_HEADS and row.head.lower() == EXPRESS_FORBIDDEN_HEADS[pr]:
                    continue
                history = memory_rows(row.pr, row.head, base, 'batch-gate')
                if any(event.get('status') in ('passed', 'failed', 'precondition-unmet', 'conflict') for event in history):
                    continue
                solo = seen_solo(row, base)
                if solo and solo.get('status') in ('failed', 'precondition-unmet', 'conflict'):
                    continue
                if main_merge(row, base):
                    companions.append(row)
            group += companions[:4 - len(group)]
        make_assignment(slot, 'group', group, base, rows)
        free.remove(slot)
        assigned.update(row.pr for row in group)
        must_candidates = [row for row in must_candidates if row.pr not in assigned]
        log(f'0.2.46 MUST group dispatched prs={",".join(str(row.pr) for row in group)} '
            f'slot={slot["host"]}/{slot["slot"]} base={base[:12]}')
    # A passed solo check for the two OP express PRs is dispatched alone, before forming ordinary bundles.
    regular_free = [slot for slot in free if not slot.get('expressOnly')
                    and slot is not coupled_reserved_slot]
    if regular_free and not urgent_waiting:
        ready = [row for row in ready if row.pr not in active_prs and row.pr not in assigned
                 and str(row.pr) not in GATE_FIX_COUPLED_BUNDLE]
        ready = [row for row in ready if str(row.pr) not in forced_solo]
        regular_free = [slot for slot in regular_free if slot in free]
        if len(ready) >= 1:
            must_ids = {row.pr for row in ready if str(row.pr) in must_rank}
            group_rows = [row for row in ready if row.pr in must_ids] if must_ids else ready
            group_rows.sort(key=lambda row: ordered_rows.index(row))
            ready_ids = {row.pr for row in group_rows}
            excluded = [row.pr for row in rows if row.pr not in ready_ids]
            plan = subprocess.run(['python3', str(BATCH_HELPER), '--dry-run', '--queue', str(QUEUE),
                                   '--repo', str(REPO), '--base', base, '--limit', '4',
                                   '--exclude', ','.join(excluded)], capture_output=True, text=True, timeout=600)
            if plan.returncode == 0:
                try:
                    selected = {str(item['pr']) for item in json.loads(plan.stdout).get('selected', [])}
                    group = groupable_members([row for row in group_rows if row.pr in selected], forced_solo)[:4]
                except Exception:
                    group = []
                if len(group) >= 1:
                    slot = regular_free[0]
                    make_assignment(slot, 'group', group, base, rows)
                    free.remove(slot)
    log(f'tick base={base[:12]} queue={len(rows)} soloReady={len(ready)} freeSlots={len(free)} activePRs={len(active_prs)}')



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--interval', type=int, default=15)
    args = parser.parse_args()
    MANAGER_DIR.mkdir(parents=True, exist_ok=True); ASSIGN_DIR.mkdir(parents=True, exist_ok=True)
    if args.once:
        tick(); return 0
    PID_FILE.write_text(f'{os.getpid()}\n')
    log(f'start pid={os.getpid()} interval={args.interval}s hosts={ACTIVE_HOSTS}')
    try:
        while True:
            try:
                tick()
            except Exception as exc:
                import traceback as _tb
                log(f'tick error: {type(exc).__name__}: {exc} @ ' + ' <- '.join(f'{fr.name}:{fr.lineno}' for fr in reversed(_tb.extract_tb(exc.__traceback__)[-4:])))
            time.sleep(max(3, args.interval))
    finally:
        if PID_FILE.exists() and PID_FILE.read_text().strip() == str(os.getpid()):
            PID_FILE.unlink()


if __name__ == '__main__':
    raise SystemExit(main())
