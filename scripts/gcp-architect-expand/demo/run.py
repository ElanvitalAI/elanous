"""Solar handoff -> offline GCP proposal -> fake lifecycle -> diagram/PDF -> verification.

This consumer never invokes an LLM or Google Cloud. The Solar profile owns the
preceding design step and passes its result as --ticket-design.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit

SCRIPTS = Path(__file__).resolve().parents[1]
PLUGIN = Path(__file__).resolve().parents[3] / 'plugins/gcp-architect-expand'
parser = argparse.ArgumentParser()
parser.add_argument("--ticket-design", "--design-result", dest="ticket_design", type=Path, required=True,
                    help="flat ticket design JSON or structured architect/Graph design result JSON")
parser.add_argument("--pressure", type=Path, default=PLUGIN / "demo/fixtures/pressure.json")
parser.add_argument("--proposal", type=Path, help="already shown and approved proposal in the output directory")
parser.add_argument("--output", type=Path, default=PLUGIN / "sim/sample-output")
parser.add_argument("--attachment-url-base", help="authenticated HTTPS or app-relative artifact URL prefix, after publishing")
args = parser.parse_args()
if "--design-result" in sys.argv and "--pressure" not in sys.argv:
    parser.error("--design-result requires an explicit --pressure JSON from existing host observations")
if args.attachment_url_base:
    parsed = urlsplit(args.attachment_url_base)
    if not ((parsed.scheme == "https" and parsed.netloc) or
            (args.attachment_url_base.startswith("/") and not args.attachment_url_base.startswith("//"))):
        parser.error("--attachment-url-base must be HTTPS or an app-relative absolute path")
    if parsed.query or parsed.fragment:
        parser.error("--attachment-url-base cannot contain a query or fragment")
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
proposal_path = out / "proposal.json"
if args.proposal:
    if args.proposal.resolve() != proposal_path:
        raise ValueError("approved proposal must be output/proposal.json")
    approved = json.loads(proposal_path.read_text(encoding="utf8"))
    actual_input_hash = hashlib.sha256(args.ticket_design.read_bytes()).hexdigest()
    if approved.get("inputSha256") != actual_input_hash:
        raise ValueError("ticket design changed after proposal")
else:
    subprocess.run(["bun", str(SCRIPTS / "demo/propose.ts"), "--ticket-design", str(args.ticket_design.resolve()),
        "--pressure", str(args.pressure.resolve()), "--output", str(proposal_path)], check=True)
subprocess.run([sys.executable, str(SCRIPTS / "sim/build-sample.py"), "--proposal", str(proposal_path),
    "--output", str(out)], check=True)
env = {**os.environ, "GCP_ARCHITECT_OUTPUT_DIR": str(out)}
verified = subprocess.run(["bun", str(SCRIPTS.parents[1] / "src/ux-sim/gcp-architect-expand/verify-step.ts")], env=env,
    check=True, capture_output=True, text=True)
check = json.loads(verified.stdout.strip().splitlines()[-1])
if not check.get("ok"):
    raise RuntimeError("architecture output gate failed: " + ", ".join(check.get("errors", [])))
proposal = json.loads(proposal_path.read_text(encoding="utf8"))
(out / "ticketing-design.normalized.json").write_text(
    json.dumps(proposal["ticketDesign"], ensure_ascii=False, indent=2) + "\n", encoding="utf8")
world = json.loads((out / "fake-world.json").read_text(encoding="utf8"))
if world["proposalId"] != proposal["id"] or world["realGcpCalls"] != 0 or world["activeLeases"] != 0:
    raise RuntimeError("fake-world lifecycle or proposal linkage failed")
result = {
    "status": "verified-offline-demo", "sourceKind": proposal["ticketDesign"]["sourceKind"],
    "inputSha256": proposal["inputSha256"], "proposalId": proposal["id"],
    "designResultPath": str(args.ticket_design.resolve()),
    "sourceSessionId": proposal["ticketDesign"].get("sourceSessionId"),
    "sourceGraphRunId": proposal["ticketDesign"].get("sourceGraphRunId"),
    "assumptionStatus": proposal.get("assumptionStatus", "none"),
    "assumptions": proposal.get("assumptions", []),
    "architecture": proposal["architecture"], "costStatus": proposal["estimate"]["status"],
    "securityGrade": proposal["security"]["grade"], "syntheticApproval": world["syntheticApproval"],
    "realGcpCalls": 0, "activeLeases": 0,
    "artifacts": ["proposal.json", "ticketing-design.normalized.json", "architecture.excalidraw", "architecture.png",
                  "architecture-design.pdf", "architecture-design.html", "fake-world.json", "icon-provenance.json",
                  "board-attachments.json"],
}
attachments = []
for name, kind, title, mime, produced_by in [
    ("architecture.excalidraw", "diagram-source", "편집 가능한 아키텍처 도면", "application/json", "diagram"),
    ("architecture.png", "diagram", "GCP 확장 구성도", "image/png", "diagram"),
    ("architecture-design.pdf", "pdf", "시스템 아키텍처 설계 문서", "application/pdf", "pdf"),
    ("architecture-design.html", "html", "설계 문서 HTML 원본", "text/html", "pdf"),
]:
    blob = (out / name).read_bytes()
    url = (args.attachment_url_base.rstrip("/") + "/" + quote(name)) if args.attachment_url_base else "./" + quote(name)
    attachments.append({"kind": kind, "title": title, "url": url,
        "mime": mime, "sha256": hashlib.sha256(blob).hexdigest(), "producedBy": produced_by})
board = {
    "schemaVersion": 1, "kind": "gcp-architect-board-attachment-handoff",
    "cardTitle": proposal["ticketDesign"]["title"], "proposalId": proposal["id"],
    "inputSha256": proposal["inputSha256"], "status": "artifacts-ready",
    "deploymentStatus": "unverified", "realGcpCalls": 0,
    "attachments": attachments,
    "consumerRule": "Relative URLs are test-universe artifact references only. For board.card, publish exact bytes through an authenticated route and regenerate with --attachment-url-base. Deployment status comes only from harness events.",
}
(out / "board-attachments.json").write_text(json.dumps(board, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
(out / "demo-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
print(json.dumps({"output": str(out), **result}, ensure_ascii=False))
