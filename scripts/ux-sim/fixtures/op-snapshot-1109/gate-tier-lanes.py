#!/usr/bin/env python3
"""Translate gate-tier evidence to a train lane without executing operations."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def plan_for_evidence(evidence: Any, *, expected_pr: int | None = None,
                      expected_head: str | None = None) -> dict[str, Any]:
    """Return a fail-closed lane plan. This function never starts a gate or merge."""
    tier_data = evidence.get("gateTier") if isinstance(evidence, dict) else None
    if not isinstance(tier_data, dict):
        return _full_plan("missing-gate-tier-evidence")
    if expected_pr is None or expected_head is None:
        return _full_plan("missing-queue-identity")
    evidence_pr = evidence.get("pr")
    if (type(evidence_pr) is not int or evidence_pr != expected_pr
            or evidence.get("head") != expected_head):
        return _full_plan("queue-evidence-identity-mismatch")
    tier = tier_data.get("tier")
    rules = tier_data.get("rules")
    if (not isinstance(tier, str) or tier not in {"T0", "T1", "T2"}
            or not isinstance(rules, list) or not all(isinstance(item, str) for item in rules)):
        return _full_plan("invalid-gate-tier-evidence")

    if tier == "T0":
        if "docs-only" in rules:
            return {
                "tier": "T0", "lane": "direct", "bundleGate": False,
                "radiusGate": False, "localChecks": ["utf16-budget", "rules-contract"],
                "headPinnedSquash": True, "decisionRule": "docs-only",
            }
        if "test-or-simulation-only" in rules and "remote-test-pass" in rules:
            return {
                "tier": "T0", "lane": "direct", "bundleGate": False,
                "radiusGate": False, "localChecks": [], "headPinnedSquash": True,
                "decisionRule": "remote-test-pass",
            }
        if "op-reviewed-single-edit-block-fix" in rules:
            return {
                "tier": "T0", "lane": "direct", "bundleGate": False,
                "radiusGate": False, "localChecks": [], "headPinnedSquash": True,
                "decisionRule": "op-reviewed-single-edit-block-fix",
            }
        return _full_plan("unsubstantiated-t0")

    if tier == "T1" and ("default-radius-gate" in rules or "op-raised-tier" in rules):
        return {
            "tier": "T1", "lane": "radius", "bundleGate": False,
            "radiusGate": True, "changedTests": True, "importerTests": True,
            "affectedTsc": True, "alwaysRatchets": True, "headPinnedSquash": True,
            "localChecks": ["utf16-budget", "rules-contract"] if "docs-only" in rules else [],
            "decisionRule": "op-raised-tier" if "op-raised-tier" in rules else "default-radius-gate",
        }
    if tier == "T2":
        return _full_plan(",".join(rules) or "explicit-t2")
    return _full_plan("unsubstantiated-t1")


def _full_plan(reason: str) -> dict[str, Any]:
    return {
        "tier": "T2", "lane": "full", "bundleGate": True,
        "radiusGate": False, "headPinnedSquash": True, "decisionRule": reason,
    }


def is_t0_remote_test_candidate(evidence: Any) -> bool:
    """Whether manager dispatch may examine this remote-test T0 receipt."""
    tier_data = evidence.get("gateTier") if isinstance(evidence, dict) else None
    if not isinstance(tier_data, dict) or tier_data.get("tier") != "T0":
        return False
    rules = tier_data.get("rules")
    return (isinstance(rules, list) and all(isinstance(item, str) for item in rules)
            and "docs-only" not in rules
            and "test-or-simulation-only" in rules
            and "remote-test-pass" in rules)


def remote_test_receipt_matches_base(evidence: Any, current_base: str) -> bool:
    """Reject remote test receipts measured against any other main base."""
    gate = evidence.get("gate") if isinstance(evidence, dict) else None
    receipt_base = gate.get("baseCommit") if isinstance(gate, dict) else None
    return (isinstance(current_base, str) and len(current_base) == 40
            and all(char in "0123456789abcdef" for char in current_base.lower())
            and isinstance(receipt_base, str) and len(receipt_base) == 40
            and all(char in "0123456789abcdef" for char in receipt_base.lower())
            and receipt_base.lower() == current_base.lower())


def direct_squash_decision(evidence: Any, *, expected_pr: int, expected_head: str,
                           observed_head: str, current_base: str,
                           local_checks: dict[str, Any] | None = None) -> dict[str, Any]:
    """Authorize a T0 direct-lane handoff only for the exact queued head.

    This returns a dispatch decision; callers still own running the listed local
    checks and invoking the existing head-pinned squash worker. Any unmeasured or
    stale input is sent back to the ordinary full-gate lane.
    """
    if type(expected_pr) is not int or expected_pr <= 0:
        return {"action": "full-gate", "reason": "invalid-queue-pr", "lanePlan": _full_plan("invalid-queue-pr")}
    if (not isinstance(expected_head, str) or len(expected_head) != 40
            or any(char not in "0123456789abcdef" for char in expected_head.lower())):
        return {"action": "full-gate", "reason": "invalid-queue-head", "lanePlan": _full_plan("invalid-queue-head")}
    plan = plan_for_evidence(evidence, expected_pr=expected_pr, expected_head=expected_head)
    if plan["lane"] != "direct":
        return {"action": "full-gate", "reason": plan["decisionRule"], "lanePlan": plan}

    if not isinstance(observed_head, str) or observed_head.lower() != expected_head.lower():
        return {"action": "full-gate", "reason": "queue-head-changed", "lanePlan": _full_plan("queue-head-changed")}
    if (not isinstance(current_base, str) or len(current_base) != 40
            or any(char not in "0123456789abcdef" for char in current_base.lower())):
        return {"action": "full-gate", "reason": "current-base-unmeasured", "lanePlan": _full_plan("current-base-unmeasured")}

    rules = evidence["gateTier"]["rules"]
    if "docs-only" in rules:
        return {"action": "full-gate", "reason": "docs-only-existing-guarded-lane",
                "lanePlan": _full_plan("docs-only-existing-guarded-lane")}
    if "remote-test-pass" in rules:
        gate = evidence.get("gate")
        if (not isinstance(gate, dict) or gate.get("passed") is not True
                or str(gate.get("head", "")).lower() != expected_head.lower()
                or not remote_test_receipt_matches_base(evidence, current_base)):
            return {"action": "full-gate", "reason": "remote-test-receipt-unverified",
                    "lanePlan": _full_plan("remote-test-receipt-unverified")}

    required = plan.get("localChecks", [])
    check_results = local_checks if isinstance(local_checks, dict) else {}
    for name in required:
        result = check_results.get(name)
        if (not isinstance(result, dict) or result.get("status") != "passed"
                or str(result.get("head", "")).lower() != expected_head.lower()):
            return {"action": "full-gate", "reason": f"local-check-unverified:{name}",
                    "lanePlan": _full_plan(f"local-check-unverified:{name}")}

    return {
        "action": "head-pinned-squash",
        "pr": expected_pr,
        "head": expected_head.lower(),
        "base": current_base.lower(),
        "localChecks": required,
        "lanePlan": plan,
    }


def simulate_queue(queue_text: str, evidence_root: str | Path) -> list[dict[str, Any]]:
    """Read four-column queue rows and derive lane plans from their evidence files."""
    root = Path(evidence_root)
    plans = []
    for line_number, line in enumerate(queue_text.splitlines(), 1):
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 4:
            raise ValueError(f"queue row {line_number}: expected 4 fields")
        pr, head, tree, evidence_path = fields
        if not pr.isdigit() or len(head) != 40 or any(char not in "0123456789abcdef" for char in head):
            raise ValueError(f"queue row {line_number}: invalid PR/head")
        path = Path(evidence_path)
        if not path.is_absolute():
            path = root / path
        try:
            evidence = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError, RecursionError):
            evidence = None
        plans.append({"pr": int(pr), "head": head, "tree": tree,
                      "lanePlan": plan_for_evidence(evidence, expected_pr=int(pr), expected_head=head)})
    return plans
