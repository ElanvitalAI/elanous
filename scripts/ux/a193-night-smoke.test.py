"""Offline regressions only: never starts a VM, TUI, server or model."""
import copy
import importlib.util
import json
import os
import signal
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import sys

spec = importlib.util.spec_from_file_location('a193', Path(__file__).with_name('a193-night-smoke.py'))
a193 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a193)


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        member = root / 'member.json'
        member.write_text('{}')
        member.chmod(0o600)
        self.m = {
            'host': 'zero-a193-test', 'zero_vm': {'fresh': True}, 'timeout_seconds': 300,
            'version': '0.3.28', 'head': 'a' * 40,
            'release_verify': {'ok': True, 'version': '0.3.28', 'head': 'a' * 40,
                               'receipt_sha256': 'b' * 64, 'repository': 'ElanvitalAI/elanous'},
            'workspace': str(root), 'prefix': str(root / 'install'), 'entry': str(root / 'install/bin/eln'),
            'home': str(root / 'home'), 'config': str(root / 'config'),
            'account': {'name': 'team', 'resolved': True, 'home': '/private/team', 'account_home': '/private/team'},
            'issuer': {'head': 'a' * 40, 'owner_get_status': 200},
            'onboarding': {'official_setup_complete': True}, 'member_session_file': str(member),
            'member_expires_at': '2100-01-01T00:00:00+00:00', 'app_slug': 'bound-app', 'handle': 'test-handle',
            'owner_sha256': a193.digest(b'test-owner')}
        self.state = {'graphId': 'app-build', 'runId': 'run-current', 'status': 'failed',
                      'startedAt': '2026-11-17T01:00:00+00:00',
                      'input': {'appSlug': 'bound-app', 'context': {'memberId': 'test-owner'}},
                      'nodes': [{'nodeId': 'source-reserve', 'executed': True, 'ok': True},
                                {'nodeId': 'failed', 'executed': False, 'ok': True}]}

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, m=None, **kwargs):
        a193.preflight(m or self.m, now=a193.NOT_BEFORE + 1, hostname='zero-a193-test', **kwargs)

    def test_protected_window_reserved_hosts_and_0327_never_launch(self):
        with self.assertRaisesRegex(ValueError, 'PROTECTED_WINDOW'):
            a193.preflight(self.m, now=a193.NOT_BEFORE - 1, hostname='zero-a193-test')
        for host in ['node-b', 'aws1', 'zero-node-b', 'ordinary-laptop']:
            with self.assertRaises(ValueError):
                a193.preflight(self.m, now=a193.NOT_BEFORE + 1, hostname=host)
        m = copy.deepcopy(self.m)
        m['version'] = '0.3.27'
        with self.assertRaisesRegex(ValueError, '0328'):
            self.check(m)

    def test_normal_setup_and_installed_entry_required(self):
        self.check()
        for key, value in [('entry', '/shared/source/bin/elanous.mjs'),
                           ('onboarding', {'official_setup_complete': False})]:
            m = copy.deepcopy(self.m)
            m[key] = value
            with self.assertRaises(ValueError):
                self.check(m)

    def test_codex_home_priority_and_default_account_fail_closed(self):
        for name, home in [('default', '/private/team'), ('team', '/private/third')]:
            m = copy.deepcopy(self.m)
            m['account'].update(name=name, account_home=home)
            with self.assertRaisesRegex(ValueError, 'ACCOUNT_HOME'):
                self.check(m)

    def test_head_mismatch_and_expiring_session_fail_before_spawn(self):
        m = copy.deepcopy(self.m)
        m['issuer']['head'] = 'f' * 40
        with self.assertRaisesRegex(ValueError, 'ISSUER_HEAD'):
            self.check(m)
        m = copy.deepcopy(self.m)
        m['member_expires_at'] = '2026-11-16T09:02:00+00:00'
        with self.assertRaisesRegex(ValueError, 'SESSION_SHORTER'):
            self.check(m)

    def test_declined_tool_is_not_a_successful_graph(self):
        messages = [{'role': 'tool', 'toolName': 'app_build',
                     'toolResult': '{"error":"confirmation declined for app_build"}'}]
        self.assertEqual(a193.known_tool_failure(messages), 'graph-confirmation-declined')

    def test_bash_and_agent_tailnet_bypass_and_toolsearch_text(self):
        for name, args in [('Bash', 'tailscale serve --bg 31507'),
                           ('Agent', 'Investigate fallback deployment prerequisites')]:
            self.assertTrue(a193.deployment_bypass([{'role': 'tool', 'toolName': name, 'toolArgs': args}]))
        self.assertFalse(a193.deployment_bypass([{'role': 'tool', 'toolName': 'ToolSearch', 'toolArgs': 'Bash tailscale serve'}]))

    def test_unrelated_credential_conflict_is_a_distinct_gate(self):
        self.assertEqual(a193.known_tool_failure([{'role': 'tool', 'toolName': 'app_build_plan',
            'toolResult': '{"error":"conflicting plugin credential environment name"}'}]), 'credential-conflict')

    def test_old_run_wrong_owner_and_invented_slug_cannot_be_borrowed(self):
        started = a193.dt.datetime.fromisoformat('2026-11-17T00:59:00+00:00').timestamp()
        self.assertEqual(a193.graph_summary(self.state, self.m, started)['reached'], 'source-reserve')
        for key, value in [('appSlug', 'model-invented'), ('context', {'memberId': 'other-owner'})]:
            bad = copy.deepcopy(self.state)
            bad['input'][key] = value
            with self.assertRaisesRegex(ValueError, 'CROSS_RUN'):
                a193.graph_summary(bad, self.m, started)
        with self.assertRaisesRegex(ValueError, 'CROSS_RUN'):
            a193.graph_summary(self.state, self.m, started + 120)

    def test_publish_failure_not_url_success_and_no_secret_in_report(self):
        state = copy.deepcopy(self.state)
        state['nodes'] = [{'nodeId': n, 'executed': True, 'ok': True} for n in a193.NODES[:8]]
        # A finished verify node always carries its result (#38306 REVIEW-2 ②: a missing one waits a round).
        for node in state['nodes']:
            if node['nodeId'] == 'verify-repair':
                node['output'] = json.dumps({'result': {'passed': True}})
        state['nodes'] += [{'nodeId': 'publish-approval', 'executed': True, 'ok': False,
                           'output': 'owner approval unavailable or refused TOKEN_SECRET_KEEP_PRIVATE'},
                          {'nodeId': 'failed', 'executed': False, 'ok': True}]
        summary = a193.graph_summary(state, self.m, 0)
        self.assertEqual(summary['reached'], 'materialize')
        self.assertNotIn('TOKEN_SECRET_KEEP_PRIVATE', json.dumps(summary))
        self.assertNotIn('public_url', summary)

    def test_skipped_publish_node_and_noncontiguous_success_are_not_reached(self):
        state = copy.deepcopy(self.state)
        state['nodes'].append({'nodeId': 'publish', 'executed': False, 'ok': True})
        self.assertEqual(a193.graph_summary(state, self.m, 0)['reached'], 'source-reserve')

    def test_report_file_is_private(self):
        p = Path(self.tmp.name) / 'report.json'
        a193.private_json(p, {'status': 'unmeasured'})
        self.assertEqual(p.stat().st_mode & 0o777, 0o600)

    def test_real_pty_fixture_sends_one_prompt_one_y_and_records_failed_node(self):
        # Fake product, real PTY/process lifecycle. This is NOT a public/model E2E.
        root = Path(self.tmp.name)
        entry = Path(self.m['entry'])
        entry.parent.mkdir(parents=True)
        config = Path(self.m['config'])
        config.mkdir()
        entry.write_text(f'''#!{sys.executable}
import os, sys, json, datetime, pathlib, tty, time
if '--version' in sys.argv:
    print('0.3.28 {'a' * 40}')
    sys.exit(0)
tty.setraw(0)
os.write(1, 'Turn idle\\n❯'.encode())
line = b''
while not line.endswith(b'\\r'):
    line += os.read(0, 1)
os.write(1, b'Run app_build? (y/N)\\nRun app_build? (y/N)')
answer = os.read(0, 1)
pathlib.Path('inputs.json').write_text(json.dumps({{'prompt': line.decode().strip(), 'answer': answer.decode()}}))
state = {{'graphId': 'app-build', 'runId': 'fixture-run', 'status': 'failed',
    'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'input': {{'appSlug': 'bound-app', 'context': {{'memberId': 'test-owner'}}}},
    'nodes': [{{'nodeId': 'source-reserve', 'executed': True, 'ok': False,
        'output': 'BUILD_AUTHORITY_REFUSED'}}, {{'nodeId': 'failed', 'ok': True, 'executed': False}}]}}
p = pathlib.Path({str(config)!r}) / 'graph-runs' / 'app-build'
p.mkdir(parents=True)
(p / 'fixture-run.json').write_text(json.dumps(state))
time.sleep(60)
''')
        entry.chmod(0o700)
        manifest = root / 'manifest.json'
        manifest.write_text(json.dumps(self.m))
        with mock.patch.object(a193, 'preflight'):
            self.assertEqual(a193.run(manifest, root / 'output'), 2)
        inputs = json.loads((root / 'inputs.json').read_text())
        self.assertEqual(inputs, {'prompt': a193.PROMPT, 'answer': 'y'})
        report = json.loads((root / 'output/report.json').read_text())
        self.assertEqual(report['kind'], 'live-zero-vm')  # Fixture is marked here, outside public evidence.
        self.assertEqual(report['graph_approval_keys'], 1)
        self.assertEqual(report['status'], 'graph-failed')
        self.assertEqual(report['run']['reached'], 'graph-entered')
        self.assertIsNone(report['public_url'])
        self.assertNotIn('member-session', json.dumps(report))


    # ── SF6 (A193-NIGHT-SMOKE-SF6-FU) ──────────────────────────────────────────────────────────────────────────
    def test_product_strings_the_smoke_reacts_to_exist_in_the_product_source(self):
        repo = Path(__file__).resolve().parents[2]
        adapter = (repo / 'src/plugins/core/route-adapter.ts').read_text()
        self.assertIn('`Run ${tool.name}? (y/N)`', adapter)
        self.assertEqual(a193.APPROVAL_PROMPT, 'Run app_build? (y/N)')
        manifest = json.loads((repo / 'plugins/elanous-app-build/plugin.json').read_text())
        app_build = next(t for t in manifest['contributes']['aiTools'] if t['name'] == 'app_build')
        self.assertNotIn('confirmationPrompt', app_build)  # Otherwise the prompt text is not the template.
        self.assertIn(a193.OWNER_APPROVAL_LINK, (repo / 'src/cli/child-plugin-runtime.ts').read_text())
        status_line = (repo / 'src/tui/chat/status-line.ts').read_text()
        self.assertIn('○ idle', status_line)  # The short footer the 100-column TUI shows when ready.
        self.assertTrue(a193.READY_SIGNS.search('○ idle · repo · dev'))
        self.assertTrue(a193.READY_SIGNS.search('Turn idle · Model x'))

    def _fixture(self, body):
        entry = Path(self.m['entry'])
        entry.parent.mkdir(parents=True, exist_ok=True)
        Path(self.m['config']).mkdir(exist_ok=True)
        entry.write_text(f"""#!{sys.executable}
import os, sys, tty, time
if '--version' in sys.argv:
    print('0.3.28 {'a' * 40}')
    sys.exit(0)
tty.setraw(0)
{body}
""")
        entry.chmod(0o700)
        manifest = Path(self.tmp.name) / 'manifest.json'
        manifest.write_text(json.dumps(self.m))
        return manifest

    def test_short_idle_footer_counts_as_ready_and_pty_eof_is_a_named_end(self):
        # The product shows the short footer, takes the prompt, then closes its terminal without a graph run.
        manifest = self._fixture("""os.write(1, '○ idle · repo · dev\\n❯'.encode())
line = b''
while not line.endswith(b'\\r'):
    line += os.read(0, 1)
sys.exit(0)""")
        with mock.patch.object(a193, 'preflight'):
            self.assertEqual(a193.run(manifest, Path(self.tmp.name) / 'output'), 2)
        report = json.loads((Path(self.tmp.name) / 'output/report.json').read_text())
        self.assertEqual(report['prompt_count'], 1)
        self.assertEqual(report['regressions']['first-run'], 'pass')
        self.assertIn(report['status'], ['product-exited', 'pty-eof'])
        self.assertNotEqual(report['status'], 'running')

    def test_graph_files_mid_write_wrong_shape_or_other_binding_never_crash_the_runner(self):
        root = Path(self.m['config'])
        runs = root / 'graph-runs' / 'app-build'
        runs.mkdir(parents=True)
        started = 0.0
        (runs / 'partial.json').write_text('{"graphId": "app-build", "startedAt": "2026-11-17T01:')
        (runs / 'list.json').write_text('[1, 2]')
        (runs / 'no-start.json').write_text(json.dumps({'graphId': 'app-build', 'runId': 'x'}))
        other = copy.deepcopy(self.state)
        other['input']['context']['memberId'] = 'someone-else'
        (runs / 'other-owner.json').write_text(json.dumps(other))
        report = {'regressions': {k: 'unmeasured' for k in a193.REGRESSIONS}}
        self.assertEqual(a193.load_graphs(root, self.m, started, report), [])
        self.assertEqual(report['regressions']['cross-run-binding'], 'refused-other-binding')
        mine = copy.deepcopy(self.state)
        mine['nodes'] = [{'nodeId': 'verify-repair', 'executed': True, 'ok': True, 'output': '{"result": {"passed": tr'},
                         'not-a-node']
        (runs / 'mine.json').write_text(json.dumps(mine))
        # #38306 REVIEW-2 ②: a half-written verify output is not a pass with no detail — the state waits a round.
        self.assertEqual(a193.load_graphs(root, self.m, started, report), [])
        mine['nodes'][0]['output'] = json.dumps({'result': {'passed': True, 'files': 3, 'repairUsed': False}})
        (runs / 'mine.json').write_text(json.dumps(mine))
        graphs = a193.load_graphs(root, self.m, started, report)
        self.assertEqual(len(graphs), 1)
        self.assertEqual(graphs[0][1]['nodes'][0]['verify'], {'passed': True, 'files': 3, 'repairUsed': False})

    def test_a_state_without_its_binding_keys_yet_is_skipped_not_refused(self):
        # #38306 REVIEW-2 ①: written before input.appSlug / input.context.memberId → next round, never «other binding».
        root = Path(self.tmp.name) / 'config'
        runs = root / 'graph-runs' / 'app-build'
        runs.mkdir(parents=True)
        for name, drop in [('no-slug.json', 'appSlug'), ('no-member.json', 'memberId'), ('no-context.json', 'context')]:
            early = copy.deepcopy(self.state)
            if drop == 'memberId':
                del early['input']['context']['memberId']
            else:
                del early['input'][drop]
            (runs / name).write_text(json.dumps(early))
        no_input = copy.deepcopy(self.state)
        del no_input['input']
        (runs / 'no-input.json').write_text(json.dumps(no_input))
        report = {'regressions': {'cross-run-binding': 'unmeasured'}}
        self.assertEqual(a193.load_graphs(root, self.m, 0.0, report), [])
        self.assertNotIn('binding_refusals', report)
        self.assertEqual(report['regressions']['cross-run-binding'], 'unmeasured')
        self.assertEqual(a193.deadline_status(report), 'deadline')

    def test_a_sigterm_while_popen_runs_still_ends_the_child(self):
        # #38306 REVIEW-2 r2 ③: the signal arrives after the child exists but before Popen returns (before `child = …`).
        manifest = self._fixture("""import time
time.sleep(60)""")
        spawned = []
        real_popen = a193.subprocess.Popen
        def popen_then_sigterm(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            if '--tui' in (args[0] if args else kwargs.get('args', [])):
                spawned.append(process)
                os.kill(os.getpid(), signal.SIGTERM)  # inside Popen: the child is running, not yet assigned
            return process
        with mock.patch.object(a193, 'preflight'), mock.patch.object(a193.subprocess, 'Popen', side_effect=popen_then_sigterm):
            self.assertEqual(a193.run(manifest, Path(self.tmp.name) / 'output'), 2)
        self.assertEqual(len(spawned), 1)
        self.assertIsNotNone(spawned[0].poll())  # ended, not left running
        report = json.loads((Path(self.tmp.name) / 'output/report.json').read_text())
        self.assertEqual(report['status'], 'operator-cancelled')

    def test_states_without_nodes_or_a_verify_verdict_wait_a_round(self):
        # r2 ①②: no node list yet, or a verify result without «passed», is incomplete — never a reached graph.
        for state_nodes in [None, 'x', {'a': 1}]:
            state = copy.deepcopy(self.state)
            if state_nodes is None:
                state.pop('nodes', None)
            else:
                state['nodes'] = state_nodes
            with self.assertRaises(KeyError):
                a193.graph_summary(state, self.m, 0)
        for output in ['{"result": {}}', '{"result": {"files": 3}}', '{"result": {"passed": "yes"}}']:
            state = copy.deepcopy(self.state)
            state['nodes'] = [{'nodeId': 'verify-repair', 'executed': True, 'ok': True, 'output': output}]
            with self.assertRaises(KeyError):
                a193.graph_summary(state, self.m, 0)
        state = copy.deepcopy(self.state)
        state['nodes'] = [{'nodeId': 'verify-repair', 'executed': True, 'ok': True, 'output': '{"result": {"passed": false}}'}]
        self.assertEqual(a193.graph_summary(state, self.m, 0)['nodes'][0]['verify'], {'passed': False})

    def test_a_failed_private_names_write_still_writes_the_report(self):
        # r2 ④: the side evidence failing to write is recorded; report.json is written anyway.
        output = Path(self.tmp.name) / 'out'
        output.mkdir()
        real = a193.private_json
        def failing(path, value):
            if Path(path).name == 'binding-refusals.private.json':
                raise PermissionError(13, 'denied')
            return real(path, value)
        with mock.patch.object(a193, 'private_json', side_effect=failing):
            a193.write_final(output, {'status': 'binding-failed'}, {'039e73f18601': 'other.json'})
        report = json.loads((output / 'report.json').read_text())
        self.assertEqual(report, {'status': 'binding-failed', 'binding_refusals_private': 'write-failed:PermissionError'})
        self.assertFalse((output / 'binding-refusals.private.json').exists())

    def test_a_sigterm_right_after_the_spawn_still_ends_the_child(self):
        # #38306 REVIEW-2 ③: the interrupt lands on the first statement after Popen; the same finally ends the child.
        manifest = self._fixture("""import time
time.sleep(60)""")
        spawned = []
        real_popen = a193.subprocess.Popen
        def capture(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            if '--tui' in (args[0] if args else kwargs.get('args', [])):
                spawned.append(process)  # the product; other helpers (e.g. version reads) are not counted
            return process
        real_fdopen = a193.os.fdopen
        calls = []
        def interrupted_fdopen(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                raise KeyboardInterrupt  # what the SIGTERM handler raises
            return real_fdopen(*args, **kwargs)
        with mock.patch.object(a193, 'preflight'), mock.patch.object(a193.subprocess, 'Popen', side_effect=capture), \
                mock.patch.object(a193.os, 'fdopen', side_effect=interrupted_fdopen):
            self.assertEqual(a193.run(manifest, Path(self.tmp.name) / 'output'), 2)
        self.assertEqual(len(spawned), 1)
        self.assertIsNotNone(spawned[0].poll())  # ended, not left running
        report = json.loads((Path(self.tmp.name) / 'output/report.json').read_text())
        self.assertEqual(report['status'], 'operator-cancelled')

    def test_session_lines_are_read_incrementally_complete_lines_only_and_objects_only(self):
        sessions = Path(self.m['config']) / 'sessions'
        sessions.mkdir(parents=True)
        log = sessions / 's.jsonl'
        reader = a193.MessageReader(self.m['config'], 0)
        log.write_text('{"ts": "2026-11-17T01:00:00+00:00", "role": "tool"}\n[1]\n{"ts": "2026-11-17T01:00:01+00:')
        self.assertEqual(len(reader.read()), 1)  # The partial last line waits; the array line is skipped.
        with log.open('a') as stream:
            stream.write('00", "role": "assistant"}\n')
        self.assertEqual([m['role'] for m in reader.read()], ['tool', 'assistant'])
        self.assertEqual(len(reader.read()), 2)  # Nothing new: no duplicates.


    # ── #38306 REVIEW-1: a binding failure is its own end, with its cause — never blurred into «deadline» ─────────
    def test_refused_bindings_are_recorded_with_enum_causes_and_end_as_binding_failed(self):
        root = Path(self.m['config'])
        runs = root / 'graph-runs' / 'app-build'
        runs.mkdir(parents=True)
        other = copy.deepcopy(self.state)
        other['input']['context']['memberId'] = 'someone-else'
        other['input']['appSlug'] = 'not-ours'
        (runs / 'other.json').write_text(json.dumps(other))
        report = {'regressions': {k: 'unmeasured' for k in a193.REGRESSIONS}}
        names = {}
        self.assertEqual(a193.load_graphs(root, self.m, 0.0, report, names), [])
        a193.load_graphs(root, self.m, 0.0, report, names)  # a second round does not duplicate the row
        # The private file name never reaches the report: a short hash id there, the name only in the private map.
        self.assertEqual(report['binding_refusals'], [{'file_id': '039e73f18601', 'reasons': ['app-slug-mismatch', 'owner-mismatch']}])
        self.assertEqual(names, {'039e73f18601': 'other.json'})
        self.assertNotIn('other.json', json.dumps(report))
        self.assertNotIn('someone-else', json.dumps(report))
        self.assertEqual(a193.deadline_status(report), 'binding-failed')
        self.assertEqual(report['binding_cause'], ['app-slug-mismatch', 'owner-mismatch'])

    def test_deadline_stays_deadline_without_refusals_or_with_our_own_run(self):
        self.assertEqual(a193.deadline_status({'regressions': {}}), 'deadline')
        self.assertEqual(a193.deadline_status({'binding_refusals': [{'file_id': 'aaaaaaaaaaaa', 'reasons': ['owner-mismatch']}], 'run': {'reached': 'build'}}), 'deadline')


if __name__ == '__main__':
    unittest.main()
