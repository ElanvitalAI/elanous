import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from unittest import mock


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('train_graph_node', HERE / 'graph-node.py')
node = importlib.util.module_from_spec(spec)
spec.loader.exec_module(node)
BASE = 'a' * 40


class TrainGraphNodeTest(unittest.TestCase):
    def test_remote_gate_remeasurement_helper_is_packaged_and_importable(self):
        helper = HERE / 'legacy/train-gate-remeasure.py'
        self.assertTrue(helper.is_file(), 'remote invoke_gate requires this sibling helper')
        spec = importlib.util.spec_from_file_location('train_gate_remeasure', helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for name in ('remeasure_missing', 'remeasure_timeout_only', 'remeasure_preexisting_pwa_build'):
            self.assertTrue(callable(getattr(module, name)), name)

    def test_remote_gate_helper_rejects_failed_build_and_missing_build_log(self):
        helper = HERE / 'legacy/train-gate-remeasure.py'
        with tempfile.TemporaryDirectory() as raw:
            art = Path(raw)
            (art / 'summary.json').write_text(json.dumps({'verdict': 'passed', 'exitCode': 1}))
            result = subprocess.run([sys.executable, str(helper), raw, raw, BASE, BASE],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('TRAIN_GATE_RC=1', result.stdout)
            self.assertEqual(json.loads((art / 'summary.json').read_text())['exitCode'], 1)

    def test_remote_gate_helper_exception_fails_closed(self):
        helper = HERE / 'legacy/train-gate-remeasure.py'
        with tempfile.TemporaryDirectory() as raw:
            art = Path(raw)
            (art / 'summary.json').write_text(json.dumps({
                'verdict': 'passed', 'exitCode': 0, 'shardsDetail': ['invalid-detail'],
            }))
            result = subprocess.run([sys.executable, str(helper), raw, raw, BASE, BASE],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('TRAIN_GATE_RC=1', result.stdout)
            after = json.loads((art / 'summary.json').read_text())
            self.assertEqual(after['verdict'], 'failed')
            self.assertEqual(after['exitCode'], 1)
            self.assertIn('trainRemeasurementError', after)

    def test_remote_gate_timeout_candidate_must_exist_in_rerun_junit(self):
        helper = HERE / 'legacy/train-gate-remeasure.py'
        spec = importlib.util.spec_from_file_location('train_gate_remeasure_timeout', helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        file = 'src/example.test.ts'
        candidate = file + ' > timed-out candidate'
        with tempfile.TemporaryDirectory() as raw:
            junit = Path(raw) / 'rerun.xml'
            junit.write_text('<testsuite file="src/example.test.ts"><testcase file="src/example.test.ts" name="unrelated passing test"/></testsuite>')
            summary = {'verdict': 'failed', 'introduced': 0, 'unknown': 0,
                       'verdictLine': '[gate-baseline] timed-out=1 (test): ' + candidate + '\n- flaky-timeout: ' + candidate,
                       'shardsDetail': []}
            with patch.object(module, 'run_single', return_value={
                'status': 'measured', 'rc': 0, 'junit': str(junit), 'log': str(Path(raw) / 'rerun.log'),
            }):
                self.assertTrue(module.remeasure_timeout_only(raw, raw, BASE, summary))
            self.assertEqual(summary['verdict'], 'failed')
            case = summary['trainTimeoutRemeasurement']['cases'][0]
            self.assertEqual(case['status'], 'refused')
            self.assertEqual(case['missingCandidateIds'], [candidate])

    def test_manager_rest_discovery_paginates_and_rejects_partial_snapshot(self):
        spec = importlib.util.spec_from_file_location('train_manager_rest', HERE / 'legacy/train-manager.py')
        manager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(manager)
        head = 'a' * 40
        first_page = [{'number': number, 'title': 'ordinary', 'head': {'sha': head},
                       'base': {'ref': 'main'}} for number in range(1, 101)]
        last_page = [{'number': 101, 'title': 'gate-0245: repair', 'head': {'sha': head},
                      'base': {'ref': 'main'}}]
        rows = [SimpleNamespace(pr=101, head=head)]
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            with mock.patch.object(manager, 'LOG', root / 'manager.log'), \
                    mock.patch.object(manager, 'GATE_0245_FILE', root / 'gate.tsv'), \
                    mock.patch.object(manager, 'EXPRESS_INDEPENDENT_FILE', root / 'independent.tsv'), \
                    mock.patch.object(manager, 'EXPRESS_ORDER_FILE', root / 'order.tsv'), \
                    mock.patch.object(manager.time, 'monotonic', return_value=1000):
                manager.EXPRESS_DISCOVERY_AT = 0
                manager.OPEN_PR_CACHE = None
                pages = [SimpleNamespace(returncode=0, stdout=json.dumps(page), stderr='')
                         for page in (first_page, last_page)]
                with mock.patch.object(manager.subprocess, 'run', side_effect=pages) as run:
                    self.assertEqual(manager.discover_gate_regression_express(rows, ()), ('101',))
                self.assertEqual(run.call_count, 2)
                self.assertIn('page=2', run.call_args_list[1].args[0][2])
                self.assertEqual(len(manager.OPEN_PR_CACHE), 101)
                self.assertEqual((root / 'gate.tsv').read_text(), '101\n')

                # A failed later page leaves the prior complete snapshot intact.
                manager.EXPRESS_DISCOVERY_AT = 0
                prior_cache = manager.OPEN_PR_CACHE
                failed = SimpleNamespace(returncode=1, stdout='', stderr='rate limit')
                with mock.patch.object(manager.subprocess, 'run', side_effect=[pages[0], failed]):
                    self.assertEqual(manager.discover_gate_regression_express(rows, ('101',)), ('101',))
                self.assertIs(manager.OPEN_PR_CACHE, prior_cache)

    def test_versioned_train_execution_paths_require_t2(self):
        tier = HERE / 'legacy/gate-tier.py'
        for path, expected in [('scripts/train/graph-node.py', 'T2'),
                               ('scripts/train/legacy/train-manager.py', 'T2'),
                               ('scripts/train/README.md', 'T0'),
                               ('graphs/train/train-batch.yaml', 'T2'),
                               ('graphs/train/train-manager.yaml', 'T2'),
                               ('graphs/train/README.md', 'T0')]:
            with self.subTest(path=path):
                result = subprocess.run([sys.executable, str(tier)],
                                        input=json.dumps({'changes': [{'path': path, 'additions': 1,
                                                                       'deletions': 0}]}),
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)['tier'], expected)

    def test_op_express_is_not_reassigned_as_nonurgent(self):
        manager_spec = importlib.util.spec_from_file_location('train_manager', HERE / 'legacy/train-manager.py')
        manager = importlib.util.module_from_spec(manager_spec)
        manager_spec.loader.exec_module(manager)
        op = SimpleNamespace(pr=123)
        next_row = SimpleNamespace(pr=124)
        active = {125}
        candidates = [op, next_row, SimpleNamespace(pr=125)]
        self.assertEqual([row.pr for row in manager.unassigned_express_candidates(candidates, active, set())],
                         [123, 124])
        assigned = {op.pr}  # OP express pass already used a slot.
        self.assertEqual([row.pr for row in manager.unassigned_express_candidates(candidates, active, assigned)],
                         [124])

    def test_real_tick_assigns_op_express_once_with_two_free_slots(self):
        manager_spec = importlib.util.spec_from_file_location('train_manager_tick', HERE / 'legacy/train-manager.py')
        manager = importlib.util.module_from_spec(manager_spec)
        manager_spec.loader.exec_module(manager)
        row = SimpleNamespace(pr=123, head=BASE)
        slots = [{'host': 'minim5', 'slot': 1, 'expressOnly': True},
                 {'host': 'node-c', 'slot': 1, 'expressOnly': False}]
        assignments = []
        replacements = {
            'refresh_gate_host_stop': lambda: None,
            'current_base': lambda: BASE,
            'read_queue': lambda: [row],
            'process_amg_failures': lambda *args: None,
            'rebase_pending_assignments': lambda *args: None,
            'discover_gate_regression_express': lambda rows, order: order,
            'current_express_order': lambda: (),
            'prune_closed_queue_rows': lambda rows, busy: rows,
            'busy_prs': lambda: set(),
            'current_op_express_order': lambda: ('123',),
            'filter_open_queue_rows': lambda rows, base: rows,
            'order_and_hold_hotspot_rows': lambda rows, base, order: (rows, set()),
            'auto_park_repeated_refusals': lambda rows, busy: set(),
            'light_land_docs_only': lambda rows, base: False,
            'light_land_gate_tier_t0': lambda rows, base: False,
            'typecheck_author_holds': lambda rows: set(),
            'worker_slots': lambda: slots,
            'memory_rows': lambda *args: [],
            'seen_solo': lambda row, base: {'status': 'passed', 'summary': 'passed.json'},
            'repeated_unattributed_bundle_members': lambda rows: set(),
            'make_assignment': lambda slot, stage, selected, *args: assignments.append(
                (slot['host'], stage, tuple(item.pr for item in selected))),
            'log': lambda message: None,
        }
        with ExitStack() as stack:
            for name, replacement in replacements.items():
                stack.enter_context(patch.object(manager, name, replacement))
            stack.enter_context(patch.object(manager.BATCH, 'record_rla_shadow_first_tick', return_value=None))
            stack.enter_context(patch.object(manager.BATCH, 'record_rla_shadow_hourly_summary', return_value=None))
            manager.tick()
        self.assertEqual(assignments, [('minim5', 'express', (123,))])

    def test_real_tick_op_group_requires_unassigned_eligible_members(self):
        def run_tick(op_order, failed):
            manager_spec = importlib.util.spec_from_file_location('train_manager_group', HERE / 'legacy/train-manager.py')
            manager = importlib.util.module_from_spec(manager_spec)
            manager_spec.loader.exec_module(manager)
            rows = [SimpleNamespace(pr=123, head=BASE), SimpleNamespace(pr=124, head=BASE)]
            assignments = []
            slots = [{'host': 'minim5', 'slot': 1, 'expressOnly': True},
                     {'host': 'node-c', 'slot': 1, 'expressOnly': False}]
            replacements = {
                'refresh_gate_host_stop': lambda: None,
                'current_base': lambda: BASE,
                'read_queue': lambda: rows,
                'process_amg_failures': lambda *args: None,
                'rebase_pending_assignments': lambda *args: None,
                'discover_gate_regression_express': lambda rows, order: order,
                'current_express_order': lambda: (),
                'prune_closed_queue_rows': lambda rows, busy: rows,
                'busy_prs': lambda: set(),
                'current_op_express_order': lambda: op_order,
                'filter_open_queue_rows': lambda rows, base: rows,
                'order_and_hold_hotspot_rows': lambda rows, base, order: (rows, set()),
                'auto_park_repeated_refusals': lambda rows, busy: set(),
                'light_land_docs_only': lambda rows, base: False,
                'light_land_gate_tier_t0': lambda rows, base: False,
                'typecheck_author_holds': lambda rows: set(),
                'worker_slots': lambda: slots,
                'memory_rows': lambda *args: [],
                'seen_solo': lambda row, base: {'status': 'failed' if row.pr in failed else 'passed'},
                'repeated_unattributed_bundle_members': lambda rows: set(),
                'main_merge': lambda row, base: True,
                'make_assignment': lambda slot, stage, selected, *args: assignments.append(
                    (slot['host'], stage, tuple(item.pr for item in selected))),
                'log': lambda message: None,
                'OP_EXPRESS_GROUPS': (('123', '124'),),
            }
            with ExitStack() as stack:
                for name, replacement in replacements.items():
                    stack.enter_context(patch.object(manager, name, replacement))
                stack.enter_context(patch.object(manager.BATCH, 'record_rla_shadow_first_tick', return_value=None))
                stack.enter_context(patch.object(manager.BATCH, 'record_rla_shadow_hourly_summary', return_value=None))
                manager.tick()
            return assignments

        assigned_earlier = run_tick(('123',), set())
        self.assertEqual(sum(123 in members for _, _, members in assigned_earlier), 1)
        self.assertFalse(any(stage == 'group' and members == (123, 124)
                             for _, stage, members in assigned_earlier))
        failed_member = run_tick((), {124})
        self.assertFalse(any(stage == 'group' and members == (123, 124)
                             for _, stage, members in failed_member))

    def test_batch_command_uses_repo_source_and_preserves_pinned_inputs(self):
        context = {'graphId': 'train-batch', 'nodeId': 'batch', 'input': {
            'mode': 'dry-run', 'queue': '/tmp/q', 'repo': '/tmp/repo',
            'base': BASE, 'host': 'minim5', 'exclude': '42', 'limit': 4}}
        args = node.command_for(context, HERE)
        self.assertEqual(args[1], str(HERE / 'legacy/train-batch-live.py'))
        self.assertEqual(args[2], '--dry-run')
        self.assertEqual(args[args.index('--base') + 1], BASE)
        self.assertEqual(args[args.index('--exclude') + 1], '42')

    def test_live_requires_explicit_operator_watch(self):
        context = {'graphId': 'train-batch', 'nodeId': 'batch', 'input': {
            'mode': 'live', 'queue': '/tmp/q', 'repo': '/tmp/repo', 'base': BASE}}
        with self.assertRaisesRegex(ValueError, 'op_watching'):
            node.command_for(context, HERE)

    def test_manager_refuses_unwatched_tick(self):
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / 'context.json'
            path.write_text(json.dumps({'graphId': 'train-manager', 'nodeId': 'tick', 'input': {}}))
            result = subprocess.run([sys.executable, str(HERE / 'manager-node.py')],
                                    env={**os.environ, 'ELANOUS_GRAPH_CONTEXT': str(path)},
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)['outcome'], 'fail')

    def test_versioned_manager_loads_with_host_python(self):
        result = subprocess.run([sys.executable, str(HERE / 'legacy/train-manager.py'), '--help'],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--once', result.stdout)

    def test_batch_dry_run_on_empty_isolated_queue(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = root / 'queue.tsv'
            queue.write_text('')
            context = root / 'context.json'
            context.write_text(json.dumps({'graphId': 'train-batch', 'nodeId': 'batch',
                                           'input': {'queue': str(queue), 'repo': raw, 'base': BASE}}))
            result = subprocess.run([sys.executable, str(HERE / 'graph-node.py')],
                                    env={**os.environ, 'ELANOUS_GRAPH_CONTEXT': str(context)},
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual(json.loads(result.stdout.splitlines()[-1])['outcome'], 'ok')
            self.assertIn('"selected": []', result.stdout)

    def test_batch_dry_run_selects_a_real_mergeable_queue_head(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / 'repo'
            repo.mkdir()
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            commit = ['git', '-C', str(repo), '-c', 'user.name=Train',
                      '-c', 'user.email=train@example.invalid', 'commit', '-q']
            (repo / 'base.txt').write_text('base\n')
            subprocess.run(['git', '-C', str(repo), 'add', 'base.txt'], check=True)
            subprocess.run([*commit, '-m', 'base'], check=True)
            base = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            (repo / 'feature.txt').write_text('feature\n')
            subprocess.run(['git', '-C', str(repo), 'add', 'feature.txt'], check=True)
            subprocess.run([*commit, '-m', 'feature'], check=True)
            head = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            queue = root / 'queue.tsv'
            queue.write_text(f'123\t{head}\t{repo}\tfixture\n')
            context = root / 'context.json'
            context.write_text(json.dumps({'graphId': 'train-batch', 'nodeId': 'batch',
                                           'input': {'queue': str(queue), 'repo': str(repo), 'base': base}}))
            result = subprocess.run([sys.executable, str(HERE / 'graph-node.py')],
                                    env={**os.environ, 'ELANOUS_GRAPH_CONTEXT': str(context),
                                         'TRAIN_MEMORY_PATH': str(root / 'memory.jsonl')},
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            plan = json.loads(result.stdout[:result.stdout.rfind('{"outcome"')].strip())
            self.assertEqual([row['pr'] for row in plan['selected']], ['123'])
            self.assertEqual(plan['base'], base)

            # Missing objects must fail measurement, rather than defer a PR as
            # if Git had actually proved a merge conflict.
            queue.write_text(f'123\t{"f" * 40}\t{repo}\tmissing object\n')
            result = subprocess.run([sys.executable, str(HERE / 'graph-node.py')],
                                    env={**os.environ, 'ELANOUS_GRAPH_CONTEXT': str(context),
                                         'TRAIN_MEMORY_PATH': str(root / 'memory.jsonl')},
                                    text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout.splitlines()[-1])['outcome'], 'fail')
            self.assertIn('merge-tree unmeasured #123', result.stderr)


if __name__ == '__main__':
    unittest.main()
