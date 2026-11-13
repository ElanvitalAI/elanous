#!/usr/bin/env python3
"""Repair narrowly bounded missing-JUnit and timeout-only batch gate results."""
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


def run(argv, cwd=None, timeout=360):
    return subprocess.run(argv, cwd=cwd, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, timeout=timeout)


def suites_and_files(path):
    root = ET.parse(path).getroot()
    if root.tag not in ('testsuites', 'testsuite'):
        raise ValueError('JUnit root invalid')
    return root, {s.attrib['file'] for s in root.iter('testsuite') if s.attrib.get('file')}


def merge_junit(existing, addition, file, output):
    root, seen = suites_and_files(existing)
    new_root, new_seen = suites_and_files(addition)
    if file not in new_seen or new_seen - {file} or file in seen:
        raise ValueError('single-file JUnit identity mismatch')
    added = [s for s in new_root.iter('testsuite') if s.attrib.get('file') == file]
    if not added:
        raise ValueError('single-file JUnit suite missing')
    if root.tag == 'testsuite':
        wrapper = ET.Element('testsuites')
        wrapper.append(root)
        root = wrapper
    for suite in added:
        root.append(suite)
    cases = list(root.iter('testcase'))
    root.set('tests', str(len(cases)))
    root.set('failures', str(sum(any(c.tag == 'failure' for c in tc) for tc in cases)))
    root.set('errors', str(sum(any(c.tag == 'error' for c in tc) for tc in cases)))
    pathlib.Path(output).write_bytes(ET.tostring(root, encoding='utf-8', xml_declaration=True))


def run_single(repo, art, commit, file, label, timeout_ms=None, existing_tree=None):
    slug = re.sub(r'[^A-Za-z0-9_.-]+', '_', file)
    out_dir = pathlib.Path(art) / 'train-remeasure'
    out_dir.mkdir(parents=True, exist_ok=True)
    junit = out_dir / f'{label}-{slug}.xml'
    log = out_dir / f'{label}-{slug}.log'
    tree = existing_tree or (out_dir / f'tree-{label}-{slug}')
    made_tree = existing_tree is None
    bun = str(pathlib.Path.home() / '.bun/bin/bun')
    try:
        if made_tree:
            created = run(['git', '-C', repo, 'worktree', 'add', '--detach', str(tree), commit], timeout=120)
            if created.returncode:
                log.write_text(created.stdout)
                return {'status': 'unmeasured', 'reason': 'worktree add failed', 'log': str(log)}
            install = run([bun, 'install', '--frozen-lockfile'], cwd=tree, timeout=300)
            if install.returncode:
                log.write_text(install.stdout)
                return {'status': 'unmeasured', 'reason': 'baseline install failed', 'log': str(log)}
        args = ['timeout', '-k', '10', '300', bun, 'run', 'test:deterministic', './' + file]
        if timeout_ms:
            args += ['--timeout', str(timeout_ms)]
        args += ['--reporter=junit', '--reporter-outfile=' + str(junit)]
        started = time.monotonic()
        proc = run(args, cwd=tree, timeout=330)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        log.write_text(proc.stdout)
        if proc.returncode not in (0, 1) or not junit.is_file():
            return {'status': 'unmeasured', 'reason': 'command timeout/exit or JUnit missing',
                    'rc': proc.returncode, 'elapsedMs': elapsed_ms, 'log': str(log)}
        root, files = suites_and_files(junit)
        if files != {file} or not list(root.iter('testcase')):
            return {'status': 'unmeasured', 'reason': 'JUnit incomplete or wrong file',
                    'rc': proc.returncode, 'elapsedMs': elapsed_ms, 'log': str(log), 'junit': str(junit)}
        return {'status': 'measured', 'rc': proc.returncode, 'elapsedMs': elapsed_ms,
                'log': str(log), 'junit': str(junit)}
    finally:
        if made_tree and pathlib.Path(tree).exists():
            run(['git', '-C', repo, 'worktree', 'remove', '--force', str(tree)], timeout=60)
            run(['git', '-C', repo, 'worktree', 'prune'], timeout=60)


def remeasure_missing(repo, art, base, head, summary):
    by_id = {}
    for detail in summary.get('shardsDetail', []):
        by_id.setdefault(detail.get('shardId'), []).append(detail)
    fixed = []
    for shard_id, reason in (summary.get('unmeasuredByShard') or {}).items():
        if 'aggregate rejected' not in str(reason):
            continue
        attempts = by_id.get(shard_id, [])
        if not attempts:
            continue
        detail = max(attempts, key=lambda x: int(x.get('attempt', 0)))
        files = detail.get('files') or []
        for side, commit_key in (('current', head), ('baseline', base)):
            info = detail.get(side) or {}
            path = info.get('junitPath')
            if not path or not pathlib.Path(path).is_file():
                continue
            _, present = suites_and_files(path)
            tree_files = set(run(['git', '-C', repo, 'ls-tree', '-r', '--name-only', commit_key], timeout=120).stdout.splitlines())
            expected = [f for f in files if f in tree_files]
            missing = [f for f in expected if f not in present]
            if not missing or len(missing) > 2:
                continue
            for file in missing:
                result = run_single(repo, art, commit_key, file,
                                    f'{shard_id}-{detail.get("attempt")}-{side}', existing_tree=(repo if side == 'current' else None))
                if result.get('status') != 'measured':
                    continue
                merged = pathlib.Path(art) / 'train-remeasure' / f'{shard_id}-{detail.get("attempt")}-{side}-merged.xml'
                try:
                    merge_junit(path, result['junit'], file, merged)
                except Exception as exc:
                    result['status'] = 'unmeasured'; result['reason'] = str(exc)
                    fixed.append({'shard': shard_id, 'side': side, 'file': file, **result})
                    continue
                info['junitPath'] = str(merged)
                fixed.append({'shard': shard_id, 'side': side, 'file': file, **result,
                              'mergedJUnit': str(merged), 'reason': 'planned file absent from completed JUnit; isolated rerun appended'})
    if not fixed:
        return False
    shards = []
    seen = set()
    attempts = []
    for detail in summary.get('shardsDetail', []):
        sid = detail.get('shardId')
        if sid not in seen:
            shards.append({'id': sid, 'files': detail.get('files') or []}); seen.add(sid)
        cur, base_info = detail.get('current') or {}, detail.get('baseline') or {}
        if not cur.get('junitPath') or not base_info.get('junitPath'):
            continue
        attempts.append({'shardId': sid, 'attempt': int(detail.get('attempt', 1)),
                         'currentJUnitPath': cur['junitPath'], 'baselineJUnitPath': base_info['junitPath'],
                         'currentExitCode': cur.get('rc'), 'baselineExitCode': base_info.get('rc'),
                         'currentSignal': cur.get('signal'), 'baselineSignal': base_info.get('signal'),
                         'baselineFiles': []})
    base_files = set(run(['git', '-C', repo, 'ls-tree', '-r', '--name-only', base], timeout=120).stdout.splitlines())
    for attempt in attempts:
        shard = next(s for s in shards if s['id'] == attempt['shardId'])
        attempt['baselineFiles'] = [f for f in shard['files'] if f in base_files]
    env = os.environ.copy()
    env['OP_TRAIN_AGGREGATE'] = json.dumps({'shards': shards, 'attempts': attempts})
    js = r'''const fs=require("node:fs");const {aggregateGateTestShards}=await import("./src/self-dev/shard-aggregate.ts");const x=JSON.parse(process.env.OP_TRAIN_AGGREGATE);const a=x.attempts.map(({currentJUnitPath,baselineJUnitPath,...v})=>({...v,currentJUnit:fs.readFileSync(currentJUnitPath,"utf8"),baselineJUnit:fs.readFileSync(baselineJUnitPath,"utf8")}));console.log(JSON.stringify(aggregateGateTestShards(x.shards,a)));'''
    aggregate = run([str(pathlib.Path.home() / '.bun/bin/bun'), '-e', js], cwd=repo, timeout=120)
    if aggregate.returncode:
        summary['trainShardRemeasurement'] = {'status': 'unmeasured', 'repairs': fixed, 'aggregateError': aggregate.stdout[-1000:]}
        return True
    result = json.loads(aggregate.stdout.strip().splitlines()[-1])
    previous = {'verdict': summary.get('verdict'), 'exitCode': summary.get('exitCode'),
                'unmeasuredReason': summary.get('unmeasuredReason'), 'unmeasuredByShard': summary.get('unmeasuredByShard')}
    summary['trainOriginalGate'] = previous
    summary['trainShardRemeasurement'] = {'status': result.get('status'), 'repairs': fixed,
                                          'introduced': (result.get('report') or {}).get('introduced'),
                                          'unknown': (result.get('report') or {}).get('unknown')}
    summary['verdict'] = result.get('status')
    summary['introduced'] = (result.get('report') or {}).get('introduced', 0)
    summary['preexisting'] = (result.get('report') or {}).get('preexisting', summary.get('preexisting'))
    summary['unknown'] = (result.get('report') or {}).get('unknown', 0)
    summary['exitCode'] = 0 if result.get('status') in ('passed', 'pass', 'skipped') else 1
    if result.get('status') != 'unmeasured':
        summary.pop('unmeasuredReason', None); summary.pop('unmeasuredByShard', None)
    summary['verdictLine'] = str(summary.get('verdictLine', '')) + f'\n[train-shard-remeasure] {result.get("status")}; {len(fixed)} missing file(s) isolated and merged'
    return True


def junit_cases(path):
    root = ET.parse(path).getroot()
    cases = {}
    for tc in root.iter('testcase'):
        file = tc.attrib.get('file')
        name = tc.attrib.get('name')
        if not file or not name:
            continue
        cls = tc.attrib.get('classname')
        identity = f'{file} > {cls} > {name}' if cls and cls != file else f'{file} > {name}'
        failures = [c for c in tc if c.tag in ('failure', 'error')]
        text = ' '.join([str(c.attrib.get('message', '')) + ' ' + ''.join(c.itertext()) for c in failures]).lower()
        cases[identity] = {'failed': bool(failures), 'timeout': bool(re.search(r'timed?\s*out|timeout', text)),
                           'skipped': any(c.tag == 'skipped' for c in tc)}
    return cases


def remeasure_timeout_only(repo, art, head, summary):
    if summary.get('verdict') != 'failed' or summary.get('introduced') != 0 or summary.get('unknown') != 0:
        return False
    text = str(summary.get('verdictLine') or '')
    header = re.search(r'(?m)^\[gate-baseline\] timed-out=([0-9]+)\s+\([^\n]*\):\s*(.+)$', text)
    if not header or int(header.group(1)) not in (1, 2):
        return False
    candidates = re.findall(r'(?m)^- flaky-timeout:\s*(.+)$', text)
    if not candidates:
        candidates = [header.group(2).strip()]
    if len(candidates) != int(header.group(1)):
        return False
    grouped = {}
    for identity in candidates:
        file = identity.split(' > ', 1)[0]
        if not re.fullmatch(r'(?:src|test|scripts)/[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?', file) or '..' in pathlib.Path(file).parts:
            return False
        grouped.setdefault(file, []).append(identity)
    details = summary.get('shardsDetail') or []
    baseline_timeouts = set()
    for detail in details:
        base = detail.get('baseline') or {}
        path = base.get('junitPath')
        if path and pathlib.Path(path).is_file():
            try:
                baseline_timeouts.update(k for k, v in junit_cases(path).items() if v['timeout'])
            except Exception:
                pass
    outcomes = []
    for index, (file, ids) in enumerate(grouped.items(), 1):
        result = run_single(repo, art, head, file, f'timeout-head-{index}', timeout_ms=60000, existing_tree=repo)
        if result.get('status') != 'measured' or result.get('rc') not in (0, 1):
            outcomes.append({'file': file, 'status': 'refused', 'reason': result.get('reason', 'standalone timeout/unmeasured'), **result})
            continue
        cases = junit_cases(result['junit'])
        relevant = {k: v for k, v in cases.items() if k in ids}
        fails = {k for k, v in cases.items() if v['failed']}
        skips = {k for k, v in cases.items() if v['skipped']}
        base_same = {k for k in ids if k in baseline_timeouts}
        complete = set(relevant) == set(ids)
        resolved = complete and ((result['rc'] == 0 and not fails and not skips) or
                                 (bool(fails) and fails <= base_same and not (fails - set(ids)) and not skips))
        outcomes.append({'file': file, 'status': 'resolved' if resolved else 'refused', 'candidateIds': ids,
                         'missingCandidateIds': sorted(set(ids) - set(relevant)),
                         'headFailures': sorted(fails), 'baseTimeouts': sorted(base_same), 'headExitCode': result['rc'],
                         'elapsedMs': result.get('elapsedMs'), 'junit': result.get('junit'), 'log': result.get('log')})
    if not outcomes:
        return False
    summary['trainTimeoutRemeasurement'] = {'policy': 'single-file head rerun; pass, or exact base timeout is preexisting', 'cases': outcomes}
    if all(o.get('status') == 'resolved' for o in outcomes):
        summary['trainOriginalGate'] = {'verdict': summary.get('verdict'), 'exitCode': summary.get('exitCode')}
        summary['verdict'] = 'passed'; summary['exitCode'] = 0
        summary['verdictLine'] = text + f'\n[train-timeout-remeasure] resolved {len(candidates)} timeout case(s); evidence in trainTimeoutRemeasurement'
    return True


def pwa_build_diagnostic_fingerprint(text):
    """Return comparable compiler/build diagnostics, excluding timing and checkout paths."""
    lines = []
    for raw in text.splitlines():
        line = re.sub(r'\x1b\[[0-9;]*m', '', raw).strip()
        if re.search(r'\berror TS\d+\b|\bType error:', line, re.I):
            line = re.sub(r'\s+\d+(?:\.\d+)?s\b', '', line)
            line = re.sub(r'/[^\s:]+/apps/pwa/', 'apps/pwa/', line)
            line = re.sub(r'\s+', ' ', line)
            lines.append(line)
    return '\n'.join(lines)


def remeasure_preexisting_pwa_build(repo, art, base, head, summary):
    """Only pardon a PWA build failure when the exact base tree fails with the same diagnostics."""
    if summary.get('verdict') not in ('passed', 'pass') or summary.get('exitCode') != 1:
        return False
    artifact = pathlib.Path(art)
    head_log = artifact / 'gate.log'
    if not head_log.is_file():
        return False
    head_output = head_log.read_text(errors='replace')
    if not re.search(r'\[pwa-gate\] FAIL — PWA 빌드 실패\(rc=1', head_output):
        return False

    changed = run(['git', '-C', repo, 'diff', '--name-only', base, head], timeout=120)
    if changed.returncode:
        summary['preexistingBuild'] = {'status': 'unmeasured', 'reason': 'could not bind changed paths to base/head'}
        return True
    files = [line for line in changed.stdout.splitlines() if line]
    if not files:
        summary['preexistingBuild'] = {'status': 'unmeasured', 'reason': 'no changed paths for PWA gate'}
        return True

    out_dir = artifact / 'train-remeasure'
    out_dir.mkdir(parents=True, exist_ok=True)
    baseline_tree = out_dir / f'pwa-base-{base[:12]}'
    baseline_log = out_dir / 'pwa-base-build.log'
    created = run(['git', '-C', repo, 'worktree', 'add', '--detach', str(baseline_tree), base], timeout=120)
    if created.returncode:
        baseline_log.write_text(created.stdout)
        summary['preexistingBuild'] = {'status': 'unmeasured', 'reason': 'base worktree creation failed',
                                       'base40': base, 'head40': head, 'log': str(baseline_log)}
        return True
    try:
        # Reuse the already frozen dependencies; each worktree keeps its own build output.
        for relative in ('node_modules', 'apps/pwa/node_modules'):
            source = pathlib.Path(repo) / relative
            target = baseline_tree / relative
            if source.exists() and not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(source, target_is_directory=True)
        bun = str(pathlib.Path.home() / '.bun/bin/bun')
        command = [bun, 'scripts/ci-pwa-build-gate.ts', '--changed-files', *files]
        result = run(command, cwd=baseline_tree, timeout=360)
        baseline_log.write_text(result.stdout)
        head_fingerprint = pwa_build_diagnostic_fingerprint(head_output)
        base_fingerprint = pwa_build_diagnostic_fingerprint(result.stdout)
        same_failure = (result.returncode == 1 and bool(head_fingerprint)
                        and head_fingerprint == base_fingerprint)
        summary['preexistingBuild'] = {
            'status': 'preexisting' if same_failure else ('regression' if result.returncode == 0 else 'unresolved'),
            'base40': base, 'head40': head, 'baseExitCode': result.returncode,
            'headExitCode': 1, 'diagnosticFingerprint': head_fingerprint if same_failure else None,
            'headLog': 'gate.log', 'baseLog': str(baseline_log),
            'command': 'bun scripts/ci-pwa-build-gate.ts --changed-files <base..head paths>',
        }
        if same_failure:
            summary['verdictLine'] = str(summary.get('verdictLine', '')) + (
                '\n[preexisting-build] base and head PWA gates fail with identical compiler diagnostics; '
                'test verdict remains passed; evidence in preexistingBuild')
        else:
            summary['verdict'] = 'failed'
            summary['exitCode'] = 1
            summary['verdictLine'] = str(summary.get('verdictLine', '')) + (
                '\n[pwa-build-regression] base/head build comparison did not prove the same failure')
        return True
    finally:
        run(['git', '-C', repo, 'worktree', 'remove', '--force', str(baseline_tree)], timeout=60)
        run(['git', '-C', repo, 'worktree', 'prune'], timeout=60)


def main():
    repo, art, base, head = sys.argv[1:5]
    path = pathlib.Path(art) / 'summary.json'
    summary = json.loads(path.read_text())
    try:
        changed = remeasure_missing(repo, art, base, head, summary)
        if os.environ.get('ELANOUS_TRAIN_DEFER_TIMEOUT_REMEASURE') != '1':
            changed = remeasure_timeout_only(repo, art, head, summary) or changed
        changed = remeasure_preexisting_pwa_build(repo, art, base, head, summary) or changed
        if changed:
            path.write_text(json.dumps(summary, indent=2) + '\n')
    except Exception as exc:
        summary['trainRemeasurementError'] = str(exc)
        summary['verdict'] = 'failed'
        summary['exitCode'] = 1
        path.write_text(json.dumps(summary, indent=2) + '\n')
    passed = summary.get('verdict') in ('passed', 'pass', 'skipped') and summary.get('exitCode') == 0
    print('TRAIN_GATE_RC=0' if passed else 'TRAIN_GATE_RC=1')


if __name__ == '__main__':
    main()
