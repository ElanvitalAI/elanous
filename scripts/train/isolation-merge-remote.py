#!/usr/bin/env python3
"""Run the merged-tree isolation gate on a dedicated remote host, never locally."""
import argparse
import re
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path

SHA = re.compile(r'^[0-9a-f]{40}$')
REMOTE_DIR = re.compile(r'^/tmp/eln-iso-[0-9a-f]{24}$')
VIOLATION = re.compile(r'^  src/.*→', re.MULTILINE)
PATHS = ('src', 'scripts/ci-isolation-hardcode-gate.ts', 'scripts/isolation-hardcode-baseline.txt')


def evaluate(head_rc, head_output, base_rc, base_output):
    """A red baseline may tolerate only positively identified, unchanged violations."""
    if head_rc == 0:
        return 0, 'PASS'
    if head_rc != 1 or base_rc not in (0, 1):
        return 2, 'UNMEASURED: gate or baseline failed to execute'
    head = set(VIOLATION.findall(head_output))
    if not head:
        return 2, 'UNMEASURED: missing merged-tree violation details'
    if base_rc == 0:
        return 1, 'FAIL: merged tree adds violations'
    base = set(VIOLATION.findall(base_output))
    if not base:
        return 2, 'UNMEASURED: missing violation details'
    added = sorted(head - base)
    return (1, 'FAIL: new violations\n' + '\n'.join(added[:6])) if added else (0, 'PASS: unchanged baseline violations')


def run(repo, host, head, base):
    if host not in ('node-b', 'minim5') or not SHA.fullmatch(head) or not SHA.fullmatch(base):
        raise ValueError('host or commit identity invalid')
    tree = subprocess.run(['git', '-C', repo, 'merge-tree', '--write-tree', base, head], capture_output=True, text=True, timeout=60)
    if tree.returncode:
        raise RuntimeError('merge-tree conflict or unavailable')
    tree_id = tree.stdout.splitlines()[0].strip()
    if not SHA.fullmatch(tree_id):
        raise RuntimeError('invalid merge tree')
    ancestor = subprocess.run(['git', '-C', repo, 'merge-base', '--is-ancestor', base, 'refs/remotes/origin/main'], capture_output=True, timeout=30)
    if ancestor.returncode != 0:
        raise RuntimeError('base is not a verified main ancestor')
    # Never execute an unreviewed PR's gate script or accept a modified baseline as its own oracle.
    gate_diff = subprocess.run(['git', '-C', repo, 'diff', '--quiet', base, tree_id, '--', *PATHS[1:]], capture_output=True, timeout=30)
    if gate_diff.returncode != 0:
        raise RuntimeError('gate script or baseline changed; independent review required')
    for revision in (base, tree_id):
        listing = subprocess.run(['git', '-C', repo, 'ls-tree', '-r', '--full-tree', revision, '--', *PATHS], capture_output=True, text=True, timeout=60, check=True)
        if any(line.split(None, 1)[0] not in ('100644', '100755') for line in listing.stdout.splitlines()):
            raise RuntimeError('archive contains a symlink or non-file entry')
    remote = '/tmp/eln-iso-' + secrets.token_hex(12)
    assert REMOTE_DIR.fullmatch(remote)
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host]
    try:
        subprocess.run([*ssh, f'umask 077; mkdir -m 700 {remote} && mkdir {remote}/head {remote}/base'], check=True, timeout=30)
        for revision, suffix in ((tree_id, 'head'), (base, 'base')):
            with tempfile.TemporaryFile() as errors:
                archive = subprocess.Popen(['git', '-C', repo, 'archive', '--format=tar', revision, *PATHS], stdout=subprocess.PIPE, stderr=errors)
                try:
                    receive = subprocess.run([*ssh, f'tar -xf - -C {remote}/{suffix}'], stdin=archive.stdout, capture_output=True, timeout=180)
                except BaseException:
                    archive.kill()
                    archive.wait()
                    raise
                finally:
                    if archive.stdout: archive.stdout.close()
                archive.wait(timeout=30)
                errors.seek(0)
                if archive.returncode or receive.returncode:
                    raise RuntimeError('archive or remote transfer failed: ' + errors.read(300).decode(errors='replace'))
        def gate(suffix):
            result = subprocess.run([*ssh, f'cd {remote}/{suffix} && "$HOME/elanous-hq/seat-state/OP/tools/hq-find-guard/bin/bun" run scripts/ci-isolation-hardcode-gate.ts'], capture_output=True, text=True, timeout=600)
            return result.returncode, result.stdout + result.stderr
        head_rc, head_output = gate('head')
        base_rc, base_output = gate('base') if head_rc else (0, '')
        return evaluate(head_rc, head_output, base_rc, base_output)
    finally:
        # Exact per-run path only; the validated random name cannot address another tree.
        try: subprocess.run([*ssh, f'rm -rf -- {remote}'], capture_output=True, timeout=30)
        except (OSError, subprocess.SubprocessError): pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('head')
    parser.add_argument('base')
    parser.add_argument('--host', choices=('node-b', 'minim5'), default='node-b')
    parser.add_argument('--repo', default=str(Path.home() / 'elanous-hq/repo.git'))
    args = parser.parse_args()
    try:
        code, detail = run(args.repo, args.host, args.head, args.base)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        code, detail = 2, 'UNMEASURED: ' + str(error)
    print('isolation-gate remote:', detail)
    return code


if __name__ == '__main__':
    sys.exit(main())
