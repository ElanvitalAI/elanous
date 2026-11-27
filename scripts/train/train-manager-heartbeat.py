#!/usr/bin/env python3
"""기차 매니저 heartbeat — the merge-train manager's launchd slot (com.elanous.train-manager) after LAND-STEWARD.

S: seat-state/OP/tools/train-manager.py ran under launchd every 15 s for the merge-train era; since the land graph took the
   batch path it only printed «queue=0» (a zombie: 6+ days, no work, no signal).
C: deleting it loses the slot and the knowledge; leaving it running hides that nothing owns train work.
A: the train manager is now a sub-loop agent of 착지 집사 (land-steward · src/land-steward/train.ts: order · hot-file lanes ·
   slot advice · knowhow graphs/loop-agents/land-steward/knowhow.md). This script is what launchd runs in its place: it does
   NO train work, writes one heartbeat file that points at the body, and says when the body's last tick is stale.
   The legacy files stay on disk (seat-state/OP/tools/train-manager.py · scripts/train/legacy/train-manager.py), not run.

Heartbeat: <state>/loop-agents/land-steward/train-manager.heartbeat.json
State root: $ELANOUS_STATE_DIR, else ~/.elanous (the operational universe the land graph writes).
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

STALE_S = 30 * 60
BODY = 'eln land steward tick (graphs/triggers/land-graph.yaml)'


def state_root():
    raw = os.environ.get('ELANOUS_STATE_DIR', '').strip()
    return Path(raw).expanduser() if raw else Path.home() / '.elanous'


def steward_last_tick(root):
    for rel in ('loop-agents/land-steward/last-tick.json', 'land-graph/last-tick.json'):
        try:
            at = json.loads((root / rel).read_text()).get('at')
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(at, str):
            return at, rel
    return None, None


def beat(root, now=None):
    now = now or datetime.now(timezone.utc)
    at, source = steward_last_tick(root)
    age = None
    if at:
        try:
            age = int((now - datetime.fromisoformat(at.replace('Z', '+00:00'))).total_seconds())
        except ValueError:
            age = None
    doc = {
        'at': now.isoformat().replace('+00:00', 'Z'), 'pid': os.getpid(),
        'role': 'train-manager · sub-loop agent of land-steward (no train work here)',
        'body': BODY, 'stewardLastTick': at, 'stewardSource': source, 'stewardAgeS': age,
        'stale': age is None or age > STALE_S,
        'legacy': 'seat-state/OP/tools/train-manager.py (kept on disk, not run)',
    }
    home = root / 'loop-agents' / 'land-steward'
    home.mkdir(parents=True, exist_ok=True)
    tmp = home / 'train-manager.heartbeat.json.tmp'
    tmp.write_text(json.dumps(doc))
    tmp.replace(home / 'train-manager.heartbeat.json')
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--interval', type=int, default=60, help='seconds between heartbeats (launchd keeps one process)')
    ap.add_argument('--once', action='store_true', help='one heartbeat, print it, exit')
    a = ap.parse_args(argv)
    root = state_root()
    if a.once:
        print(json.dumps(beat(root)))
        return 0
    last_stale = None
    print(f'train-manager heartbeat · no-op · body = {BODY} · every {a.interval}s', flush=True)
    while True:
        doc = beat(root)
        if doc['stale'] != last_stale:  # one line per change only (signal diet)
            print(f"{doc['at']} steward {'STALE' if doc['stale'] else 'ok'} · last tick {doc['stewardLastTick'] or '—'}", flush=True)
            last_stale = doc['stale']
        time.sleep(max(15, a.interval))


if __name__ == '__main__':
    sys.exit(main())
