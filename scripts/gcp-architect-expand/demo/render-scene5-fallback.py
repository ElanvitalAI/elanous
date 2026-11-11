"""Render a clearly labelled scene-5 replay from verified fake-world fixtures.

This is an editorial fallback video, never a classic TUI integration receipt.
"""
import argparse
import hashlib
import io
import json
import subprocess
import tempfile
from pathlib import Path

import fitz
from PIL import Image, ImageDraw, ImageFont

PLUGIN = Path(__file__).resolve().parents[3] / 'plugins/gcp-architect-expand'
REPO = PLUGIN.parents[1]
SAMPLE = PLUGIN / "sim/sample-output"
RUNGRAPH = REPO / "docs/samples/gcp-architect-expand/rungraph-direct"
RUNGRAPH_RECEIPT = PLUGIN / "demo/graph-direct-test-world-receipt.json"
DEFAULT_OUT = REPO / "docs/samples/gcp-architect-expand/kcb-scene5-fallback.mp4"
FONT = "/usr/share/fonts/truetype/nanum/NanumGothic.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf"
W, H = 1280, 720
BG, PANEL, PANEL2 = "#081525", "#11263b", "#173249"
WHITE, MUTED, CYAN, GREEN, AMBER = "#f4f8ff", "#a9bfd0", "#64d9ec", "#79d7ac", "#ffd27a"
DURATIONS = [4, 5, 7, 6, 5, 5, 6]


def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT, size)


def text(draw, xy, value, size=24, fill=WHITE, bold=False, max_width=None, line_gap=8):
    f = font(size, bold)
    x, y = xy
    for paragraph in str(value).split("\n"):
        words = paragraph.split(" ")
        line = ""
        for word in words:
            candidate = word if not line else f"{line} {word}"
            if max_width and line and draw.textlength(candidate, font=f) > max_width:
                draw.text((x, y), line, font=f, fill=fill)
                y += size + line_gap
                line = word
            else:
                line = candidate
        draw.text((x, y), line, font=f, fill=fill)
        y += size + line_gap
    return y


def box(draw, rect, fill=PANEL, outline=None, radius=18):
    draw.rounded_rectangle(rect, radius=radius, fill=fill, outline=outline, width=2 if outline else 1)


def base(stage, title, subtitle):
    image = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(image)
    d.rectangle((0, 0, W, 7), fill=CYAN)
    text(d, (54, 30), "ELANOUS  /  KCB SCENE 05", 20, CYAN, True)
    text(d, (912, 31), "REPLAY · TEST UNIVERSE", 17, MUTED, True)
    text(d, (54, 75), title, 42, WHITE, True)
    text(d, (56, 132), subtitle, 21, MUTED)
    for i in range(7):
        d.rounded_rectangle((55 + i * 166, 617, 201 + i * 166, 623), radius=3,
                            fill=CYAN if i <= stage else "#355066")
    text(d, (55, 643), "사전 녹화 재연 · 가짜 GCP 세계 · 실제 classic TUI 통합 영수증 아님", 18, AMBER)
    return image, d


def scene_search():
    im, d = base(0, "GCP 확장안 검색", "설계 결과에서 플러그인을 찾는 목표 경로")
    box(d, (54, 205, 1226, 565))
    text(d, (90, 238), ">  ToolSearch", 28, CYAN, True)
    box(d, (90, 295, 1189, 365), PANEL2)
    text(d, (114, 311), "route:GCP 확장안", 29, WHITE, True)
    d.line((90, 394, 1188, 394), fill="#35566d", width=2)
    text(d, (100, 421), "검색 결과  01", 21, MUTED)
    text(d, (100, 455), "gcp_architect_expand", 32, GREEN, True)
    text(d, (100, 506), "로컬 용량 → 비용·절감·보안 제안 → 사용자 승인", 21, WHITE)
    return im


def scene_capacity(proposal):
    im, d = base(1, "PC 부족 신호 감지", "기존 호스트·대기열 관측값을 읽어 확장 필요성을 판단")
    box(d, (54, 205, 1226, 565))
    s = proposal["signal"]
    rows = [("CPU", s["cpuUsed"], "93%"), ("메모리", s["memoryUsed"], "91%"),
            ("디스크", s["diskUsed"], "92%")]
    for i, (label, value, display) in enumerate(rows):
        y = 248 + i * 87
        text(d, (92, y), label, 24, WHITE, True)
        box(d, (252, y + 3, 1000, y + 32), "#24445a", radius=12)
        box(d, (252, y + 3, 252 + int(748 * value), y + 32), AMBER if value >= 0.9 else CYAN, radius=12)
        text(d, (1042, y - 1), display, 26, AMBER, True)
    text(d, (92, 513), f"대기 작업  {s['queued']}개", 27, GREEN, True)
    return im


def scene_architecture(proposal):
    im, d = base(2, "로컬 + GCP 확장안", "사용자 요청 경로와 비식별 집계 작업의 장애 영역을 분리")
    box(d, (54, 205, 596, 555), PANEL, CYAN)
    box(d, (682, 205, 1226, 555), PANEL, GREEN)
    text(d, (84, 230), "사용자 PC · 계속 로컬", 27, CYAN, True)
    for i, label in enumerate(["구매 API", "좌석 재고·결제", "작업 대기열"]):
        box(d, (84, 291 + i * 72, 564, 345 + i * 72), PANEL2)
        text(d, (111, 302 + i * 72), label, 24, WHITE, True)
    d.line((600, 380, 669, 380), fill=AMBER, width=5)
    d.polygon([(668, 380), (648, 368), (648, 392)], fill=AMBER)
    text(d, (710, 230), "GCP · 승인 후 가짜 실행", 27, GREEN, True)
    for i, label in enumerate(["Batch + Spot 후보", "비식별 집계·리포트", "유휴 시 자동 종료"]):
        box(d, (710, 291 + i * 72, 1193, 345 + i * 72), PANEL2)
        text(d, (737, 302 + i * 72), label, 24, WHITE, True)
    text(d, (86, 574), f"기본 {proposal['region']} (서울)  ·  비교 {proposal['comparisonRegion']}", 20, MUTED)
    return im


def scene_cost(proposal):
    im, d = base(3, "월 비용은 먼저 계산식으로", "공식 SKU 실조회 전에는 가격 숫자를 약속하지 않음")
    box(d, (54, 205, 1226, 565))
    text(d, (90, 238), "월 비용  미산정", 34, AMBER, True)
    text(d, (90, 301), proposal["estimate"]["formula"], 22, WHITE, max_width=1090)
    d.line((90, 384, 1188, 384), fill="#35566d", width=2)
    text(d, (90, 407), "절감 선택지", 23, CYAN, True)
    for i, value in enumerate(proposal["savings"][:3]):
        text(d, (100, 449 + i * 34), f"• {value}", 21, WHITE, max_width=1050)
    return im


def scene_security(proposal):
    im, d = base(4, "보안 등급과 사용자 승인", "돈이 드는 동작 전 기본 선택은 N")
    box(d, (54, 205, 1226, 565))
    text(d, (90, 240), f"데이터 등급  {proposal['security']['grade']}", 31, GREEN, True)
    for i, value in enumerate(proposal["security"]["controls"]):
        text(d, (94, 305 + i * 45), f"• {value}", 23, WHITE)
    d.line((90, 461, 1188, 461), fill="#35566d", width=2)
    text(d, (90, 492), "사용자 승인", 25, CYAN, True)
    box(d, (678, 478, 823, 545), PANEL2, GREEN)
    box(d, (847, 478, 992, 545), PANEL2)
    text(d, (726, 492), "y", 30, GREEN, True)
    text(d, (895, 492), "N", 30, MUTED, True)
    return im


def scene_lifecycle(world):
    im, d = base(5, "별도 가짜 세계 한 바퀴", "직접 runGraph는 승인 대기 · 수명 재연은 별도 시뮬레이션")
    box(d, (54, 205, 1226, 565))
    labels = ["사용자 y", "가짜 프로젝트 생성", "작업·비용 원장", "유휴 종료"]
    for i, label in enumerate(labels):
        x = 82 + i * 290
        box(d, (x, 295, x + 247, 402), PANEL2, GREEN if i == 3 else CYAN)
        text(d, (x + 21, 323), label, 21, WHITE, True, max_width=210)
        if i < 3:
            d.line((x + 247, 349, x + 277, 349), fill=AMBER, width=4)
            d.polygon([(x + 280, 349), (x + 266, 340), (x + 266, 358)], fill=AMBER)
    text(d, (91, 461), f"프로젝트: {world['project']['id']}  ·  활성 lease {world['activeLeases']}", 24, GREEN, True)
    text(d, (91, 510), f"실제 Google Cloud API 호출 {world['realGcpCalls']}회", 23, MUTED)
    return im


def scene_artifacts():
    im, d = base(6, "직접 runGraph 도면·PDF", "공용 출력 그래프 검증 완료 · 보드 첨부는 통합 경로 대기")
    box(d, (54, 205, 1226, 565))
    diagram = Image.open(RUNGRAPH / "architecture.png").convert("RGB")
    diagram.thumbnail((700, 300))
    im.paste(diagram, (80 + (700 - diagram.width)//2, 225 + (300 - diagram.height)//2))
    pdf = fitz.open(RUNGRAPH / "architecture.pdf")
    pix = pdf[0].get_pixmap(matrix=fitz.Matrix(1.4, 1.4), alpha=False)
    preview = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    preview.thumbnail((280, 300))
    im.paste(preview, (840 + (300 - preview.width)//2, 225 + (300 - preview.height)//2))
    text(d, (90, 537), "architecture.excalidraw  ·  architecture.png  ·  architecture.pdf", 19, WHITE)
    return im


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out = args.output.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    proposal = json.loads((SAMPLE / "proposal.json").read_text())
    world = json.loads((SAMPLE / "fake-world.json").read_text())
    direct = json.loads(RUNGRAPH_RECEIPT.read_text())
    verification = json.loads((RUNGRAPH / "verification.json").read_text())
    if direct.get("status") != "awaiting-approval" or direct.get("pendingNode") != "approve":
        raise RuntimeError("direct runGraph did not stop at spending approval")
    if direct.get("realGcpCalls") != 0 or direct.get("spendingNodesExecuted") is not False:
        raise RuntimeError("direct runGraph crossed spending boundary")
    if verification.get("status") != "verified" or verification.get("pages", 0) < 4:
        raise RuntimeError("direct runGraph output is unverified")
    for entry in direct.get("files", []):
        file = RUNGRAPH / Path(entry["path"]).name
        if not file.is_file() or sha(file) != entry["sha256"]:
            raise RuntimeError(f"direct runGraph artifact hash mismatch: {file}")
    if proposal["estimate"]["price"] != "unpriced" or world["realGcpCalls"] != 0 or world["activeLeases"] != 0:
        raise RuntimeError("fallback source is not a verified unpriced fake-world run")
    if world["proposalId"] != proposal["id"]:
        raise RuntimeError("proposal and fake world do not match")
    images = [scene_search(), scene_capacity(proposal), scene_architecture(proposal), scene_cost(proposal),
              scene_security(proposal), scene_lifecycle(world), scene_artifacts()]
    with tempfile.TemporaryDirectory(prefix="gcpx-scene5-") as temp:
        directory = Path(temp)
        lines = []
        for i, (image, duration) in enumerate(zip(images, DURATIONS, strict=True), 1):
            frame = directory / f"{i:02}.png"
            image.save(frame)
            lines.extend([f"file '{frame}'", f"duration {duration}"])
        lines.append(f"file '{directory / f'{len(images):02}.png'}'")
        (directory / "slides.txt").write_text("\n".join(lines) + "\n")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-safe", "0", "-f", "concat",
                        "-i", str(directory / "slides.txt"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264",
                        "-preset", "medium", "-crf", "20", "-movflags", "+faststart", str(out)], check=True)
    manifest = {"kind": "scripted-fallback-video", "scene": 5, "durationSeconds": sum(DURATIONS),
                "resolution": "1280x720", "audio": "none; presenter reads the script live",
                "disclosure": "scripted replay; actual direct runGraph artifacts in final scene, separate fake-world lifecycle; not a classic TUI/board receipt",
                "video": out.name, "videoSha256": sha(out), "source": {name: sha(SAMPLE / name) for name in
                    ("proposal.json", "fake-world.json")},
                "directRunGraph": {"receiptSha256": sha(RUNGRAPH_RECEIPT), "runId": direct["runId"],
                    "status": direct["status"], "sharedGraphRunId": direct["sharedGraphRunId"],
                    "artifacts": {name: sha(RUNGRAPH / name) for name in
                        ("architecture.excalidraw", "architecture.png", "architecture.pdf", "architecture.html", "verification.json")}},
                "realGcpCalls": 0, "price": "unpriced"}
    (out.parent / "kcb-scene5-fallback-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"video": str(out), "sha256": manifest["videoSha256"], "durationSeconds": manifest["durationSeconds"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
