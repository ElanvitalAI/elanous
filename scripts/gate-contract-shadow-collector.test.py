import importlib.util
import contextlib
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("gate_contract_shadow_collector", Path(__file__).with_name("gate-contract-shadow-collector.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

HEAD = "a" * 40
BASE = "b" * 40
INTEGRATION = "c" * 40


class CollectorTest(unittest.TestCase):
    def test_missing_remote_source_fails_collection(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(FileNotFoundError):
                collector.extract("shadow", Path(temp) / "missing.db")

    def test_remote_shadow_db_extracts_observation_data(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "logs.db"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE logs (id INTEGER, ts TEXT, category TEXT, event TEXT, data TEXT)")
                db.execute("INSERT INTO logs VALUES (1, '2026-11-10T00:00:00Z', 'gate.contract-select.shadow', 'observation', ?)",
                           (json.dumps({"commit": HEAD}),))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                collector.extract("shadow", path)
            rows = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(rows[0]["data"], {"commit": HEAD})

    def test_serial_log_extracts_failure_id_only_with_complete_summary(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / f"12-{HEAD[:12]}.log"
            # // Source: synthetic Bun test output with one named failure.
            path.write_text("src/example.test.ts:\n(fail) rejects invalid input [3.0ms]\n\n1 pass\n1 fail\n2 expect() calls\nRan 2 tests across 1 files.\n")
            receipt = collector.serial_receipt(path)
            self.assertTrue(receipt["complete"])
            self.assertEqual(receipt["failureIds"], ["src/example.test.ts > rejects invalid input"])
            path.write_text("src/example.test.ts:\n(fail) rejects invalid input\n")
            self.assertFalse(collector.serial_receipt(path)["complete"])

    def test_train_gate_requires_all_junit_files_and_matching_failure_count(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            junit = root / "current.xml"
            valid = '<testsuites tests="1" failures="1"><testsuite file="src/example.test.ts" tests="1" failures="1"><testcase name="fails" file="src/example.test.ts"><failure /></testcase></testsuite></testsuites>'
            junit.write_text(valid)
            summary = root / "summary.json"
            # // Source: synthetic one-shard train receipt with a named JUnit failure.
            data = {"head40": INTEGRATION, "base40": BASE, "trainGate": True, "shards": 1,
                    "cohort": ["src/example.test.ts"], "introduced": 1, "preexisting": 0, "unknown": 0,
                    "shardsDetail": [{"files": ["src/example.test.ts"], "current": {"head40": INTEGRATION, "rc": 1,
                                      "cohort": ["src/example.test.ts"], "junitPath": str(junit)}}]}
            summary.write_text(json.dumps(data))
            self.assertEqual(collector.train_gate(summary)["failureIds"], ["src/example.test.ts > fails"])
            for invalid in (
                valid.replace('tests="1"', 'tests="2"', 1),
                valid.replace('failures="1"', 'failures="0"', 1),
                '<testsuites tests="0" failures="0"><testsuite file="src/example.test.ts" tests="0" failures="0" /></testsuites>',
                valid.replace('file="src/example.test.ts" tests=', 'file="src/other.test.ts" tests=', 1),
            ):
                junit.write_text(invalid)
                self.assertIsNone(collector.train_gate(summary)["failureIds"])
            junit.write_text(valid)
            data["shardsDetail"][0]["current"]["rc"] = 0
            summary.write_text(json.dumps(data))
            self.assertIsNone(collector.train_gate(summary)["failureIds"])
            junit.unlink()
            self.assertEqual(collector.train_gate(summary)["reason"], "shard-junit-unavailable")

    def test_train_gate_rejects_empty_suite_and_incomplete_summary_cohort(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            junit = root / "current.xml"
            junit.write_text(
                '<testsuites tests="1" failures="0">'
                '<testsuite file="src/one.test.ts" tests="1" failures="0">'
                '<testcase name="passes" file="src/one.test.ts" />'
                '</testsuite>'
                '<testsuite file="src/two.test.ts" tests="0" failures="0" />'
                '</testsuites>'
            )
            summary = root / "summary.json"
            data = {"head40": INTEGRATION, "base40": BASE, "trainGate": True, "shards": 1,
                    "cohort": ["src/one.test.ts", "src/two.test.ts"], "introduced": 0, "preexisting": 0,
                    "unknown": 0, "shardsDetail": [{"files": ["src/one.test.ts", "src/two.test.ts"],
                    "current": {"head40": INTEGRATION, "rc": 0,
                    "cohort": ["src/one.test.ts", "src/two.test.ts"], "junitPath": str(junit)}}]}
            summary.write_text(json.dumps(data))
            self.assertEqual(collector.train_gate(summary)["reason"], "shard-junit-unavailable")

            junit.write_text(
                '<testsuites tests="2" failures="0">'
                '<testsuite file="src/one.test.ts" tests="1" failures="0">'
                '<testcase name="passes" file="src/one.test.ts" />'
                '</testsuite>'
                '<testsuite file="src/two.test.ts" tests="1" failures="0">'
                '<testcase name="passes" file="src/two.test.ts" />'
                '</testsuite>'
                '</testsuites>'
            )
            data["cohort"] = ["src/one.test.ts"]
            summary.write_text(json.dumps(data))
            self.assertEqual(collector.train_gate(summary)["reason"], "shard-cohort-incomplete")

            data.update({"cohort": ["src/one.test.ts", "src/two.test.ts"], "shards": 0, "shardsDetail": []})
            summary.write_text(json.dumps(data))
            self.assertEqual(collector.train_gate(summary)["reason"], "shard-list-incomplete")

    def test_live_requires_gate_and_shadow_sources_before_queries(self):
        with self.assertRaises(ValueError):
            collector.live("2026-11-09T15:00:00Z", "aws1:/serial", "mbp:/manifest", [], ["aws1:/shadow"], None)
        with self.assertRaises(ValueError):
            collector.live("2026-11-09T15:00:00Z", "aws1:/serial", "mbp:/manifest", ["aws1:/gate"], [], None)

    def test_pr_limit_only_rejects_a_full_page_before_boundary(self):
        since = "2026-11-09T15:00:00Z"
        recent = {"mergedAt": "2026-11-10T01:00:00Z"}
        old = {"mergedAt": "2026-11-08T01:00:00Z"}
        self.assertFalse(collector.pr_query_truncated([recent], since, 2))
        self.assertTrue(collector.pr_query_truncated([recent, recent], since, 2))
        self.assertFalse(collector.pr_query_truncated([recent, old], since, 2))

    def test_join_requires_exact_pr_head_base_and_actual_failures(self):
        pr = {"number": 12, "headRefOid": HEAD, "mergedAt": "2026-11-10T01:00:00Z", "mergeCommit": {"oid": "d" * 40}}
        serial = {"kind": "serial-ratchet", "pr": 12, "headPrefix": HEAD[:12], "complete": True, "failureIds": []}
        landing = {"event": "landing", "data": {"pr": 12, "head": HEAD, "gateBase": BASE, "headMatchesExpected": True}}
        observation = {"event": "observation", "data": {"commit": HEAD, "priorCommit": BASE, "comparison": "complete",
                       "observedFailureIds": [], "observedFailureCount": 0, "missedFailureCount": 0,
                       "candidate": "limited", "selectedTests": 1, "totalTests": 2}}
        rows = collector.join([pr], [serial], [landing, observation], "2026-11-09T15:00:00Z")
        self.assertEqual(rows[0]["missedFailureCount"], 0)
        incomplete_observation = {"event": "observation", "data": {**observation["data"], "comparison": "incomplete"}}
        duplicated = collector.join([pr], [serial], [landing, observation, incomplete_observation],
                                    "2026-11-09T15:00:00Z")[0]
        self.assertIsNone(duplicated["missedFailureCount"])
        self.assertEqual(duplicated["shadowObservations"], 2)
        self.assertIsNone(collector.join([pr], [serial], [observation], "2026-11-09T15:00:00Z")[0]["missedFailureCount"])
        wrong = {"event": "landing", "data": {**landing["data"], "head": "e" * 40}}
        self.assertIsNone(collector.join([pr], [serial], [wrong, observation], "2026-11-09T15:00:00Z")[0]["missedFailureCount"])
        old_failure = {**serial, "headPrefix": ("e" * 40)[:12], "reportedFailures": 1,
                       "failureIds": ["src/old.test.ts > fails"]}
        row = collector.join([pr], [serial, old_failure], [landing, observation], "2026-11-09T15:00:00Z")[0]
        self.assertEqual(row["excludedPriorHeadFailureReceipts"], 1)
        self.assertEqual(row["sourceFailureIds"], [])
        incomplete_old = {**old_failure, "complete": False, "reportedFailures": None, "failureIds": None}
        row = collector.join([pr], [serial, incomplete_old], [landing, observation], "2026-11-09T15:00:00Z")[0]
        self.assertEqual(row["excludedPriorHeadFailureReceipts"], 0)

    def test_train_join_rejects_conflicting_retry_failures_and_old_pr_head(self):
        pr = {"number": 12, "headRefOid": HEAD, "mergedAt": "2026-11-10T01:00:00Z", "mergeCommit": {"oid": "d" * 40}}
        manifest = {"kind": "train-manifest", "integrationHead": INTEGRATION, "base": BASE,
                    "members": [{"pr": 12, "head": HEAD}]}
        gate = {"kind": "train-gate", "integrationHead": INTEGRATION, "base": BASE,
                "complete": True, "failureIds": ["src/example.test.ts > fails"]}
        observation = {"event": "observation", "data": {"commit": INTEGRATION, "priorCommit": BASE,
                       "comparison": "complete", "observedFailureIds": ["src/example.test.ts > fails"],
                       "observedFailureCount": 1, "missedFailureCount": 0,
                       "candidate": "limited", "selectedTests": 1, "totalTests": 2}}
        since = "2026-11-09T15:00:00Z"
        self.assertEqual(collector.join([pr], [manifest, gate], [observation], since)[0]["missedFailureCount"], 0)
        conflict = {**gate, "failureIds": ["src/other.test.ts > fails"]}
        self.assertIsNone(collector.join([pr], [manifest, gate, conflict], [observation], since)[0]["missedFailureCount"])
        old = {**manifest, "members": [{"pr": 12, "head": "e" * 40}]}
        self.assertIsNone(collector.join([pr], [old, gate], [observation], since)[0]["missedFailureCount"])


if __name__ == "__main__":
    unittest.main()
