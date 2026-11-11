#!/usr/bin/env python3
"""Read remote landing receipts locally, then join them to exact-head shadow observations.

Extraction uses only Python's standard library, so the same file can run via
`ssh HOST 'python3 - extract ...' < scripts/gate-contract-shadow-collector.py`.
The join never turns an absent, partial, or mismatched receipt into zero misses.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import shlex
import sqlite3
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

SHA = re.compile(r"^[0-9a-f]{40}$", re.I)  # // Source: Git SHA-1 object identity used by the existing gate receipts.
SERIAL_NAME = re.compile(r"^(?P<pr>[1-9][0-9]*)-(?P<head>[0-9a-f]{12})\.log$", re.I)
TEST_HEADER = re.compile(r"^(?P<file>\S+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$")
FAIL_LINE = re.compile(r"^\(fail\) (?P<name>.+?)(?: \[[^]]+\])?$", re.M)
RUN_SUMMARY = re.compile(r"(?m)^(?P<passed>[0-9]+) pass\s*\n(?P<failed>[0-9]+) fail\s*\n"
                         r"(?:(?P<errors>[0-9]+) errors\s*\n)?(?:[0-9]+ expect\(\) calls\s*\n)?"
                         r"Ran (?P<tests>[0-9]+) tests across (?P<files>[0-9]+) files\.")


def emit(row: dict) -> None:
    print(json.dumps(row, ensure_ascii=False, sort_keys=True))


def serial_receipt(path: Path) -> dict | None:
    match = SERIAL_NAME.fullmatch(path.name)
    if not match:
        return None
    text = path.read_text(errors="replace")
    summaries = list(RUN_SUMMARY.finditer(text))
    file: str | None = None
    failures: list[str] = []
    unmapped = 0
    for line in text.splitlines():
        header = TEST_HEADER.match(line)
        if header:
            file = header.group("file")
        failure = FAIL_LINE.match(line)
        if failure:
            if file:
                failures.append(f"{file} > {failure.group('name')}")
            else:
                unmapped += 1
    summary = summaries[-1] if len(summaries) == 1 else None
    failed = int(summary.group("failed")) if summary else None
    errors = int(summary.group("errors") or 0) if summary else None
    complete = summary is not None and errors == 0 and failed == len(failures) and unmapped == 0
    return {"kind": "serial-ratchet", "pr": int(match.group("pr")), "headPrefix": match.group("head").lower(),
            "complete": complete, "failureIds": sorted(set(failures)) if complete else None,
            "reportedFailures": failed, "reportedErrors": errors,
            "testedFiles": int(summary.group("files")) if summary else None,
            "reason": None if complete else "missing-or-inconsistent-test-summary", "source": str(path)}


def train_manifest(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text())
        members = [{"pr": int(row["pr"]), "head": row["head"].lower()} for row in data.get("members", [])
                   if str(row.get("pr", "")).isdigit() and SHA.fullmatch(str(row.get("head", "")))]
        integration = data.get("integrationHead")
        base = data.get("base")
        if not SHA.fullmatch(str(integration)) or not SHA.fullmatch(str(base)) or not members:
            return None
        return {"kind": "train-manifest", "integrationHead": integration.lower(), "base": base.lower(),
                "members": members, "source": str(path)}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def train_retry_manifest(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text())
        retry = data.get("gateRetry") or {}
        integration, base = retry.get("integrationHead"), data.get("base")
        members = [{"pr": int(row["pr"]), "head": row["head"].lower()} for row in retry.get("members", [])
                   if str(row.get("pr", "")).isdigit() and SHA.fullmatch(str(row.get("head", "")))]
        if not SHA.fullmatch(str(integration)) or not SHA.fullmatch(str(base)) or not members:
            return None
        return {"kind": "train-manifest", "integrationHead": integration.lower(), "base": base.lower(),
                "members": members, "source": f"{path}#gateRetry"}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def junit_failures(path: Path, expected_files: set[str], rc: int) -> list[str]:
    root = ET.parse(path).getroot()
    if root.tag != "testsuites" or not expected_files:
        raise ValueError("JUnit root or expected shard files missing")
    failures: list[str] = []

    def declared(node: ET.Element, key: str) -> int:
        value = node.get(key)
        if value is None or not value.isdecimal():
            raise ValueError(f"JUnit {key} count missing")
        return int(value)

    def check_suite(suite: ET.Element) -> tuple[int, int]:
        tests = failed = 0
        for case in suite.findall("testcase"):
            tests += 1
            if case.find("failure") is None and case.find("error") is None:
                continue
            failed += 1
            file = case.get("file") or suite.get("file")
            name = case.get("name")
            if not file or not name or not TEST_HEADER.fullmatch(f"{file}:"):
                raise ValueError("failed JUnit testcase lacks a safe file/name")
            failures.append(f"{file} > {name}")
        for child in suite.findall("testsuite"):
            child_tests, child_failed = check_suite(child)
            tests += child_tests
            failed += child_failed
        if tests != declared(suite, "tests") or failed != declared(suite, "failures"):
            raise ValueError("JUnit suite counts differ from testcase inventory")
        if tests == 0:
            raise ValueError("JUnit suite has no testcases")
        if suite.get("errors") is not None and declared(suite, "errors") != 0:
            raise ValueError("JUnit suite has unmeasured errors")
        return tests, failed

    suites = root.findall("testsuite")
    files = [suite.get("file") for suite in suites]
    if set(files) != expected_files or len(files) != len(expected_files):
        raise ValueError("JUnit suite files differ from shard cohort")
    totals = [check_suite(suite) for suite in suites]
    tests = sum(item[0] for item in totals)
    failed = sum(item[1] for item in totals)
    if tests == 0 or tests != declared(root, "tests") or failed != declared(root, "failures"):
        raise ValueError("JUnit root counts differ from testcase inventory")
    if root.get("errors") is not None and declared(root, "errors") != 0:
        raise ValueError("JUnit root has unmeasured errors")
    if (rc == 0) != (failed == 0):
        raise ValueError("JUnit failure count differs from shard exit code")
    return failures


def train_gate(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    head, base = data.get("head40"), data.get("base40")
    if not SHA.fullmatch(str(head)) or not SHA.fullmatch(str(base)) or not data.get("trainGate"):
        return None
    failures: list[str] = []
    problem: str | None = None
    shards = data.get("shardsDetail")
    cohort = data.get("cohort")
    shard_count = data.get("shards")
    if (not isinstance(cohort, list) or not cohort or any(not isinstance(file, str) or not file for file in cohort)
            or len(cohort) != len(set(cohort))):
        problem = "summary-cohort-incomplete"
    elif type(shard_count) is not int or shard_count <= 0 or not isinstance(shards, list) or len(shards) != shard_count:
        problem = "shard-list-incomplete"
    else:
        shard_files: list[str] = []
        for shard in shards:
            expected = shard.get("files")
            if (not isinstance(expected, list) or not expected
                    or any(not isinstance(file, str) or not file for file in expected)
                    or len(expected) != len(set(expected))
                    or any(file in shard_files for file in expected)):
                problem = "shard-cohort-unmeasured"
                break
            shard_files.extend(expected)
            current = shard.get("current", {})
            if current.get("head40") != head or current.get("rc") not in (0, 1):
                problem = "shard-head-or-result-unmeasured"
                break
            junit = Path(str(current.get("junitPath", "")))
            if not junit.is_file():
                junit = path.parent / junit.name
            try:
                if current.get("cohort") != expected:
                    problem = "shard-cohort-unmeasured"
                    break
                failures.extend(junit_failures(junit, set(expected), current["rc"]))
            except (OSError, ValueError, ET.ParseError):
                problem = "shard-junit-unavailable"
                break
        if problem is None and (len(shard_files) != len(cohort) or set(shard_files) != set(cohort)):
            problem = "shard-cohort-incomplete"
    if any(data.get(key, 0) for key in ("unknown", "preconditionUnmet", "unrunImporters")):
        problem = "train-gate-partial"
    reported = data.get("introduced", 0) + data.get("preexisting", 0) if isinstance(data.get("introduced"), int) and isinstance(data.get("preexisting"), int) else None
    if problem is None and reported != len(set(failures)):
        problem = "failure-count-mismatch"
    return {"kind": "train-gate", "integrationHead": head.lower(), "base": base.lower(),
            "complete": problem is None, "failureIds": sorted(set(failures)) if problem is None else None,
            "reportedFailures": reported, "testedFiles": len(data.get("cohort", [])),
            "reason": problem, "source": str(path)}


def extract(kind: str, root: Path) -> None:
    if not root.exists():
        raise FileNotFoundError(f"receipt source unavailable: {root}")
    if kind == "shadow":
        if not root.is_file():
            raise ValueError(f"shadow source is not a database file: {root}")
        with sqlite3.connect(root.as_uri() + "?mode=ro", uri=True) as db:
            for ident, timestamp, event, data in db.execute(
                "SELECT id, ts, event, data FROM logs WHERE category = ? ORDER BY id",
                ("gate.contract-select.shadow",),
            ):
                try:
                    emit({"id": ident, "ts": timestamp, "event": event, "data": json.loads(data or "null")})
                except (ValueError, TypeError):
                    continue
        return
    if kind == "serial":
        paths = root.glob("*.log")
        read = serial_receipt
    elif kind == "train-manifest":
        paths = root.glob("batch-*/manifest.json")
        read = train_manifest
    else:
        paths = list(root.glob("batch-*/summary.json")) + list(root.glob("batch-*/*-art/summary.json"))
        read = train_gate
    for path in paths:
        row = read(path)
        if row:
            emit(row)
        if kind == "train-manifest":
            retry = train_retry_manifest(path)
            if retry:
                emit(retry)


def read_jsonl(paths: list[Path]) -> list[dict]:
    rows = []
    for path in paths:
        for line in path.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                if isinstance(row, dict):
                    rows.append(row)
    return rows


def join(prs: list[dict], receipts: list[dict], shadows: list[dict], since: str) -> list[dict]:
    result = []
    for pr in prs:
        head = str(pr.get("headRefOid", "")).lower()
        if pr.get("mergedAt", "") < since or not SHA.fullmatch(head):
            continue
        number = pr["number"]
        serial = [row for row in receipts if row.get("kind") == "serial-ratchet" and row.get("pr") == number
                  and re.fullmatch(r"[0-9a-f]{12}", str(row.get("headPrefix", "")), re.I)
                  and head.startswith(str(row.get("headPrefix", "")).lower())]
        prior_head_failures = [row for row in receipts if row.get("kind") == "serial-ratchet"
                               and row.get("pr") == number and not head.startswith(str(row.get("headPrefix", "")).lower())
                               and type(row.get("reportedFailures")) is int and row["reportedFailures"] > 0]
        manifests = [row for row in receipts if row.get("kind") == "train-manifest"
                     and any(member.get("pr") == number and member.get("head") == head for member in row.get("members", []))]
        train = [gate for manifest in manifests for gate in receipts if gate.get("kind") == "train-gate"
                 and gate.get("integrationHead") == manifest.get("integrationHead") and gate.get("base") == manifest.get("base")]
        sources = serial + train
        measured = [row for row in sources if row.get("complete") is True]
        observations = [row.get("data", row) for row in shadows if row.get("event") == "observation"]
        landings = [row.get("data", row) for row in shadows if row.get("event") == "landing"]
        landed_bases = {row.get("gateBase") for row in landings if isinstance(row, dict)
                        and row.get("pr") == number and row.get("head") == head and row.get("headMatchesExpected") is True
                        and SHA.fullmatch(str(row.get("gateBase", "")))}
        matches = [obs for obs in observations if isinstance(obs, dict)
                   and ((obs.get("commit") == head and obs.get("priorCommit") in landed_bases
                         and any(row.get("kind") == "serial-ratchet" for row in measured))
                        or any(obs.get("commit") == gate.get("integrationHead") and obs.get("priorCommit") == gate.get("base")
                               for gate in train if gate.get("complete") is True))]
        complete_matches = [obs for obs in matches if obs.get("comparison") == "complete"]
        comparable = None
        if len(matches) == 1 and len(complete_matches) == 1:
            obs = complete_matches[0]
            observed = obs.get("observedFailureIds")
            missed = obs.get("missedFailureCount")
            if (isinstance(observed, list) and all(isinstance(value, str) for value in observed)
                    and len(observed) == len(set(observed)) and obs.get("observedFailureCount") == len(observed)
                    and type(missed) is int and 0 <= missed <= len(observed)
                    and obs.get("candidate") in ("full", "limited")
                    and type(obs.get("selectedTests")) is int and type(obs.get("totalTests")) is int
                    and 0 <= obs["selectedTests"] <= obs["totalTests"]):
                matching_train = [gate for gate in train if gate.get("integrationHead") == obs.get("commit")
                                  and gate.get("base") == obs.get("priorCommit")]
                if matching_train and all(gate.get("complete") is True
                                          and sorted(observed) == sorted(gate.get("failureIds", [])) for gate in matching_train):
                    comparable = missed
                if not train and serial and all(row.get("complete") is True and
                                                set(row.get("failureIds") or []).issubset(observed) for row in serial):
                    comparable = missed
        result.append({"pr": number, "mergedAt": pr["mergedAt"], "head": head,
                       "mergeSha": (pr.get("mergeCommit") or {}).get("oid"),
                       "serialReceipts": len(serial), "serialComplete": sum(row.get("complete") is True for row in serial),
                       "excludedPriorHeadFailureReceipts": len(prior_head_failures),
                       "trainManifests": len(manifests), "trainGateReceipts": len(train),
                       "trainGateComplete": sum(row.get("complete") is True for row in train),
                       "receiptSources": sorted({f"{row.get('sourceHost', 'local')}:{row.get('source')}" for row in sources}),
                       "manifestSources": sorted({f"{row.get('sourceHost', 'local')}:{row.get('source')}" for row in manifests}),
                       "sourceFailureIds": sorted({failure for row in measured for failure in row.get("failureIds", [])}),
                       "shadowObservations": len(matches), "comparison": "complete" if comparable is not None else "unmeasured",
                       "missedFailureCount": comparable,
                       "reason": None if comparable is not None else ("shadow-observation-absent-or-unjoined" if measured
                           else "source-receipt-absent-or-incomplete")})
    return result


def live_extract(source: str, kind: str) -> list[dict]:
    host, separator, root = source.partition(":")
    if not separator or not re.fullmatch(r"[A-Za-z0-9._-]+", host) or not root.startswith("/"):
        raise ValueError(f"invalid remote source: {source}")
    command = f"python3 - extract --kind {shlex.quote(kind)} --root {shlex.quote(root)}"
    # // Source: aws1/mbp read-only extraction observed under 20 seconds; timeout fails the collection closed.
    run = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, command],
                         input=Path(__file__).read_text(), text=True, capture_output=True, timeout=90)
    if run.returncode:
        raise RuntimeError(f"{host} {kind} extraction failed: {run.stderr.strip()[:300]}")
    return [{**json.loads(line), "sourceHost": host} for line in run.stdout.splitlines() if line.strip()]


def pr_query_truncated(prs: list[dict], since: str, limit: int) -> bool:
    return len(prs) >= limit and bool(prs) and prs[-1].get("mergedAt", "") >= since


def live(since: str, serial_source: str, manifest_source: str, gate_sources: list[str], shadow_sources: list[str],
         local_gate_root: Path | None) -> list[dict]:
    if not gate_sources or not shadow_sources:
        raise ValueError("live collection requires remote gate and shadow sources")
    # // Source: gh CLI merged PR listing; the cap is checked against the requested time boundary.
    pr_run = subprocess.run(["gh", "pr", "list", "--state", "merged", "--limit", "1000", "--json",
                             "number,mergedAt,headRefOid,mergeCommit,title"], text=True, capture_output=True, check=True)
    prs = json.loads(pr_run.stdout)
    if pr_query_truncated(prs, since, 1000):
        raise RuntimeError("merged PR query hit its limit before the time boundary")
    log_run = subprocess.run(["eln", "logs", "--exact-category", "gate.contract-select.shadow", "--since", since,
                              "--all", "--json", "--json-data", "--limit", "1000"],
                             text=True, capture_output=True, check=True)
    shadows = [json.loads(line) for line in log_run.stdout.splitlines() if line.strip()]
    if sum(row.get("event") is not None for row in shadows) >= 1000:
        raise RuntimeError("shadow log query hit its limit; paginate before deciding misses")
    for source in shadow_sources:
        shadows.extend(live_extract(source, "shadow"))
    receipts = live_extract(serial_source, "serial") + live_extract(manifest_source, "train-manifest")
    for source in gate_sources:
        receipts.extend(live_extract(source, "train-gate"))
    if local_gate_root:
        receipts.extend(train_gate(path) for path in list(local_gate_root.glob("batch-*/summary.json"))
                        + list(local_gate_root.glob("batch-*/*-art/summary.json")))
    return join(prs, [row for row in receipts if row], shadows, since)


def report(rows: list[dict], path: Path, remote_shadow_sources: list[str] | None = None) -> None:
    reasons = collections.Counter(row["reason"] for row in rows)
    complete = [row for row in rows if row["comparison"] == "complete"]
    serial = sum(row["serialComplete"] > 0 for row in rows)
    train = sum(row["trainGateComplete"] > 0 for row in rows)
    prior = sum(row["excludedPriorHeadFailureReceipts"] for row in rows)
    lines = ["# Gate contract shadow · landing receipt join", "",
             "// Source: GitHub merged PR headRefOid and mergeCommit, aws1 serial ratchet logs, OP train manifests and gate JUnit receipts, gate.contract-select.shadow logs.", "",
             "원격 그림자 DB: " + (", ".join(remote_shadow_sources or []) or "조회 안 함") + ". 로컬 eln logs --all 조회도 포함한다.",
             "직렬 래칫은 일부 시험만 실행하므로 이 영수증만으로 전체 반경의 놓침 0을 판정하지 않는다.", "",
             "| 판정 | 건수 |", "|---|---:|",
             f"| 전체 착지 | {len(rows)} |", f"| head 일치 직렬 래칫 측정 | {serial} |",
             f"| head→통합 head 일치 열차 시험 측정 | {train} |",
             f"| 착지 head와 달라 배제한 이전 실패 래칫 | {prior} |",
             f"| 그림자 놓침 비교 가능 | {len(complete)} |",
             f"| 수집원은 있으나 그림자 관측 없음·불일치 | {reasons.get('shadow-observation-absent-or-unjoined', 0)} |",
             f"| 수집원 없음·불완전 | {reasons.get('source-receipt-absent-or-incomplete', 0)} |", "",
             "전체 sweep의 같은 head/base 관측과 실패 ID가 맞지 않는 행의 missedFailureCount는 null이다.", "",
             "| PR | head | 직렬 | 열차 | 실패 ID | 그림자 비교 | 놓침 |", "|---:|---|---:|---:|---:|---|---:|"]
    for row in rows:
        lines.append(f"| #{row['pr']} | `{row['head'][:12]}` | {row['serialComplete']} | {row['trainGateComplete']} | "
                     f"{len(row['sourceFailureIds'])} | {row['comparison']} | {row['missedFailureCount'] if row['missedFailureCount'] is not None else 'null'} |")
    path.write_text("\n".join(lines) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    extraction = sub.add_parser("extract")
    extraction.add_argument("--kind", choices=("serial", "train-manifest", "train-gate", "shadow"), required=True)
    extraction.add_argument("--root", type=Path, required=True)
    joining = sub.add_parser("join")
    joining.add_argument("--prs", type=Path, required=True)
    joining.add_argument("--receipts", type=Path, action="append", required=True)
    joining.add_argument("--shadows", type=Path, required=True)
    joining.add_argument("--since", required=True, help="UTC ISO date, e.g. 2026-11-09T15:00:00Z")
    running = sub.add_parser("live")
    running.add_argument("--since", required=True)
    running.add_argument("--serial-source", required=True, help="HOST:/absolute/log/dir")
    running.add_argument("--manifest-source", required=True, help="HOST:/absolute/train-artifact/dir")
    running.add_argument("--gate-source", action="append", default=[], help="HOST:/absolute/train-artifact/dir")
    running.add_argument("--shadow-source", action="append", default=[], help="HOST:/absolute/logs.db")
    running.add_argument("--local-gate-root", type=Path)
    running.add_argument("--output", type=Path, required=True)
    running.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "extract":
        extract(args.kind, args.root)
    elif args.command == "join":
        for row in join(json.loads(args.prs.read_text()), read_jsonl(args.receipts), read_jsonl([args.shadows]), args.since):
            emit(row)
    else:
        rows = live(args.since, args.serial_source, args.manifest_source, args.gate_source,
                    args.shadow_source, args.local_gate_root)
        args.output.write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows))
        report(rows, args.report, args.shadow_source)
        print(args.report)


if __name__ == "__main__":
    main()
