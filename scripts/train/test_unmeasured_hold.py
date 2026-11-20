"""OP #113991: a gate run that ends without a verdict is logged explicitly and not re-assigned hourly."""
import importlib.util
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
BASE = 'a' * 40
HEAD = '6' * 40


def load_manager():
    spec = importlib.util.spec_from_file_location('train_manager_unmeasured', HERE / 'legacy/train-manager.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def refusal(root, run_id, host, base, gate_rc='124', elapsed=1826):
    art = root / f'batch-{host}-{run_id}'
    art.mkdir()
    if gate_rc:
        (art / 'remote-gate.stdout.log').write_text(f'BATCH_HEAD={BASE}\nGATE_RC={gate_rc}\n')
    return {'pr': '38980', 'head': HEAD, 'base': base, 'runId': run_id, 'host': host, 'at': '2026-11-20T21:35:03+09:00',
            'artifacts': str(art),
            'reason': f'aggregate gate setup/unmeasured rc=1 on {host}; remote gate.log tail: elapsed {elapsed}s'}


class UnmeasuredHoldTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.manager = load_manager()
        self.manager.UNMEASURED_LOGGED_RUNS.clear()
        self.lines = []
        self.manager.REFUSAL_EVENTS = self.root / 'refusal-events.jsonl'
        self.manager.LOG = self.root / 'train-manager.log'

    def write_events(self, *events):
        self.manager.REFUSAL_EVENTS.write_text(''.join(json.dumps(event) + '\n' for event in events))

    def test_run_without_verdict_gets_an_explicit_log_line_once(self):
        self.write_events(refusal(self.root, '111', 'gcp1', BASE), refusal(self.root, '222', 'node-c', BASE, gate_rc=''))
        with patch.object(self.manager, 'log', self.lines.append):
            self.assertEqual(self.manager.log_unmeasured_refusals(), 2)
            self.assertEqual(self.manager.log_unmeasured_refusals(), 0)
        self.assertEqual(len(self.lines), 2)
        self.assertIn('preflight no-result run=111 pr=#38980 host=gcp1 cause=gate-timeout gateRc=124 elapsed=1826s', self.lines[0])
        self.assertIn('run=222 pr=#38980 host=node-c cause=no-result gateRc=- elapsed=1826s', self.lines[1])
        self.assertIn('disposition=unmeasured-infra strikes=0', self.lines[1])

    def test_line_already_in_log_is_not_repeated_after_restart(self):
        self.write_events(refusal(self.root, '111', 'gcp1', BASE))
        self.manager.LOG.write_text('11-20 21:35:03 [train-manager] preflight no-result run=111 pr=#1 host=x\n')
        with patch.object(self.manager, 'log', self.lines.append):
            self.assertEqual(self.manager.log_unmeasured_refusals(), 0)
        self.assertEqual(self.lines, [])

    def tick_assignments(self, rows_events, must=()):
        manager = self.manager
        self.write_events(*rows_events)
        row = SimpleNamespace(pr='38980', head=HEAD)
        assignments, exclusions = [], []
        replacements = {
            'refresh_gate_host_stop': lambda: None, 'current_base': lambda: 'b' * 40, 'read_queue': lambda: [row],
            'process_amg_failures': lambda *a: None, 'rebase_pending_assignments': lambda *a: None,
            'discover_gate_regression_express': lambda rows, order: order, 'current_express_order': lambda: (),
            'prune_closed_queue_rows': lambda rows, busy: rows, 'busy_prs': lambda: set(),
            'current_op_express_order': lambda: (), 'filter_open_queue_rows': lambda rows, base: rows,
            'order_and_hold_hotspot_rows': lambda rows, base, order: (rows, set()),
            'auto_park_repeated_refusals': lambda rows, busy: set(),
            'light_land_docs_only': lambda rows, base: False, 'light_land_gate_tier_t0': lambda rows, base: False,
            'typecheck_author_holds': lambda rows: set(),
            'worker_slots': lambda: [{'host': 'node-c', 'slot': 1, 'expressOnly': False, 'pid': 1}],
            'memory_rows': lambda *a: [], 'seen_solo': lambda row, base: None, 'reused_solo': lambda row, base: None,
            'main_merge': lambda row, base: True,
            'repeated_unattributed_bundle_members': lambda rows: set(),
            'record_candidate_exclusion': lambda row, base, reason, action, *a: exclusions.append(reason),
            'make_assignment': lambda slot, stage, selected, *a: assignments.append((slot['host'], stage)),
            'log': lambda message: None,
        }
        with ExitStack() as stack:
            for name, replacement in replacements.items():
                stack.enter_context(patch.object(manager, name, replacement))
            if must:
                stack.enter_context(patch.object(manager, 'MUST_0246_ORDER', tuple(must)))
            stack.enter_context(patch.object(manager.BATCH, 'record_rla_shadow_first_tick', return_value=None))
            stack.enter_context(patch.object(manager.BATCH, 'record_rla_shadow_hourly_summary', return_value=None))
            manager.tick()
        return assignments, exclusions

    def test_one_unmeasured_run_still_gets_a_second_host(self):
        assignments, exclusions = self.tick_assignments([refusal(self.root, '111', 'gcp1', 'c' * 40)])
        self.assertEqual(assignments, [('node-c', 'preflight')])
        self.assertEqual(exclusions, [])

    def test_two_unmeasured_runs_on_older_bases_stop_hourly_reassignment(self):
        assignments, exclusions = self.tick_assignments([
            refusal(self.root, '111', 'gcp1', 'c' * 40), refusal(self.root, '222', 'node-c', 'd' * 40)])
        self.assertEqual(assignments, [])
        self.assertEqual(exclusions, ['unmeasured-infra-hold'])

    def test_two_unmeasured_runs_on_the_same_host_are_not_pr_specific(self):
        assignments, exclusions = self.tick_assignments([
            refusal(self.root, '111', 'gcp1', 'c' * 40), refusal(self.root, '222', 'gcp1', 'd' * 40)])
        self.assertNotIn('unmeasured-infra-hold', exclusions)
        self.assertEqual(assignments, [('node-c', 'preflight')])

    def test_must_pr_is_never_held_and_assigned_at_once(self):
        assignments, exclusions = self.tick_assignments([
            refusal(self.root, '111', 'gcp1', 'c' * 40), refusal(self.root, '222', 'node-c', 'd' * 40)],
            must=('38980',))
        self.assertNotIn('unmeasured-infra-hold', exclusions)
        self.assertEqual(assignments, [('node-c', 'group')])


if __name__ == '__main__':
    unittest.main()
