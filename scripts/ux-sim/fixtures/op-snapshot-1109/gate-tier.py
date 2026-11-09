#!/usr/bin/env python3
"""Classify a proposed PR gate tier from its changed paths and line counts.

Input is one JSON object on stdin:
  {"changes":[{"path":"src/a.ts","additions":1,"deletions":0}],
   "remoteTestPassed":true,"opOneLineApproved":false,
   "opReviewedEditBlocks":0}

The classifier is deliberately policy-only. It does not run tests, inspect
GitHub, or change a train row; callers supply observed facts and retain the
returned rules as the decision explanation.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any


class InputError(ValueError):
    """Raised when the classifier input is incomplete or unsafe."""


@dataclass(frozen=True)
class Change:
    path: str
    additions: int
    deletions: int
    previous_path: str | None = None

    @property
    def changed_lines(self) -> int:
        return self.additions + self.deletions


@dataclass(frozen=True)
class Decision:
    tier: str
    rules: tuple[str, ...]
    changed_files: int
    changed_lines: int

    def as_json(self) -> dict[str, Any]:
        return {
            "tier": self.tier,
            "rules": list(self.rules),
            "changedFiles": self.changed_files,
            "changedLines": self.changed_lines,
        }


def _parse_changes(raw: Any) -> list[Change]:
    if not isinstance(raw, list) or not raw:
        raise InputError("changes must be a non-empty array")

    changes: list[Change] = []
    for index, row in enumerate(raw):
        if not isinstance(row, dict):
            raise InputError(f"changes[{index}] must be an object")
        path = row.get("path")
        if not isinstance(path, str) or not path or "\\" in path:
            raise InputError(f"changes[{index}].path must be a non-empty POSIX path")
        normalized = PurePosixPath(path)
        if normalized.is_absolute() or ".." in normalized.parts or path.startswith("-"):
            raise InputError(f"changes[{index}].path must stay inside the repository")
        previous_path = row.get("previousPath")
        if previous_path is not None:
            if not isinstance(previous_path, str) or not previous_path or "\\" in previous_path:
                raise InputError(f"changes[{index}].previousPath must be a non-empty POSIX path")
            previous = PurePosixPath(previous_path)
            if previous.is_absolute() or ".." in previous.parts or previous_path.startswith("-"):
                raise InputError(f"changes[{index}].previousPath must stay inside the repository")
            previous_path = previous.as_posix()
        additions = row.get("additions")
        deletions = row.get("deletions")
        if (not isinstance(additions, int) or isinstance(additions, bool) or additions < 0
                or not isinstance(deletions, int) or isinstance(deletions, bool) or deletions < 0):
            raise InputError(f"changes[{index}] additions/deletions must be non-negative integers")
        changes.append(Change(normalized.as_posix(), additions, deletions, previous_path))
    return changes


def _is_document(path: str) -> bool:
    suffix = PurePosixPath(path).suffix.lower()
    return suffix in {".md", ".mdx", ".rst", ".adoc", ".txt"}


def _is_test_or_simulation(path: str) -> bool:
    return (path.endswith(".test.ts") or path.startswith("src/ux-sim/")
            or path.startswith("scenarios/"))


def _t2_rules(paths: list[str], changed_files: int, changed_lines: int) -> list[str]:
    rules: list[str] = []
    for path in paths:
        name = PurePosixPath(path).name.lower()
        parts = [part.lower() for part in PurePosixPath(path).parts]

        if name in {"package.json", "bun.lock", "bun.lockb", "bunfig.toml"} or name.startswith("tsconfig"):
            rules.append("dependency-or-runtime-config")
        if (path in {"bin/elanous.mjs", "src/cli/index.ts", "src/cli.ts"}
                or path.startswith("src/cli/commands/")
                or (path.startswith("src/cli/") and "register" in name)):
            rules.append("entrypoint-or-command-registration")
        is_setup_file = bool(re.match(r"^(?:test[._-])?setup(?:[._-]|$)", name)) and not _is_document(path)
        if "harness" in parts or is_setup_file:
            rules.append("test-harness-or-setup")
        if (path == "land-enqueue.sh" or path.startswith(("scripts/release-loop/", "scripts/land-", "seat-state/OP/tools/"))
                and any(token in name for token in ("gate", "train", "land-enqueue", "pr-land"))):
            rules.append("gate-train-or-landing-tool")
        if ("pwa" in parts or "workbox" in parts or name.startswith(("vite.config.", "pwa.config."))
                or "pwa" in name):
            rules.append("pwa-build-config")
        if any(re.search(r"auth|secret|cred|sandbox", part) for part in parts):
            rules.append("security-auth-secret-cred-sandbox")

    if changed_files > 15:
        rules.append("changed-files-over-15")
    if changed_lines > 800:
        rules.append("changed-lines-over-800")
    top_level_dirs = {PurePosixPath(path).parts[0] for path in paths if len(PurePosixPath(path).parts) > 1}
    if len(top_level_dirs) >= 3:
        rules.append("three-or-more-top-level-directories")
    return list(dict.fromkeys(rules))


def classify(payload: Any) -> Decision:
    if not isinstance(payload, dict):
        raise InputError("input must be an object")
    changes = _parse_changes(payload.get("changes"))
    reviewed_edit_blocks = payload.get("opReviewedEditBlocks", 0)
    if (not isinstance(reviewed_edit_blocks, int) or isinstance(reviewed_edit_blocks, bool)
            or reviewed_edit_blocks < 0):
        raise InputError("opReviewedEditBlocks must be a non-negative integer")
    paths = [path for change in changes for path in (change.previous_path, change.path) if path is not None]
    changed_files = len(changes)
    changed_lines = sum(change.changed_lines for change in changes)

    high_risk = _t2_rules(paths, changed_files, changed_lines)
    if high_risk:
        return Decision("T2", tuple(high_risk), changed_files, changed_lines)

    if all(_is_document(path) for path in paths):
        return Decision("T0", ("docs-only",), changed_files, changed_lines)

    remote_passed = payload.get("remoteTestPassed") is True
    if all(_is_test_or_simulation(path) for path in paths) and remote_passed:
        return Decision("T0", ("test-or-simulation-only", "remote-test-pass"), changed_files, changed_lines)

    op_approved = payload.get("opOneLineApproved") is True
    if (op_approved and reviewed_edit_blocks == 1 and changed_files == 1
            and changed_lines <= 2 and changes[0].additions <= 1 and changes[0].deletions <= 1):
        return Decision("T0", ("op-reviewed-single-edit-block-fix",), changed_files, changed_lines)

    rules: list[str] = ["default-radius-gate"]
    if all(_is_test_or_simulation(path) for path in paths) and not remote_passed:
        rules.append("remote-test-pass-required-for-test-only-t0")
    if op_approved and (reviewed_edit_blocks != 1 or changed_files != 1 or changed_lines > 2
                        or changes[0].additions > 1 or changes[0].deletions > 1):
        rules.append("op-one-line-approval-shape-mismatch")
    return Decision("T1", tuple(rules), changed_files, changed_lines)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(classify(payload).as_json(), sort_keys=True))
        return 0
    except (InputError, json.JSONDecodeError) as exc:
        print(f"gate-tier: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
