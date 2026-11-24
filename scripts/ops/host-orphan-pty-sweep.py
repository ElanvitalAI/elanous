#!/usr/bin/env python3
"""Collect process candidates for owner review; no process is signalled."""
import argparse
import datetime
import json
import os
import pathlib
import subprocess

SHELLS = frozenset(('sh', 'bash', 'zsh', 'fish'))


def elapsed_seconds(value):
    try:
        day, clock = value.split('-', 1) if '-' in value else ('0', value)
        parts = [int(x) for x in clock.split(':')]
        if len(parts) not in (2, 3) or int(day) < 0 or any(x < 0 for x in parts): return None
        if any(x >= 60 for x in parts[-2:]): return None
        if len(parts) == 3 and int(day) and parts[0] >= 24: return None
        return int(day) * 86400 + sum(n * (60 ** i) for i, n in enumerate(reversed(parts)))
    except (ValueError, TypeError): return None


def classify(line):
    fields = line.split(None, 6)
    if len(fields) != 7: return None
    pid, parent, uid, age, state, tty, command = fields
    if not (pid.isdigit() and parent.isdigit() and uid.isdigit() and command): return None
    seconds = elapsed_seconds(age)
    if seconds is None: return None
    executable = pathlib.PurePath(command.split()[0].lstrip('-')).name
    kinds = []
    if state.startswith('Z') and seconds >= 86400: kinds.append('zombie_24h')
    if executable == 'herdr' and seconds >= 86400: kinds.append('retired_runtime_candidate')
    if executable in SHELLS and int(parent) == 1: kinds.append('orphan_shell_candidate')
    if not kinds: return None
    return dict(pid=int(pid), ppid=int(parent), uid=int(uid), elapsedSeconds=seconds,
                state=state, tty=tty, executable=executable, kinds=kinds,
                ownership='unverified', tabMembership='unverified', eligibleForSignal=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, help='JSON evidence path')
    args = parser.parse_args()
    run = subprocess.run(['ps', '-axo', 'pid=,ppid=,uid=,etime=,stat=,tty=,comm='], capture_output=True, text=True, check=True)
    result = dict(observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), host=os.uname().nodename,
                  mode='observation_only', candidates=[r for line in run.stdout.splitlines() if (r := classify(line))])
    path = pathlib.Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp-' + str(os.getpid()))
    try:
        with tmp.open('x') as f:
            os.chmod(tmp, 0o600)
            json.dump(result, f, ensure_ascii=False, indent=2)
            f.write('\n')
        os.replace(tmp, path)
    finally:
        if tmp.exists(): tmp.unlink()


if __name__ == '__main__': main()
