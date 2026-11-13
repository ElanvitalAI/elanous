#!/usr/bin/env python3
"""Append-only shared event memory joining train and autopsy by PR/head/base."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import sys
import uuid
from datetime import datetime, timezone

ROOT = Path.home() / 'elanous-hq/seat-state/OP'
MEMORY = Path(os.environ.get('TRAIN_MEMORY_PATH', ROOT / 'train-memory.jsonl'))
LOCK = Path(str(MEMORY) + '.lock')
SCHEMA = 'elanous.memory.v1'


def events():
    if not MEMORY.exists():
        return []
    rows = []
    with MEMORY.open(encoding='utf-8') as stream:
        for number, line in enumerate(stream, 1):
            try:
                row = json.loads(line)
                key = row.get('key', {})
                if row.get('schema') != SCHEMA or not all(isinstance(key.get(k), str) for k in ('pr', 'head', 'base')):
                    continue
                rows.append(row)
            except (ValueError, TypeError):
                continue
    return rows


def exact_rows(pr, head, base, event_type=None):
    return [row for row in events()
            if row['key'] == {'pr': pr, 'head': head, 'base': base}
            and (event_type is None or row.get('eventType') == event_type)]


def append(args):
    MEMORY.parent.mkdir(parents=True, exist_ok=True)
    payload = json.loads(args.data) if args.data else {}
    row = {
        'schema': SCHEMA,
        'eventId': str(uuid.uuid4()),
        'at': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'source': args.source,
        'eventType': args.event_type,
        'key': {'pr': args.pr, 'head': args.head.lower(), 'base': args.base.lower()},
        'runId': args.run_id,
        'status': args.status,
        **payload,
    }
    line = json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n'
    with LOCK.open('a', encoding='utf-8') as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        fd = os.open(MEMORY, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line.encode('utf-8'))
            os.fsync(fd)
        finally:
            os.close(fd)
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    print(json.dumps(row, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    get = sub.add_parser('get')
    get.add_argument('pr'); get.add_argument('head'); get.add_argument('base')
    get.add_argument('--event-type')
    skip = sub.add_parser('skip')
    skip.add_argument('pr'); skip.add_argument('head'); skip.add_argument('base')
    skip.add_argument('--event-type', action='append', default=[])
    put = sub.add_parser('append')
    put.add_argument('--source', default='train')
    put.add_argument('--event-type', required=True)
    put.add_argument('--pr', required=True); put.add_argument('--head', required=True); put.add_argument('--base', required=True)
    put.add_argument('--run-id', default=''); put.add_argument('--status', required=True)
    put.add_argument('--data', default='{}')
    args = parser.parse_args()
    if args.cmd == 'append':
        append(args); return 0
    requested_type = args.event_type if args.cmd == 'get' else None
    rows = exact_rows(args.pr, args.head.lower(), args.base.lower(), requested_type)
    if args.cmd == 'get':
        if not rows: return 1
        print(json.dumps(rows[-1], ensure_ascii=False)); return 0
    event_types = set(args.event_type or ('solo-check', 'batch-gate'))
    measured = [row for row in rows if row.get('eventType') in event_types
                and row.get('status') in ('passed', 'failed', 'precondition-unmet', 'conflict')]
    if measured:
        print(json.dumps(measured[-1], ensure_ascii=False)); return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
