"""Offline regressions only: never starts a VM, TUI, server or model."""
import copy
import importlib.util
import json
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


if __name__ == '__main__':
    unittest.main()
