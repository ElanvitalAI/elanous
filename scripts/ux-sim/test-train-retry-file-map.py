#!/usr/bin/env python3
"""Replay the shared train retry fixture through the operational Python helper.

Set ELANOUS_TRAIN_BATCH_LIVE_SOURCE to a staged copy of seat-state/OPT/train-batch-live.py.
"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / 'src/ux-sim/fixtures/train-manager-decision-v1.json'
EXPECTED_SOURCE_SHA = 'c8835cbc55040ef84bcf4af7b389780b2f77d5d8aabf51c1b4f192d3dda37874'
SOURCE = os.environ.get('ELANOUS_TRAIN_BATCH_LIVE_SOURCE')
source_path = (Path(SOURCE).resolve(strict=True) if SOURCE else
               REPO / 'scripts/ux-sim/fixtures/op-snapshot-1109/train-batch-live.py')
source_sha = hashlib.sha256(source_path.read_bytes()).hexdigest()
expected_source_sha = os.environ.get('ELANOUS_TRAIN_BATCH_LIVE_SHA', EXPECTED_SOURCE_SHA)
if expected_source_sha != EXPECTED_SOURCE_SHA or source_sha != expected_source_sha:
    raise SystemExit(f'operational helper SHA mismatch: expected {EXPECTED_SOURCE_SHA}, got {source_sha}')

# The snapshot resolves these helpers from HOME at import time; provide a disposable fake home.
with tempfile.TemporaryDirectory(prefix='train-retry-file-map-') as raw_home:
    fake_home = Path(raw_home)
    tools = fake_home / 'elanous-hq/seat-state/OP/tools'
    tools.mkdir(parents=True)
    shutil.copyfile(REPO / 'scripts/ux-sim/fixtures/op-snapshot-1109/gate-tier.py', tools / 'gate-tier.py')
    shutil.copyfile(REPO / 'scripts/ux-sim/fixtures/op-snapshot-1109/gate-tier-lanes.py',
                    tools / 'gate-tier-lanes.py')
    (tools / 'train-memory.py').write_text('def exact_rows(*args, **kwargs): return []\n'
                                            'def append(*args, **kwargs): return None\n',
                                            encoding='utf-8')
    previous_home = os.environ.get('HOME')
    os.environ['HOME'] = str(fake_home)
    try:
        spec = importlib.util.spec_from_file_location('train_batch_live_retry_replay', source_path)
        if spec is None or spec.loader is None:
            raise SystemExit(f'cannot import operational train tool: {source_path}')
        train = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(train)
    finally:
        if previous_home is None:
            os.environ.pop('HOME', None)
        else:
            os.environ['HOME'] = previous_home

fixture = json.loads(FIXTURE.read_text(encoding='utf-8'))
scenario = fixture['retryFileMapIncident']
rows = [train.Row(pr, '4c9cda2cf96ff08cee2533306f50570f34906072', '/tree', '/evidence')
        for pr in scenario['members']]
retry_plan = train.plan_retry_for_batch(
    rows, scenario['primaryPrFiles'], attributed=bool(scenario['excludedPrs']),
    attributed_pr_files=None)
actual = {'retryMembers': [row.pr for row in retry_plan['rows']],
          'retryPrFiles': retry_plan['pr_files'],
          'gateRetry': 'retry' if retry_plan['stage'] == 'retry' else 'skip'}
if actual != scenario['expected']:
    raise SystemExit(f"FAIL: production transition {actual!r} != fixture {scenario['expected']!r}")

# Keep the attributed-subset plan covered through the same production entrypoint.
attributed_files = {'35964': ['src/ledger/attributed-retry.ts']}
subset_plan = train.plan_retry_for_batch(
    rows, scenario['primaryPrFiles'], attributed=True, attributed_pr_files=attributed_files)
if subset_plan != {'stage': 'retry', 'rows': rows, 'pr_files': attributed_files, 'attributed': True}:
    raise SystemExit(f'FAIL: attributed retry plan did not use its measured map: {subset_plan!r}')
print(json.dumps({'scenario': scenario['id'], 'operationalHelperSha256': source_sha, **actual,
                  'attributedRetry': {'files': subset_plan['pr_files'], 'planEntryPoint': 'plan_retry_for_batch'}}, sort_keys=True))
