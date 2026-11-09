#!/usr/bin/env python3
"""Replay train edge cases through immutable OP snapshots and isolated fake boundaries.

The replay uses the immutable 2026-11-09 OP source snapshots bundled beside
this script. Optional ELANOUS_TRAIN_<NAME>_SOURCE overrides are accepted only
when their bytes match the hard-coded SHA pins below. Python 3.10+ is required.
The runner enforces exact SHA pins before imported code executes. Missing or
changed inputs fail closed.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time


EXPECTED_SOURCE_SHA = {
    'MANAGER': '8548776d3b9c7cf46aba4fe852d70ed882c191a8fcf1bb09d7c7ec4a0bfe3d89',
    'BATCH_LIVE': 'c8835cbc55040ef84bcf4af7b389780b2f77d5d8aabf51c1b4f192d3dda37874',
    'GATE_TIER_LANES': '27e1be4b1ea2e154e5985566bfc8922b8284a5f2ad0c1de3abc4e2229c29db45',
    'GATE_TIER': '16fdf3514801b540b72eedfa122e374affe73205286c48bc5ce4a0067210263c',
}


SOURCE_FILE = {
    'MANAGER': 'train-manager.py',
    'BATCH_LIVE': 'train-batch-live.py',
    'GATE_TIER_LANES': 'gate-tier-lanes.py',
    'GATE_TIER': 'gate-tier.py',
}

def pinned_source(name):
    expected = EXPECTED_SOURCE_SHA[name]
    requested_sha = os.environ.get(f'ELANOUS_TRAIN_{name}_SHA', expected)
    if requested_sha != expected:
        raise SystemExit(f'{name} SHA pin must be {expected}')
    source = os.environ.get(f'ELANOUS_TRAIN_{name}_SOURCE')
    path = Path(source).resolve(strict=True) if source else (
        Path(__file__).parent / 'fixtures' / 'op-snapshot-1109' / SOURCE_FILE[name]
    ).resolve(strict=True)
    content = path.read_bytes()
    actual = hashlib.sha256(content).hexdigest()
    if actual != expected:
        raise SystemExit(f'{name} snapshot SHA mismatch: expected {expected}, got {actual}')
    return content, actual


manager_source, manager_sha = pinned_source('MANAGER')
batch_source, batch_sha = pinned_source('BATCH_LIVE')
lanes_source, lanes_sha = pinned_source('GATE_TIER_LANES')
gate_tier_source, gate_tier_sha = pinned_source('GATE_TIER')

observed_notifications = []

with tempfile.TemporaryDirectory(prefix='train-edge-operational-replay-') as raw:
    root = Path(raw)
    human_event_path = root / 'human-interventions.jsonl'

    def human_intervention_count():
        if not human_event_path.exists():
            return 0
        return sum(1 for line in human_event_path.read_text(encoding='utf-8').splitlines() if line)

    fake_home = root / 'home'
    op_tools = fake_home / 'elanous-hq/seat-state/OP/tools'
    opt_dir = fake_home / 'elanous-hq/seat-state/OPT'
    op_tools.mkdir(parents=True)
    opt_dir.mkdir(parents=True)
    (opt_dir / 'train-batch-live.py').write_bytes(batch_source)
    (op_tools / 'gate-tier-lanes.py').write_bytes(lanes_source)
    (op_tools / 'gate-tier.py').write_bytes(gate_tier_source)
    # train-memory is an unused imported dependency here; keep it inside the fake home.
    (op_tools / 'train-memory.py').write_text('def events():\n    return []\n', encoding='utf-8')

    manager_copy = root / 'train-manager.py'
    manager_copy.write_bytes(manager_source)
    original_home = Path.home
    original_home_env = os.environ.get('HOME')
    os.environ['HOME'] = str(fake_home)
    Path.home = classmethod(lambda cls: fake_home)
    try:
        spec = importlib.util.spec_from_file_location('train_edge_operational_manager', manager_copy)
        if spec is None or spec.loader is None:
            raise SystemExit(f'cannot import verified train-manager copy: {manager_copy}')
        manager = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = manager
        spec.loader.exec_module(manager)
    finally:
        Path.home = original_home
        if original_home_env is None:
            os.environ.pop('HOME', None)
        else:
            os.environ['HOME'] = original_home_env

    # Redirect every manager-owned write to temporary state; keep the policy functions real.
    manager.MANAGER_DIR = root / 'manager'
    manager.MANAGER_DIR.mkdir()
    manager.QUEUE = root / 'land-queue.tsv'
    manager.TOOLS = op_tools
    manager.AUTOPSY_QUEUE = root / 'autopsy-queue.tsv'
    manager.EXCLUSION_EVENTS = manager.MANAGER_DIR / 'candidate-exclusions.jsonl'
    manager.EXCLUSION_ALERTS = manager.MANAGER_DIR / 'candidate-exclusion-alerts.json'
    manager.EXCLUSION_ALERTS.write_text('{}', encoding='utf-8')
    manager.log = lambda message: None
    def fake_send_op_report(body):
        observed_notifications.append(body)
        if 'autopsy-queue' in body and 'parked-after-3-main-merge-conflicts' not in body:
            append_jsonl(human_event_path, {'kind': 'manager-escalation', 'requiresHuman': True})
    manager.send_op_report = fake_send_op_report
    manager.append_autopsy_queue = lambda *args: None

    def append_jsonl(path, event):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(event, sort_keys=True) + '\n')

    manager.append_locked_jsonl = append_jsonl

    # Invoke OPT's actual pure retry-plan entrypoint from the pinned snapshot.
    retry_row = manager.BATCH.Row('35964', 'a' * 40, '/fake/tree', '/fake/evidence')
    primary_files = {'35964': ['src/ledger/resource-ledger-tailnet-cli.ts']}
    retry_plan = manager.BATCH.plan_retry_for_batch([retry_row], primary_files, attributed=False)
    retry_result = {
        'stage': retry_plan['stage'],
        'members': [row.pr for row in retry_plan['rows']],
        'files': retry_plan['pr_files'],
        'attributed': retry_plan['attributed'],
        'humanInterventions': human_intervention_count(),
    }
    if retry_result != {
        'stage': 'retry', 'members': ['35964'], 'files': primary_files,
        'attributed': False, 'humanInterventions': 0,
    }:
        raise SystemExit(f'OPT retry plan mismatch: {retry_result!r}')

    # Use the production base filter and exclusion recorder with a deterministic PR snapshot.
    manager.OPEN_PR_CACHE = {'99021', '99022', '99023'}
    manager.OPEN_PR_BASE_CACHE = {'99021': 'release/0.3.8', '99022': 'main', '99023': ''}
    manager.OPEN_PR_CACHE_AT = time.monotonic()
    base_rows = [
        manager.BATCH.Row('99021', 'c' * 40, '/tree/21', '/evidence/21'),
        manager.BATCH.Row('99022', 'd' * 40, '/tree/22', '/evidence/22'),
        manager.BATCH.Row('99023', 'e' * 40, '/tree/23', '/evidence/23'),
        manager.BATCH.Row('99024', 'f' * 40, '/tree/24', '/evidence/24'),
    ]
    kept = manager.filter_open_queue_rows(base_rows, 'a' * 40)
    exclusion_events = [json.loads(line) for line in manager.EXCLUSION_EVENTS.read_text(encoding='utf-8').splitlines()]
    base_result = {
        'kept': [row.pr for row in kept],
        'excluded': [{'pr': event['pr'], 'reason': event['reason']} for event in exclusion_events],
        'humanInterventions': human_intervention_count(),
    }
    if base_result != {
        'kept': ['99022'],
        'excluded': [
            {'pr': '99021', 'reason': 'pr-base-not-main'},
            {'pr': '99023', 'reason': 'pr-base-unmeasured'},
        ],
        'humanInterventions': 0,
    }:
        raise SystemExit(f'production main-base filter mismatch: {base_result!r}')

    # The production exclusion counter calls this fake park executable at its normal boundary.
    manager.EXCLUSION_EVENTS = manager.MANAGER_DIR / 'park-exclusions.jsonl'
    manager.EXCLUSION_ALERTS = manager.MANAGER_DIR / 'park-alerts.json'
    manager.EXCLUSION_ALERTS.write_text('{}', encoding='utf-8')
    manager.TICK_EXCLUSIONS = set()
    manager.QUEUE.write_text(f"99031\t{'1' * 40}\t/tree\t/evidence\n", encoding='utf-8')
    park_events_path = manager.MANAGER_DIR / 'park-events.jsonl'
    park_script = op_tools / 'train-park.py'
    park_script.write_text(
        'import json\nfrom pathlib import Path\n'
        f'events = Path({str(park_events_path)!r})\n'
        'def park(queue, pr, head, reason, stage, context, meta):\n'
        '    rows = Path(queue).read_text(encoding="utf-8").splitlines() if Path(queue).exists() else []\n'
        '    if not any(row.split("\\t")[0] == pr and row.split("\\t")[1] == head for row in rows):\n'
        '        return None\n'
        '    with events.open("a", encoding="utf-8") as stream: stream.write(json.dumps({"pr": pr, "head": head, "reason": reason, "stage": stage}) + "\\n")\n'
        '    return pr\n', encoding='utf-8')
    conflict_row = manager.BATCH.Row('99031', '1' * 40, '/tree', '/evidence')
    counts = []
    park_check_counts = []
    for index in range(1, 4):
        counts.append(manager.record_candidate_exclusion(
            conflict_row, 'a' * 40, 'main-merge-conflict', 'autopsy-queue',
            ['src/loops/train/decisions.ts'], occurrence_id=f'tick-{index}'))
        current_parks = [json.loads(line) for line in park_events_path.read_text(encoding='utf-8').splitlines()] if park_events_path.exists() else []
        park_check_counts.append(len(current_parks))
    parked = [json.loads(line) for line in park_events_path.read_text(encoding='utf-8').splitlines()]
    park_result = {
        'counts': counts,
        'parkCheckCounts': park_check_counts,
        'parkedPrs': [event['pr'] for event in parked],
        'operatorNotifications': len(observed_notifications),
        'humanInterventions': human_intervention_count(),
    }
    if park_result != {
        'counts': [1, 2, 3], 'parkCheckCounts': [0, 0, 1], 'parkedPrs': ['99031'],
        'operatorNotifications': 1, 'humanInterventions': 0,
    }:
        raise SystemExit(f'production three-conflict park mismatch: {park_result!r}')

    # Inject a failed auto-park; its fake boundary emits one human intervention event.
    human_event_path.unlink(missing_ok=True)
    manager.EXCLUSION_EVENTS = manager.MANAGER_DIR / 'injected-park-exclusions.jsonl'
    manager.EXCLUSION_ALERTS = manager.MANAGER_DIR / 'injected-park-alerts.json'
    manager.EXCLUSION_ALERTS.write_text('{}', encoding='utf-8')
    manager.TICK_EXCLUSIONS = set()
    manager.QUEUE = root / 'missing-queue.tsv'
    injected_row = manager.BATCH.Row('99032', '2' * 40, '/tree', '/evidence')
    injected_counts = [manager.record_candidate_exclusion(
        injected_row, 'a' * 40, 'main-merge-conflict', 'autopsy-queue',
        ['src/loops/train/decisions.ts'], occurrence_id=f'injected-{index}')
        for index in range(1, 4)]
    injected_events = [json.loads(line) for line in human_event_path.read_text(encoding='utf-8').splitlines()]
    injected_result = {
        'counts': injected_counts,
        'events': injected_events,
        'humanInterventions': human_intervention_count(),
    }
    if injected_result != {
        'counts': [1, 2, 3],
        'events': [{'kind': 'manager-escalation', 'requiresHuman': True}],
        'humanInterventions': 1,
    }:
        raise SystemExit(f'injected human-intervention boundary did not increment: {injected_result!r}')

    # Compare zero and positive capacity using the same fake host and worker state.
    human_event_path.unlink(missing_ok=True)
    manager.ACTIVE_HOSTS = ('mshq',)
    manager.HOSTS = root / 'train-hosts.tsv'
    manager.HOSTS.write_text('mshq\tssh\t1\t1\tarm64\t0\t0\tyes\n', encoding='utf-8')
    manager.STOP_AT = {'mshq': '999912312359'}
    manager.HOST_CAPS = {'mshq': 0}
    manager.HOST_CAPS_TSV = root / 'host-caps.tsv'
    manager._HOST_CAPS_SEEN = None
    manager.SLOT_PREFIX = {'mshq': (3,)}
    manager.WORKER_DIR = root / 'workers'
    manager.ASSIGN_DIR = root / 'assignments'
    manager.WORKER_DIR.mkdir()
    manager.ASSIGN_DIR.mkdir()
    manager.QUEUE = root / 'slot-queue.tsv'
    manager.QUEUE.write_text('', encoding='utf-8')
    (manager.WORKER_DIR / 'mshq-1.pid').write_text(f'{os.getpid()}\n', encoding='utf-8')
    zero_slots = manager.worker_slots()
    cap_zero_result = {'slots': len(zero_slots), 'humanInterventions': human_intervention_count()}
    if cap_zero_result != {'slots': 0, 'humanInterventions': 0}:
        raise SystemExit(f'production cap-zero selection mismatch: {cap_zero_result!r}')
    manager.HOST_CAPS = {'mshq': 1}
    manager._HOST_CAPS_SEEN = None
    positive_slots = manager.worker_slots()
    positive_cap_result = {'slots': len(positive_slots), 'humanInterventions': human_intervention_count()}
    if positive_cap_result != {'slots': 1, 'humanInterventions': 0}:
        raise SystemExit(f'production positive-cap control mismatch: {positive_cap_result!r}')


    # Run the pinned production run_live callsite with all remote effects replaced.
    from types import SimpleNamespace
    live_home = root / 'live-home'
    live_tools = live_home / 'elanous-hq/seat-state/OP/tools'
    live_tools.mkdir(parents=True)
    (live_tools / 'gate-tier.py').write_bytes(gate_tier_source)
    (live_tools / 'gate-tier-lanes.py').write_bytes(lanes_source)
    (live_tools / 'train-memory.py').write_text(
        'def exact_rows(*args, **kwargs): return []\n'
        'def append(*args, **kwargs): return None\n', encoding='utf-8')
    (live_home / 'elanous-hq/seat-state/OP/train-hosts.tsv').write_text(
        'node-c\tssh\t1\t1\tarm64\t0\t0\tyes\n', encoding='utf-8')
    live_source = root / 'train-batch-live.py'
    live_source.write_bytes(batch_source)
    (root / 'train-gate-remeasure.py').write_text('# fake transfer input\n', encoding='utf-8')
    previous_home_env = os.environ.get('HOME')
    original_path_home = Path.home
    os.environ['HOME'] = str(live_home)
    Path.home = classmethod(lambda cls: live_home)
    try:
        live_spec = importlib.util.spec_from_file_location('train_edge_live_callsite', live_source)
        if live_spec is None or live_spec.loader is None:
            raise SystemExit('cannot load pinned train-batch-live snapshot')
        live = importlib.util.module_from_spec(live_spec)
        sys.modules[live_spec.name] = live
        live_spec.loader.exec_module(live)
    finally:
        Path.home = original_path_home
        if previous_home_env is None:
            os.environ.pop('HOME', None)
        else:
            os.environ['HOME'] = previous_home_env

    class RetryGateReached(Exception):
        pass

    live_queue = root / 'live-queue.tsv'
    live_queue.write_text('35964\t' + 'a' * 40 + '\t/tree\t/evidence\n', encoding='utf-8')
    live_repo = root / 'live-repo'
    live_repo.mkdir()
    land_single = root / 'land-single.sh'
    land_single.write_text('# never executed\n', encoding='utf-8')
    live_artifacts = root / 'live-artifacts'
    live_row = live.Row('35964', 'a' * 40, '/tree', '/evidence')
    live_files = {'35964': ['src/ledger/resource-ledger-tailnet-cli.ts']}
    gate_calls = []
    integration = 'c' * 40
    artifact = {'host': 'node-c', 'head': integration, 'bundle': '/fake/integration.bundle',
                'worktree': '/fake/integration-worktree'}
    original_gate_failed = live.gate_failed_introduced

    live.log = lambda message: None
    live.live_gate_hosts = lambda: ('node-c',)
    live.resolve_retry_host = lambda host, retry_host: 'node-c'
    live.wait_queue_lock_clear = lambda *args, **kwargs: None
    live.acquire = lambda *args, **kwargs: (root / 'fake-lock', {})
    live.acquire_claim_selection_lock = lambda *args, **kwargs: root / 'fake-selection-lock'
    live.release_claim_selection_lock = lambda *args, **kwargs: None
    live.reserve_claims_for_live_batch = lambda *args, **kwargs: (set(), None)
    live.release_acquired_lock = lambda *args, **kwargs: None
    live.release_direct_claim = lambda *args, **kwargs: None
    live.read_queue = lambda path: [live_row]
    live.memory_skip_set = lambda *args, **kwargs: set()
    live.merge_conflicts = lambda *args, **kwargs: []
    live.select = lambda rows, conflicts, limit: (list(rows), [])
    def fake_command(command, *positional, **kwargs):
        if isinstance(command, list) and command[:3] == ['ssh', '-o', 'ConnectTimeout=10']:
            return SimpleNamespace(returncode=0, stdout='/fake/home\n', stderr='')
        return SimpleNamespace(returncode=0, stdout='', stderr='')
    live.command = fake_command
    live.remote_merge_conflicts = lambda *args, **kwargs: {'conflicts': [], 'head_mismatches': {}}
    live.changed_files_by_pr = lambda *args, **kwargs: dict(live_files)
    live.integrate_rows_remote = lambda *args, **kwargs: artifact
    live.regenerate_integrated_tree_once = lambda args, queue, repo, rows, pr_files, artifact, *rest: (
        artifact, artifact['head'], rows, pr_files, False)
    live.chosen_still_queued = lambda *args, **kwargs: True
    live.cleanup_remote_bundle_copies = lambda *args, **kwargs: None
    live.cleanup_remote_integrations = lambda *args, **kwargs: None
    live.typecheck_retry_plan = lambda rows, summary: (list(rows), [], False)
    live.gate_failure_file_attribution = lambda *args, **kwargs: ([], [])
    def classify_for_retry(repo, base, rows, pr_files):
        gate_calls.append({'members': [str(row.pr) for row in rows], 'files': pr_files})
        if len(gate_calls) == 1:
            return 'T0', [{'pr': '35964', 'tier': 'T0', 'rules': ['simulation']}]
        raise RetryGateReached('actual run_live retry invoke_gate reached')
    live.classify_batch_gate = classify_for_retry

    def fake_preserve(host, remote_art, summary_path, artifacts_dir):
        preserved = Path(artifacts_dir) / ('preserved-' + Path(summary_path).stem)
        preserved.mkdir(parents=True, exist_ok=True)
        summary_data = {
            'verdict': 'failed', 'exitCode': 1,
            'typecheck': {'status': 'passed', 'base40': 'a' * 40, 'head40': integration},
            'trainAlwaysRatchets': {'status': 'passed'},
        }
        (preserved / 'summary.json').write_text(json.dumps(summary_data), encoding='utf-8')
        Path(summary_path).write_text(json.dumps(summary_data), encoding='utf-8')
        return preserved
    live.preserve_remote_artifacts = fake_preserve
    def fake_gate_subprocess(command, **kwargs):
        output = kwargs['stdout']
        output.write('BATCH_HEAD=' + integration + '\nGATE_RC=1\n')
        output.flush()
        return SimpleNamespace(returncode=0)
    original_subprocess_run = live.subprocess.run
    live.subprocess.run = fake_gate_subprocess
    original_build_gate = live.build_remote_gate_command
    live.build_remote_gate_command = lambda *args, **kwargs: 'fake-gate-command'
    args = SimpleNamespace(
        op_watching=True, authorize='35964', host='node-c', retry_host='node-c',
        land_single=land_single, run_id='99090', side_main='a' * 40, base='a' * 40,
        queue=live_queue, repo=live_repo, artifacts=live_artifacts, exclude='', limit=1,
        allow_preflight_overlap=False, preflight_only=False, lock='', gate_timeout=10,
        land_timeout=10, shards=1,
    )
    try:
        try:
            live.run_live(args)
        except RetryGateReached:
            pass
        else:
            raise SystemExit('actual run_live did not reach the injected retry gate')
    finally:
        live.subprocess.run = original_subprocess_run
        live.build_remote_gate_command = original_build_gate
    primary_failed = original_gate_failed(live_artifacts / 'summary.json')
    if len(gate_calls) != 2 or not primary_failed:
        raise SystemExit('actual run_live retry callsite not reached after forced primary failure')
    if gate_calls[0]['files'] != live_files or gate_calls[1]['files'] != live_files:
        raise SystemExit('actual run_live retry did not preserve the primary file map')
    callsite_retry_result = {
        'primary': {'verdict': 'failed', 'introducedFailureDetected': primary_failed},
        'retry': gate_calls[1],
        'forcedGateFailure': True,
    }

result = {
    'sources': {
        'trainManagerSha256': manager_sha,
        'trainBatchLiveSha256': batch_sha,
        'gateTierLanesSha256': lanes_sha,
        'gateTierSha256': gate_tier_sha,
    },
    'retryPlan': retry_result,
    'mainBaseFilter': base_result,
    'threeConflictPark': park_result,
    'injectedIntervention': injected_result,
    'capZero': cap_zero_result,
    'positiveCap': positive_cap_result,
    'runLiveRetryCallsite': callsite_retry_result,
}
print(json.dumps(result, sort_keys=True))
