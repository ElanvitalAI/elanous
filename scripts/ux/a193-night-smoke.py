#!/usr/bin/env python3
"""A193: one natural-language turn on an owner-prepared, disposable zero VM.

No provisioning, installation, server configuration, credential edits or deployment
fallbacks. Private PTY/session evidence stays private; report.json is allowlisted.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import urllib.request

PROMPT = '콘서트 티케팅 시스템을 만들어서 가상 데이터로 채워 넣고 배포해줘'
NODES = ['source-reserve', 'grounding', 'assumptions', 'architecture', 'file-plan',
         'files', 'verify-repair', 'materialize', 'publish-approval', 'publish']
REGRESSIONS = ['idle-heartbeat', 'first-run', 'normal-installed-entry',
               'account-home', 'confirmation-and-no-bypass', 'natural-route',
               'plugin-credential-isolation', 'client-issuer-head', 'owner-publish-resume',
               'cross-run-binding']
# Product strings this smoke reacts to (SF6: checked against the product source by the test file).
#   ready: the idle footer — the old sentence «Turn idle» (≥120 columns), the short form «○ idle» (the 100-column TUI
#   this smoke opens), or the Korean «턴 대기» of older builds.
READY_SIGNS = re.compile(r'Turn idle|턴 대기|○ idle')
#   route-adapter.ts: `Run ${tool.name}? (y/N)` (app_build declares no confirmationPrompt of its own).
APPROVAL_PROMPT = 'Run app_build? (y/N)'
#   child-plugin-runtime.ts: the owner browser-approval link line.
OWNER_APPROVAL_LINK = '회원 게시 승인 링크'
# 출처: SF6 — a heartbeat report every 2 s is enough for a watcher and avoids rewriting it four times a second.
REPORT_EVERY_SECONDS = 2.0
NOT_BEFORE = dt.datetime.fromisoformat('2026-11-16T18:00:00+09:00').timestamp()
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    temporary.replace(path)


def inside(path, root):
    return Path(path).resolve().is_relative_to(Path(root).resolve())


def preflight(m, now=None, hostname=None):
    """Validate preparation receipts; these are provenance inputs, not grants."""
    now = time.time() if now is None else now
    hostname = platform.node() if hostname is None else hostname
    if now < NOT_BEFORE:
        raise ValueError('BEFORE_PROTECTED_WINDOW_END')
    if type(m.get('timeout_seconds')) is not int or not 30 <= m['timeout_seconds'] <= 3600:
        raise ValueError('BOUNDED_RUN_BUDGET_REQUIRED')
    if not hostname.startswith('zero-') or any(x in hostname for x in ['aws1', 'node-b']):
        raise ValueError('DEDICATED_ZERO_VM_REQUIRED')
    if m.get('host') != hostname or m.get('zero_vm', {}).get('fresh') is not True:
        raise ValueError('FRESH_VM_RECEIPT_REQUIRED')
    version = m.get('version', '')
    if not re.fullmatch(r'0\.3\.(?:2[89]|[3-9][0-9])', version):
        raise ValueError('ONLY_0328_OR_LATER_03_RELEASE')
    if not re.fullmatch(r'[0-9a-f]{40}', m.get('head', '')):
        raise ValueError('PUBLIC_HEAD_REQUIRED')
    release = m.get('release_verify', {})
    if (release.get('ok') is not True or release.get('version') != version
            or release.get('head') != m['head']
            or not re.fullmatch(r'[0-9a-f]{64}', release.get('receipt_sha256', ''))
            or release.get('repository') != 'ElanvitalAI/elanous'):
        raise ValueError('PUBLIC_VERIFY_RECEIPT_REQUIRED')
    for key in ['entry', 'prefix', 'config', 'home']:
        if not inside(m[key], m['workspace']):
            raise ValueError('PATH_OUTSIDE_DISPOSABLE_WORKSPACE')
    if not inside(m['entry'], m['prefix']):
        raise ValueError('INSTALLED_ENTRY_REQUIRED')
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?', m['app_slug']):
        raise ValueError('MEMBER_BOUND_APP_SLUG_REQUIRED')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', m['handle']):
        raise ValueError('TEST_HANDLE_REQUIRED')
    if not re.fullmatch(r'[0-9a-f]{64}', m.get('owner_sha256', '')):
        raise ValueError('OWNER_RECEIPT_REQUIRED')
    # Store names and paths only. Do not load or copy the account's auth file.
    account = m.get('account', {})
    if (account.get('name') in [None, '', 'default'] or account.get('resolved') is not True
            or account.get('home') != account.get('account_home')):
        raise ValueError('RESOLVED_ACCOUNT_HOME_REQUIRED')
    issuer = m.get('issuer', {})
    if issuer.get('head') != m['head'] or issuer.get('owner_get_status') != 200:
        raise ValueError('ISSUER_HEAD_OR_OWNER_MISMATCH')
    if m.get('onboarding', {}).get('official_setup_complete') is not True:
        raise ValueError('OFFICIAL_SETUP_REQUIRED')
    session = Path(m['member_session_file'])
    if session.is_symlink() or session.stat().st_mode & 0o077:
        raise ValueError('PRIVATE_ORIGINAL_MEMBER_FILE_REQUIRED')
    if dt.datetime.fromisoformat(m['member_expires_at']).timestamp() - now < m['timeout_seconds']:
        raise ValueError('SESSION_SHORTER_THAN_RUN_BUDGET')


class BindingRefused(ValueError):
    """A graph state bound to another run, owner or app. `reasons` are enums only (never ids or digests)."""
    def __init__(self, reasons):
        super().__init__('CROSS_RUN_OWNER_OR_APP_BINDING')
        self.reasons = reasons


def graph_summary(state, manifest, started):
    """Never borrow old runs, different owners/slugs, or skipped terminal nodes."""
    try:
        state_started = dt.datetime.fromisoformat(str(state.get('startedAt'))).timestamp()
    except ValueError:
        raise BindingRefused(['started-at-unreadable'])
    run_input = state.get('input')
    context = run_input.get('context') if isinstance(run_input, dict) else None
    # #38306 REVIEW-2 ①: a state written before its binding keys is incomplete — skipped this round (KeyError), never
    # recorded as another run's binding.
    if not isinstance(context, dict) or 'appSlug' not in run_input or 'memberId' not in context:
        raise KeyError('binding-keys-not-written-yet')
    reasons = []
    if state.get('graphId') != 'app-build':
        reasons.append('graph-id-mismatch')
    if state_started < started:
        reasons.append('started-before-this-run')
    if run_input.get('appSlug') != manifest['app_slug']:
        reasons.append('app-slug-mismatch')
    if digest(str(context['memberId']).encode()) != manifest['owner_sha256']:
        reasons.append('owner-mismatch')
    if reasons:
        raise BindingRefused(reasons)
    # #38306 REVIEW-2 r2 ②: a state without its node list yet is incomplete (next round), never «a graph with no nodes».
    if not isinstance(state.get('nodes'), list):
        raise KeyError('nodes-not-written-yet')
    nodes = []
    passed = set()
    for n in state['nodes']:
        if not isinstance(n, dict):
            continue
        row = {k: n[k] for k in ['nodeId', 'executed', 'ok', 'seconds'] if k in n}
        # Error messages and generated code can contain secrets. Export enums only.
        if not n.get('ok'):
            raw = str(n.get('output', ''))
            row['failure_codes'] = [code for code in [
                'BUILD_AUTHORITY_REFUSED', 'BUILD_TESTS_EXHAUSTED',
                'PLANNING_OUTPUT_REPAIR_EXHAUSTED', 'APP_BUILD_OWNER_PRESENTATION_REFUSED'] if code in raw]
        if n.get('nodeId') == 'verify-repair' and n.get('ok'):
            # #38306 REVIEW-2 ②: a partial write is not «verified with no detail» — the whole state waits a round
            # (KeyError), so a terminal graph never reports an incomplete verify as passed.
            try:
                parsed = json.loads(n.get('output', ''))
            except (ValueError, TypeError):
                raise KeyError('verify-output-incomplete')
            result = parsed.get('result') if isinstance(parsed, dict) else None
            # r2 ①: an object is not enough — the verify verdict itself (passed: true/false) must be there.
            if not isinstance(result, dict) or not isinstance(result.get('passed'), bool):
                raise KeyError('verify-output-incomplete')
            row['verify'] = {k: result[k] for k in ['passed', 'files', 'repairUsed', 'fileDigest'] if k in result}
            row['test_strategies'] = [
                {'id': t.get('strategyId'), 'passed': t.get('passed'), 'exitCode': t.get('exitCode')}
                for t in result.get('testReceipts', []) if isinstance(t, dict)]
        nodes.append(row)
        if n.get('executed') is True and n.get('ok') is True:
            passed.add(n.get('nodeId'))
    reached = 'graph-entered'
    for node in NODES:
        if node not in passed:
            break
        reached = node
    return {'run_id': state['runId'], 'status': state['status'], 'reached': reached,
            'nodes': nodes, 'raw_state_sha256': digest(json.dumps(state, sort_keys=True).encode())}


def deployment_bypass(messages):
    """Post-dispatch observation, not a security fence or prevention claim."""
    for message in messages:
        if message.get('role') != 'tool':
            continue
        args = str(message.get('toolArgs', ''))
        if message.get('toolName') in ['Bash', 'Agent', 'RunShell'] and re.search(
                r'tailscale.{0,30}(serve|funnel)|fallback deployment|nohup|python3 -m http.server', args, re.I):
            return True
    return False


def known_tool_failure(messages):
    for message in messages:
        if message.get('role') != 'tool' or message.get('toolName') not in ['app_build', 'app_build_plan']:
            continue
        result = str(message.get('toolResult', ''))
        if 'conflicting plugin credential environment name' in result:
            return 'credential-conflict'
        if 'confirmation declined for app_build' in result:
            return 'graph-confirmation-declined'
    return None


def load_graphs(root, manifest, started, report, private_names=None):
    """This run's app-build graph states. A file mid-write, a non-object, or a missing key is skipped this round; a
    state bound to another run/owner/app is refused and recorded (SF6: never a runner crash, never borrowed).
    A private graph file's name is not a public identifier (OP 11-18): the report names it by a short hash id and
    `private_names` (id → name) is what goes to the local private evidence file."""
    graphs = []
    for p in (Path(root) / 'graph-runs' / 'app-build').glob('*.json'):
        try:
            state = json.loads(p.read_text())
        except (ValueError, OSError):
            continue
        if not isinstance(state, dict) or state.get('graphId') != 'app-build':
            continue
        try:
            if dt.datetime.fromisoformat(str(state.get('startedAt'))).timestamp() < started:
                continue
        except ValueError:
            continue
        try:
            graphs.append((state, graph_summary(state, manifest, started)))
        except BindingRefused as refused:
            report['regressions']['cross-run-binding'] = 'refused-other-binding'
            # #38306 REVIEW-1: keep which file and why, so the run's end is named by it (binding-failed), not «deadline».
            seen = report.setdefault('binding_refusals', [])
            file_id = digest(p.name.encode())[:12]
            if private_names is not None:
                private_names[file_id] = p.name
            entry = {'file_id': file_id, 'reasons': refused.reasons}
            if entry not in seen:
                seen.append(entry)
        except (KeyError, TypeError):
            continue  # Incomplete state: next round.
    return graphs


def deadline_status(report):
    """How a run that reached its deadline ends: «binding-failed» when the only graph states seen were refused for their
    binding (another run, owner or app — the causes are in report['binding_refusals']); otherwise «deadline»."""
    if report.get('binding_refusals') and not report.get('run'):
        report['binding_cause'] = sorted({reason for row in report['binding_refusals'] for reason in row['reasons']})
        return 'binding-failed'
    return 'deadline'


class MessageReader:
    """Session lines since `started`, read incrementally (SF6): each file is read from where the last round stopped
    and only complete lines count, so the watcher never re-parses whole transcripts four times a second."""
    def __init__(self, root, started):
        self.root, self.started, self.offsets, self.messages = Path(root), started, {}, []

    def read(self):
        for p in (self.root / 'sessions').glob('*.jsonl'):
            try:
                if p.stat().st_mtime < self.started:
                    continue
                with p.open('rb') as stream:
                    stream.seek(self.offsets.get(p, 0))
                    chunk = stream.read()
            except OSError:
                continue
            end = chunk.rfind(b'\n')
            if end < 0:
                continue  # Only a partial line so far.
            self.offsets[p] = self.offsets.get(p, 0) + end + 1
            for line in chunk[:end].decode('utf-8', 'replace').splitlines():
                try:
                    item = json.loads(line)
                    if isinstance(item, dict) and dt.datetime.fromisoformat(item['ts']).timestamp() >= self.started:
                        self.messages.append(item)
                except (ValueError, KeyError, TypeError):
                    continue
        return self.messages


def read_messages(root, started):
    messages = []
    for p in (Path(root) / 'sessions').glob('*.jsonl'):
        if p.stat().st_mtime < started:
            continue
        for line in p.read_text().splitlines():
            try:
                item = json.loads(line)
                if isinstance(item, dict) and dt.datetime.fromisoformat(item['ts']).timestamp() >= started:
                    messages.append(item)
            except (ValueError, KeyError, TypeError):
                continue  # The writer may be appending a final line.
    return messages


def run(manifest_path, output):
    m = json.loads(Path(manifest_path).read_text())
    preflight(m)
    output = Path(output).resolve()
    if not inside(output, m['workspace']):
        raise ValueError('OUTPUT_OUTSIDE_DISPOSABLE_WORKSPACE')
    output.mkdir(mode=0o700)  # Refuse reuse/overwrite, including old evidence.
    env = {'PATH': os.environ['PATH'], 'TERM': 'xterm-256color', 'HOME': m['home'],
           'XDG_CONFIG_HOME': str(Path(m['workspace']) / 'xdg'),
           'CODEX_HOME': m['account']['home'], 'ELANOUS_CODEX_ACCOUNT_HOME': m['account']['account_home'],
           'ELANOUS_CODEX_ACCOUNT': m['account']['name'], 'ELANOUS_REMOTE_CODEX_ACCESS_ONLY': '1',
           'ELANOUS_MEMBER_SESSION_FILE': m['member_session_file']}
    command = [m['entry'], '--config-dir', m['config']]
    version = subprocess.run(command + ['--version'], env=env, capture_output=True, timeout=30, check=True)
    if m['version'] not in version.stdout.decode() or m['head'] not in version.stdout.decode():
        raise ValueError('LIVE_INSTALLED_VERSION_MISMATCH')
    started = time.time()
    refused_names = {}
    report = {'schema': 1, 'kind': 'live-zero-vm', 'started_at': utc(),
              'manifest_sha256': digest(Path(manifest_path).read_bytes()), 'version': m['version'],
              'head': m['head'], 'regressions': {k: 'unmeasured' for k in REGRESSIONS},
              'prompt_count': 0, 'graph_approval_keys': 0, 'owner_continuations': 0,
              'status': 'running', 'run': None, 'public_url': None}
    report['regressions'].update({'normal-installed-entry': 'pass', 'account-home': 'preflight-receipt',
                                  'client-issuer-head': 'preflight-receipt'})
    # Everything that can fail before the product starts happens first (SF6): once the child exists, the very next
    # statement is inside the try whose finally ends its session group.
    raw_fd = os.open(output / 'terminal.private.raw', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 100, 0, 0))
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    prior_term = signal.signal(signal.SIGTERM, interrupted)
    tail = ''
    owner_pending = False
    public_checked = False
    messages_reader = MessageReader(m['config'], started)
    last_report_write = 0.0
    # #38306 REVIEW-2 ③: the spawn is inside the same try whose finally ends the child's session group and closes the
    # descriptors — a SIGTERM between «child exists» and «cleanup armed» cannot exist.
    child = None
    try:
        # r2 ③: SIGTERM is held while Popen runs — a child that exists but is not yet in `child` cannot be left behind.
        # The held signal arrives right after the assignment, inside this try, and the finally ends the child.
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
        try:
            child = subprocess.Popen(command + ['--tui', 'next'], cwd=m['workspace'], env=env,
                                     stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        finally:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
        os.close(slave)
        slave = None
        raw = os.fdopen(raw_fd, 'wb')
        raw_fd = None
        with raw:
            while time.time() - started < m['timeout_seconds']:
                if child.poll() is not None:
                    report['status'] = 'product-exited'
                    break
                if not report['prompt_count'] and time.time() - started >= 60:
                    report['regressions']['first-run'] = 'fail-no-ready-prompt'
                    report['status'] = 'tui-not-ready'
                    break
                ready, _, _ = select.select([master], [], [], 0.25)
                if ready:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        data = b''  # EIO on macOS/Linux once the product side of the PTY is gone.
                    if not data:
                        # PTY EOF: the product closed its terminal — a named end, never a report left «running».
                        report['status'] = 'product-exited' if child.poll() is not None else 'pty-eof'
                        break
                    raw.write(data)
                    raw.flush()
                    tail = (tail + ANSI.sub('', data.decode('utf-8', 'replace')))[-50000:]
                    if not report['prompt_count'] and READY_SIGNS.search(tail) and '❯' in tail:
                        os.write(master, (PROMPT + '\r').encode())
                        report['prompt_count'] = 1
                        report['regressions']['first-run'] = 'pass'
                        tail = ''
                    if APPROVAL_PROMPT in tail:
                        # Redraws may repeat the same question before the key is consumed.
                        # At most one graph approval key in the entire smoke.
                        if not report['graph_approval_keys']:
                            os.write(master, b'y')
                            report['graph_approval_keys'] = 1
                            report['regressions']['confirmation-and-no-bypass'] = 'approval-sent'
                        tail = ''
                    if OWNER_APPROVAL_LINK in tail and not owner_pending:
                        urls = re.findall(r'https://[^\s()]+', tail)
                        private_json(output / 'owner-approval.private.json', {
                            'observed_at': utc(), 'displayed_url_fragments': urls,
                            'complete_url_verified': False, 'ui_text': tail})
                        owner_pending = True
                        report['status'] = 'waiting-owner-browser-approval'
                        tail = ''
                        print('Owner action required; see owner-approval.private.json', flush=True)
                # An operator can continue only this pending UI after real browser approval.
                # This key is not a substitute for the issuer's actual approval record.
                if owner_pending and sys.stdin.isatty() and select.select([sys.stdin], [], [], 0)[0]:
                    if sys.stdin.readline().strip() == 'continue-owner':
                        os.write(master, b'y')
                        report['owner_continuations'] += 1
                        owner_pending = False
                messages = messages_reader.read()
                tool_failure = known_tool_failure(messages)
                if tool_failure:
                    report['status'] = tool_failure
                    key = 'plugin-credential-isolation' if tool_failure == 'credential-conflict' else 'confirmation-and-no-bypass'
                    report['regressions'][key] = 'fail'
                    break
                if deployment_bypass(messages):
                    report['regressions']['confirmation-and-no-bypass'] = 'fail-bypass-observed'
                    report['status'] = 'bypass-observed'
                    break
                graphs = load_graphs(m['config'], m, started, report, refused_names)
                if len(graphs) > 1:
                    report['status'] = 'multiple-graph-runs'
                    break
                if graphs:
                    state, report['run'] = graphs[0]
                    report['regressions']['natural-route'] = 'pass'
                    report['regressions']['plugin-credential-isolation'] = 'graph-entered'
                    if state.get('status') in ['failed', 'done', 'cancelled']:
                        report['status'] = 'graph-' + state['status']
                        if report['run']['reached'] == 'publish' and not public_checked:
                            public_checked = True
                            url = f"https://{m['app_slug']}--{m['handle']}.elanous.app/"
                            publish = next(n for n in state.get('nodes', []) if isinstance(n, dict) and n.get('nodeId') == 'publish' and n.get('ok'))
                            if url.rstrip('/') not in str(publish.get('output', '')):
                                raise ValueError('RETURNED_PUBLIC_URL_MISMATCH')
                            with urllib.request.urlopen(url, timeout=15) as response:
                                if response.geturl().rstrip('/') != url.rstrip('/'):
                                    raise ValueError('PUBLIC_URL_REDIRECTED')
                                body = response.read(2_000_000)
                                report['public_url'] = {'url': url, 'status': response.status, 'body_sha256': digest(body)}
                            report['regressions']['owner-publish-resume'] = 'publish-url-reached; resume-unmeasured'
                        break
                report['heartbeat_at'] = utc()
                report['regressions']['idle-heartbeat'] = 'watcher-alive'
                if time.time() - last_report_write >= REPORT_EVERY_SECONDS:
                    private_json(output / 'report.json', report)
                    last_report_write = time.time()
            else:
                report['status'] = deadline_status(report)
    except KeyboardInterrupt:
        report['status'] = 'operator-cancelled'
    except Exception as error:
        report['status'] = 'runner-error'
        report['error_class'] = type(error).__name__
        if re.fullmatch(r'[A-Z][A-Z0-9_]+', str(error)):
            report['error_code'] = str(error)
        raise
    finally:
        # Only our session group; never tmux kill-server, pkill, or reserved-host cleanup.
        if child is not None:
            os.killpg(child.pid, signal.SIGTERM) if child.poll() is None else None
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
        for fd in (raw_fd, slave, master):
            if fd is None:
                continue
            try:
                os.close(fd)
            except OSError:
                pass
        signal.signal(signal.SIGTERM, prior_term)
        report['finished_at'] = utc()
        report['product_exit'] = child.returncode if child is not None else None
        report['background_cleanup_proved'] = False
        report['booking_e2e_proved'] = False
        write_final(output, report, refused_names)
    return 0 if (report.get('public_url') or {}).get('status') == 200 else 2


def write_final(output, report, refused_names):
    """The run's last writes. The refused graph names are local evidence only (0600, beside the private PTY evidence);
    report.json carries their ids. r2 ④: a failed side-evidence write is recorded in the report and never stops it."""
    if refused_names:
        try:
            private_json(output / 'binding-refusals.private.json', refused_names)
        except OSError as error:
            report['binding_refusals_private'] = f'write-failed:{type(error).__name__}'
    private_json(output / 'report.json', report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['check', 'run'])
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--out')
    args = parser.parse_args()
    if args.mode == 'check':
        preflight(json.loads(Path(args.manifest).read_text()))
        print('Preparation receipt accepted; not a live E2E result.')
        return 0
    if not args.out:
        parser.error('run requires a fresh --out inside the disposable workspace')
    return run(args.manifest, args.out)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        # Full private exceptions may include member URLs. Export the class only.
        code = str(error) if re.fullmatch(r'[A-Z][A-Z0-9_]+', str(error)) else type(error).__name__
        print('A193 blocked: ' + code, file=sys.stderr)
        sys.exit(2)
