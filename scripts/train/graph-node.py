#!/usr/bin/env python3
"""Run the versioned train batch from a graph context.

The queue, host registry, artifacts, and landing scripts remain operational state.
Only executable source comes from the installed repository revision.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path


def command_for(context, script_dir):
    if context.get('graphId') != 'train-batch' or context.get('nodeId') != 'batch':
        raise ValueError('expected train-batch/batch graph context')
    data = context.get('input')
    if not isinstance(data, dict):
        raise ValueError('graph input must be an object')
    mode = data.get('mode', 'dry-run')
    if mode not in ('dry-run', 'live'):
        raise ValueError('mode must be dry-run or live')
    required = ('queue', 'repo', 'base')
    for key in required:
        if not isinstance(data.get(key), str) or not data[key]:
            raise ValueError(f'{key} is required')
    if not re.fullmatch(r'[0-9a-f]{40}', data['base']):
        raise ValueError('base must be a full SHA')
    if mode == 'live' and data.get('op_watching') is not True:
        raise ValueError('live train requires op_watching=true')
    args = [sys.executable, str(script_dir / 'legacy/train-batch-live.py'), '--' + mode]
    for key in required:
        args += ['--' + key, data[key]]
    for key in ('host', 'artifacts', 'authorize', 'land-single', 'summary',
                'integration-head', 'side-main', 'run-id', 'exclude',
                'retry-host', 'lock'):
        value = data.get(key.replace('-', '_'))
        if value is not None:
            if not isinstance(value, str):
                raise ValueError(f'{key} must be a string')
            args += ['--' + key, value]
    for key in ('limit', 'gate-timeout', 'land-timeout', 'shards'):
        value = data.get(key.replace('-', '_'))
        if value is not None:
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f'{key} must be a positive integer')
            args += ['--' + key, str(value)]
    for key in ('express', 'op_watching', 'preflight_only', 'allow_preflight_overlap'):
        if data.get(key) is True:
            args.append('--' + key.replace('_', '-'))
    return args


def main():
    context_file = os.environ.get('ELANOUS_GRAPH_CONTEXT')
    if not context_file:
        raise ValueError('ELANOUS_GRAPH_CONTEXT is required')
    context = json.loads(Path(context_file).read_text())
    script_dir = Path(__file__).resolve().parent
    command = command_for(context, script_dir)
    result = subprocess.run(command)
    print(json.dumps({'outcome': 'ok' if result.returncode == 0 else 'fail',
                      'exitCode': result.returncode,
                      'source': str(script_dir / 'legacy/train-batch-live.py')}))
    return result.returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({'outcome': 'fail', 'error': str(exc)}))
        raise SystemExit(2)
