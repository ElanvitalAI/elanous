"""Human-facing, test-universe-only GCP expansion rehearsal.

It reads a design result supplied by the Solar stage, shows the proposal, asks
for an explicit y/N decision, then runs only the isolated fake GCP world.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
PLUGIN = Path(__file__).resolve().parents[3] / 'plugins/gcp-architect-expand'
parser = argparse.ArgumentParser()
parser.add_argument("--test-universe", action="store_true", help="required: fake-world rehearsal only")
parser.add_argument("--ticket-design", type=Path, required=True)
parser.add_argument("--pressure", type=Path, default=PLUGIN / "demo/fixtures/pressure.json")
parser.add_argument("--brief", type=Path, default=PLUGIN / "demo/brief-3-lines.ko.txt")
parser.add_argument("--output-root", type=Path, default=PLUGIN.parents[1] / ".elanous-test/gcp-architect-demo")
parser.add_argument("--opener", help="single executable that accepts a file path; test injection")
args = parser.parse_args()
if not args.test_universe:
    parser.error("--test-universe is required; this TUI is not the production spending graph")
root = args.output_root.resolve()
root.mkdir(parents=True, exist_ok=True)
out = Path(tempfile.mkdtemp(prefix="run-", dir=root))
receipt_path = out / "receipt.json"
receipt = {
    "status": "started", "universe": "test", "mode": "fake-gcp-only",
    "startedAt": datetime.now(timezone.utc).isoformat(), "stages": [],
    "inputDesign": str(args.ticket_design.resolve()), "realGcpCalls": 0,
}


def stage(number, title, detail=""):
    print(f"\n[{number}/5] {title}", flush=True)
    if detail:
        print(detail, flush=True)
    receipt["stages"].append({"step": number, "title": title, "status": "shown"})


def save():
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(f"RECEIPT_PATH={receipt_path}", flush=True)


def prompt(message):
    print(message, end="", flush=True)
    return sys.stdin.readline().strip().lower()


try:
    print("╔══════════════════════════════════════════════════════╗")
    print("║  시스템 아키텍처 + GCP 확장  |  테스트 우주 · 가짜 세계  ║")
    print("╚══════════════════════════════════════════════════════╝")
    brief = args.brief.read_text(encoding="utf8").strip().splitlines()
    if len(brief) != 3:
        raise ValueError("demo brief must contain exactly three lines")
    stage(1, "3줄 지시", "\n".join(f"  {i}. {line}" for i, line in enumerate(brief, 1)))
    design_raw = args.ticket_design.read_bytes()
    design = json.loads(design_raw)
    receipt["inputSha256"] = hashlib.sha256(design_raw).hexdigest()
    receipt["designSource"] = design.get("sourceKind", "unknown")
    stage(2, "설계 결과 로드", f"  {design.get('title', '(제목 없음)')} · 출처: {receipt['designSource']}\n"
          f"  로컬: {', '.join(design.get('localComponents', []))}\n"
          f"  확장 후보 작업: {design.get('offloadWorkload', '(없음)')}")
    proposal_path = out / "proposal.json"
    subprocess.run(["bun", str(SCRIPTS / "demo/propose.ts"), "--ticket-design", str(args.ticket_design.resolve()),
        "--pressure", str(args.pressure.resolve()), "--output", str(proposal_path)],
        check=True, capture_output=True, text=True)
    proposal = json.loads(proposal_path.read_text(encoding="utf8"))
    proposal_sha256 = hashlib.sha256(proposal_path.read_bytes()).hexdigest()
    receipt["proposalId"] = proposal["id"]
    receipt["packSelection"] = "explicit-gcp-pack; auto-select prerequisite pending"
    receipt["scene5"] = {"status": "proposal-shown", "proposalId": proposal["id"],
        "proposalSha256": proposal_sha256, "costStatus": proposal["estimate"]["status"],
        "securityGrade": proposal["security"]["grade"]}
    grade_label = {"public": "공개", "internal": "내부"}.get(proposal["security"]["grade"], proposal["security"]["grade"])
    stage(3, "GCP 확장 제안", "\n".join([
        f"  부족 신호: CPU {proposal['signal']['cpuUsed']:.0%} · 메모리 {proposal['signal']['memoryUsed']:.0%} · "
        f"디스크 {proposal['signal']['diskUsed']:.0%} · 대기열 {proposal['signal']['queued']}",
        f"  후보: Batch + Spot · 기본 {proposal['region']} (서울) · 비용 비교 {proposal['comparisonRegion']} · 구매/결제 경로 로컬 유지",
        f"  비용: {proposal['estimate']['status']}",
        f"  계산식: {proposal['estimate']['formula']}",
        f"  절감: {' / '.join(proposal['savings'])}",
        f"  보안 등급: {grade_label} ({proposal['security']['grade']}) · 통제: "
        f"{' / '.join(proposal['security']['controls'])}",
        "  팩: 공식 GCP 결정표 명시 연결 (자동 선택 선행 대기)",
    ]))
    response = prompt("\n[4/5] 가짜 프로젝트 생성·가짜 원장 실행을 승인합니까? [y/N] ")
    receipt["approval"] = {"decision": "yes" if response == "y" else "no", "scope": "fake-world-only",
        "proposalId": proposal["id"], "proposalSha256": proposal_sha256,
        "decidedAt": datetime.now(timezone.utc).isoformat()}
    if response != "y":
        receipt["status"] = "denied-before-fake-project"
        receipt["scene5"]["status"] = "denied-before-fake-project"
        receipt["stages"].append({"step": 4, "title": "승인", "status": "denied"})
        print("  거절됨 · 가짜 프로젝트와 비용 원장을 만들지 않았습니다.")
        save()
        sys.exit(0)
    receipt["stages"].append({"step": 4, "title": "승인", "status": "approved-fake-only"})
    print("  승인됨 · 테스트 우주의 가짜 세계만 실행합니다.", flush=True)
    print("  진행: 가짜 프로젝트·원장 → 유휴 종료 → Excalidraw/PNG → PDF → 출력 검증", flush=True)
    subprocess.run([sys.executable, str(SCRIPTS / "demo/run.py"),
        "--ticket-design", str(args.ticket_design.resolve()), "--pressure", str(args.pressure.resolve()),
        "--proposal", str(proposal_path), "--output", str(out)], check=True, capture_output=True, text=True)
    if hashlib.sha256(proposal_path.read_bytes()).hexdigest() != proposal_sha256:
        raise RuntimeError("proposal changed after TUI approval")
    result = json.loads((out / "demo-result.json").read_text(encoding="utf8"))
    if result["proposalId"] != proposal["id"] or result["realGcpCalls"] != 0 or result["activeLeases"] != 0:
        raise RuntimeError("demo result did not match the approved fake proposal")
    board = json.loads((out / "board-attachments.json").read_text(encoding="utf8"))
    if board["proposalId"] != proposal["id"] or board["status"] != "artifacts-ready" or len(board["attachments"]) != 4:
        raise RuntimeError("board artifact handoff does not match the approved proposal")
    receipt["status"] = "verified-offline-demo"
    receipt["scene5"]["status"] = "fake-world-complete"
    receipt["scene6"] = {"status": "artifacts-ready", "manifest": str(out / "board-attachments.json"),
        "deploymentStatus": board["deploymentStatus"]}
    receipt["artifacts"] = {name: str(out / name) for name in result["artifacts"]}
    stage(5, "산출 완료 · 파일 열기", "\n".join([
        f"  편집 원본: {out / 'architecture.excalidraw'}",
        f"  PNG 도면:   {out / 'architecture.png'}",
        f"  PDF 설계:   {out / 'architecture-design.pdf'}",
        f"  보드 첨부:  {out / 'board-attachments.json'}",
        f"  영수증:     {receipt_path}",
        "  실 GCP 호출 0 · 가짜 자원 임대 종료 확인",
    ]))
    receipt["stages"][-1]["status"] = "passed"
    choice = prompt("  열기 [d=PNG / p=PDF / e=편집 원본 / Enter=종료] ")
    selected = {"d": "architecture.png", "p": "architecture-design.pdf",
                "e": "architecture.excalidraw"}.get(choice)
    if selected:
        file_path = out / selected
        opener = args.opener or shutil.which("gio") or shutil.which("xdg-open")
        if not opener:
            receipt["openAttempt"] = {"file": str(file_path), "opened": False, "reason": "no system opener"}
            print(f"  열기 도구 없음 · 파일 경로: {file_path}")
        else:
            command = [opener, str(file_path)] if args.opener or Path(opener).name != "gio" else [opener, "open", str(file_path)]
            opened = subprocess.run(command, capture_output=True, text=True, timeout=12)
            receipt["openAttempt"] = {"file": str(file_path), "opened": opened.returncode == 0,
                "reason": "opened" if opened.returncode == 0 else (opened.stderr.strip() or "opener failed")[:300]}
            print(f"  {'열기 성공' if opened.returncode == 0 else '열기 실패'} · {file_path}")
    save()
except Exception as error:
    receipt["status"] = "failed"
    receipt["error"] = str(error)
    save()
    raise
