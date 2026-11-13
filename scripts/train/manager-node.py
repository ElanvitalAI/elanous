#!/usr/bin/env python3
"""One versioned train-manager tick, invoked only by the train-manager graph."""
import json
import os
import subprocess
import sys
from pathlib import Path


def main():
    context_file = os.environ.get('ELANOUS_GRAPH_CONTEXT')
    if not context_file:
        raise ValueError('ELANOUS_GRAPH_CONTEXT is required')
    context = json.loads(Path(context_file).read_text())
    if context.get('graphId') != 'train-manager' or context.get('nodeId') != 'tick':
        raise ValueError('expected train-manager/tick graph context')
    data = context.get('input')
    if not isinstance(data, dict) or data.get('op_watching') is not True:
        raise ValueError('manager tick requires op_watching=true')
    source = Path(__file__).resolve().parent / 'legacy/train-manager.py'
    result = subprocess.run([sys.executable, str(source), '--once'])
    print(json.dumps({'outcome': 'ok' if result.returncode == 0 else 'fail',
                      'exitCode': result.returncode, 'source': str(source)}))
    return result.returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({'outcome': 'fail', 'error': str(exc)}))
        raise SystemExit(2)
