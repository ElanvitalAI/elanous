#!/usr/bin/env python3
"""A88: 30-minute read-only diff of account rotation, cron and open PR heads."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
import hashlib
import json
import subprocess
import re
import os
from a88_diff import classify_pr_diff, alerts_and_summary

ROOT = Path.home() / "elanous-hq"
ELN = str(Path.home() / ".local/share/elanous/bin/eln")
BASE = ROOT / "seat-state/K-EAST"
STATE = BASE / "SILENT-FALLBACK-STATE-1112.json"
REPORT = BASE / "SILENT-FALLBACK-1112.md"
HOSTS = ("mshq", "node-b", "minim5", "node-c", "mbp", "aws1", "aws2", "gcp1", "gcp2")
STOPPED_BY_OP = frozenset(("aws1", "aws2", "gcp1", "gcp2"))  # OP79713/79804/79972; re-enable on explicit fleet resume

def run(args, *, timeout=20, cwd=None):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=cwd)

def host_probe(host):
    if host in STOPPED_BY_OP:
        return {"state": "stopped"}
    sockets = {
        "node-c": str(Path.home() / ".ssh/agent/s.D5iaNmQfrU.sshd.mPIkwRLeaC"),
        "node-b": str(Path.home() / ".ssh/agent/s.D6aP1etj2s.sshd.RlIfeL18VA"),
    }
    agent_check = (f'test -S {sockets[host]} && echo live || echo dead') if host in sockets else "echo not-applicable"
    command = ("eln config get llm.codexAccountRotation; printf '\\nA88_AGENT='; " + agent_check
               + "; printf '\\nA88_CRON_BEGIN\\n'; crontab -l 2>/dev/null || true")
    args = ["zsh", "-lc", command] if host == "mshq" else ["ssh", "-o", "BatchMode=yes", host, command]
    try:
        p = run(args, timeout=18)
        if p.returncode or "A88_CRON_BEGIN" not in p.stdout:
            return {"error": f"probe rc={p.returncode}"}
        prefix, cron = p.stdout.split("A88_CRON_BEGIN", 1)
        setting, agent_socket = prefix.split("A88_AGENT=", 1)
        setting = setting.strip().splitlines()[-1].strip() if setting.strip() else "unknown"
        return {"rotation": setting, "agent_socket": agent_socket.strip(),
                "cron_sha256": hashlib.sha256(cron.strip().encode()).hexdigest()}
    except Exception as exc:
        return {"error": type(exc).__name__}

def prs_probe():
    p = run([ELN, "gh", "pr", "list", "--state", "open", "--limit", "500",
             "--json", "number,headRefOid,isDraft,state,baseRefName"], timeout=30,
            cwd=Path.home() / "source/elanous-agent")
    if p.returncode:
        return {"error": f"pr-list rc={p.returncode}"}
    try:
        start = p.stdout.index("[")
        end = p.stdout.rindex("]") + 1
        return {str(x["number"]): {"head": x["headRefOid"], "draft": x["isDraft"], "state": x["state"], "base": x["baseRefName"]}
                for x in json.loads(p.stdout[start:end])}
    except Exception as exc:
        return {"error": type(exc).__name__}


def gh_json(args):
    try:
        result = run([ELN, "gh", *args], timeout=20, cwd=Path.home() / "source/elanous-agent")
        return json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def closure(number):
    result = gh_json(["pr", "view", number, "--json", "state"])
    return result.get("state") if isinstance(result, dict) else None


def compare(number, old, new):
    if not isinstance(old, str) or not isinstance(new, str) or not re.fullmatch(r"[0-9a-f]{40}", old) or not re.fullmatch(r"[0-9a-f]{40}", new):
        return None
    result = gh_json(["api", f"repos/ElanvitalAI/elanous/compare/{old}...{new}"])
    return result.get("status") if isinstance(result, dict) else None


def post(body):
    try:
        return run([ELN, "msg", "post", "--from", "RES-INFRA", "--to", "OP", "--kind", "report", "--body", body], timeout=12).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def main():
    with ThreadPoolExecutor(max_workers=6) as pool:
        pending = {h: pool.submit(host_probe, h) for h in HOSTS}
        pr_future = pool.submit(prs_probe)
        current = {"at": datetime.now().astimezone().isoformat(timespec="seconds"),
                   "hosts": {h: pending[h].result() for h in HOSTS}, "prs": pr_future.result()}
    try:
        previous = json.loads(STATE.read_text()) if STATE.is_file() else None
    except (ValueError, OSError):
        previous = None
    routine, anomalies, unknown = [], [], []
    old_prs = (previous or {}).get('last_good_prs')
    if old_prs is None and previous and 'error' not in previous.get('prs', {}):
        old_prs = previous.get('prs')
    if 'error' in current['prs']:
        unknown.append('PR 목록 관측 실패')
        last_good_prs = old_prs
    else:
        if old_prs is not None:
            routine, anomalies, unknown = classify_pr_diff(old_prs, current['prs'], closure, compare)
        last_good_prs = current['prs']
    for host, data in current['hosts'].items():
        if data.get('state') == 'stopped': continue
        old = (previous or {}).get('hosts', {}).get(host, {})
        if 'error' in data:
            unknown.append(f'{host} 관측 실패')
        else:
            if data.get('rotation') not in ('false', 'unknown', None) and old.get('rotation') != data.get('rotation'):
                anomalies.append(f'{host} Codex 자동 계정 회전={data["rotation"]}')
            elif data.get('rotation') in ('unknown', None):
                unknown.append(f'{host} 회전 설정 미측정')
            if host in ('node-c', 'node-b') and data.get('agent_socket') == 'dead' and old.get('agent_socket') != 'dead':
                anomalies.append(f'{host} 고정 SSH 소켓 dead')
        if old and data.get('cron_sha256') and old.get('cron_sha256') and old['cron_sha256'] != data['cron_sha256']:
            unknown.append(f'{host} 크론 해시 변화; 검토 필요')
    alert, summary, daily = alerts_and_summary(routine, anomalies, unknown, (previous or {}).get('daily'), current['at'][:10])
    with REPORT.open('a') as f:
        f.write(f"\n## {current['at']}\n\n")
        for label, items in [('routine', routine), ('anomaly', anomalies), ('unmeasured', unknown)]:
            for item in items: f.write(f'- {label}: {item}\n')
    # Preserve an undelivered daily summary for a later run; never silently mark it sent.
    pending_summaries = list((previous or {}).get('pending_summaries', []))
    if summary: pending_summaries.append(summary)
    pending_alerts = list((previous or {}).get('pending_alerts', []))
    if alert: pending_alerts.append(alert)
    # One batched alarm per run even if a previous delivery failed.
    if pending_alerts and post('🚨 A88 이상: ' + ' | '.join(a.removeprefix('🚨 ') for a in pending_alerts)):
        pending_alerts = []
    if pending_summaries and post(' | '.join(pending_summaries)):
        pending_summaries = []
    current.update(daily=daily, pending_summaries=pending_summaries, pending_alerts=pending_alerts, last_good_prs=last_good_prs)
    tmp = STATE.with_name(STATE.name + '.tmp-' + str(os.getpid()))
    tmp.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, STATE)
    print(f"A88 at={current['at']} routine={len(routine)} anomalies={len(anomalies)} unknown={len(unknown)} report={REPORT}")


if __name__ == '__main__': main()
