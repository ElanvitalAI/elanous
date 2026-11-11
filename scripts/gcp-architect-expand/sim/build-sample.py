"""Build an offline architecture sample with the repository's Excalidraw and PDF renderers."""
import argparse
import base64
import hashlib
import html as html_escape
import json
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = ROOT / "plugins/gcp-architect-expand/sim"
parser = argparse.ArgumentParser()
parser.add_argument("--proposal", type=Path, help="validated ticketing extension proposal JSON")
parser.add_argument("--output", type=Path, default=HERE / "sample-output")
parser.add_argument("--audience", choices=["auto", "simulation", "user"], default="auto")
args = parser.parse_args()
proposal = json.loads(args.proposal.read_text(encoding="utf8")) if args.proposal else None
audience = args.audience
if audience == "auto":
    source_kind = proposal["ticketDesign"]["sourceKind"] if proposal else "synthetic-sample"
    audience = "simulation" if source_kind.startswith("synthetic-") else "user"
OUT = args.output.resolve()
OUT.mkdir(exist_ok=True)

# The source image files are extracted from the official Google Cloud icon library.
# See assets/README.md for original ZIP member names and checked date.
ICON_PATHS = {
    "compute": "compute-engine.png",
    "storage": "cloud-storage.png",
    "observe": "observability.png",
    "security": "security-identity.png",
}
files = {}
icon_hashes = {}
for key, name in ICON_PATHS.items():
    raw = (HERE / "assets" / name).read_bytes()
    files[key] = {"id": key, "mimeType": "image/png", "dataURL": "data:image/png;base64," + base64.b64encode(raw).decode(), "created": 0}
    icon_hashes[key] = hashlib.sha256(raw).hexdigest()

BLUE = "#1a73e8"
DARK = "#17243b"
MUTED = "#53647a"
BORDER = "#a6bbd6"
GREEN = "#188038"
AMBER = "#b06012"
PURPLE = "#7351b5"
elements = []


def element(kind, ident, x, y, width, height, color, fill="transparent", **extra):
    return dict(type=kind, id=ident, x=x, y=y, width=width, height=height,
        strokeColor=color, backgroundColor=fill, fillStyle="solid", strokeWidth=2,
        strokeStyle="solid", roughness=0, opacity=100, angle=0, seed=1000 + len(ident),
        version=1, versionNonce=2000 + len(ident), isDeleted=False, groupIds=[],
        boundElements=None, link=None, locked=False, **extra)


def rect(ident, x, y, w, h, fill="#ffffff", stroke=BORDER, dashed=False, radius=True):
    extra = {"roundness": {"type": 3}} if radius else {}
    e = element("rectangle", ident, x, y, w, h, stroke, fill, **extra)
    e["strokeStyle"] = "dashed" if dashed else "solid"
    elements.append(e)


def wrap_text(value, width, font_size):
    """Wrap editable Excalidraw text to its measured inner width."""
    result = []
    for line in value.split("\n"):
        current = ""
        used = 0.0
        for char in line:
            advance = font_size * (1.0 if unicodedata.east_asian_width(char) in "FWA" else 0.62)
            if current and used + advance > width:
                if " " in current:
                    before, current = current.rsplit(" ", 1)
                    result.append(before)
                    used = sum(font_size * (1.0 if unicodedata.east_asian_width(letter) in "FWA" else 0.62)
                               for letter in current)
                else:
                    result.append(current.rstrip())
                    current, used = "", 0.0
            current += char
            used += advance
        result.append(current)
    return "\n".join(result)


def text_width(value, font_size):
    return sum(font_size * (1.0 if unicodedata.east_asian_width(char) in "FWA" else 0.62)
               for char in value)


def compact_label(value, width, font_size):
    """Keep an editable service name inside its allotted lane; show truncation."""
    value = " ".join(str(value).split())
    if text_width(value, font_size) <= width:
        return value
    suffix = "…"
    prefix = ""
    for char in value:
        if text_width(prefix + char + suffix, font_size) > width:
            break
        prefix += char
    return prefix.rstrip() + suffix


def text(ident, value, x, y, w=300, size=22, color=DARK, bold=False, auto_wrap=False):
    # Excalidraw's monospace font keeps the diagram editable and renders Korean reliably.
    if auto_wrap:
        value = wrap_text(value, w, size)
    elements.append(element("text", ident, x, y, w, size * (value.count("\n") + 1) * 1.45,
        color, text=value, originalText=value, fontSize=size, fontFamily=3,
        textAlign="left", verticalAlign="top", containerId=None, lineHeight=1.25))


def icon(key, ident, x, y, size=54):
    elements.append(element("image", ident, x, y, size, size, "transparent",
        fileId=key, status="saved", scale=[1, 1]))


def route(ident, points, color=BLUE, dashed=False, end_arrow=True):
    x0, y0 = points[0]
    relative = [[x - x0, y - y0] for x, y in points]
    e = element("arrow" if end_arrow else "line", ident, x0, y0,
        max(x for x, _ in relative), max(y for _, y in relative), color,
        points=relative, startBinding=None, endBinding=None,
        startArrowhead=None, endArrowhead="arrow" if end_arrow else None)
    e["strokeStyle"] = "dashed" if dashed else "solid"
    e["strokeWidth"] = 3
    elements.append(e)


def badge(ident, number, x, y, color=BLUE):
    elements.append(element("ellipse", ident, x, y, 33, 33, color, "#ffffff"))
    text(ident + "-n", str(number), x + 8, y + 4, 28, 18, color)


# Header and spatial boundaries: actual execution is local; cloud resources are design proposals.
ticket_title = proposal["ticketDesign"]["title"] if proposal else None
text("heading", f"{ticket_title} · GCP 확장안" if ticket_title else "로컬 압력 감지에서 승인된 확장까지", 40, 26, 1100, 35, DARK)
text("subheading", "시스템 아키텍처 · 오프라인 시뮬레이션 · 공식 GCP 아이콘" if audience == "simulation" else "시스템 아키텍처 · 승인 전 설계 제안 · 공식 GCP 아이콘", 42, 75, 1050, 20, MUTED)
text("version", "v0.2  |  2026-11-10 UTC", 1190, 35, 330, 20, MUTED)
rect("local-zone", 40, 150, 600, 620, "#f8fafc", "#6b7b91")
rect("cloud-project", 680, 150, 840, 620, "#f5f9ff", BLUE)
rect("cloud-region", 710, 220, 780, 420, "#ffffff", "#7ba7e8", dashed=True)
rect("vpc", 945, 295, 320, 255, "#f1f7ff", "#4293e9", dashed=True)
text("local-boundary", "USER DEVICE  /  BYOC · 자격 로컬 보관", 65, 174, 550, 22, DARK)
text("project-boundary", "GCP PROJECT  /  가짜 프로젝트 (설계 경계)" if audience == "simulation" else "GCP PROJECT  /  승인 전 프로젝트 제안", 705, 173, 750, 22, BLUE)
text("region-boundary", f"REGION  /  {proposal['region'] if proposal else 'asia-northeast3'} (서울) 제안", 735, 238, 540, 19, MUTED)
text("vpc-boundary", "VPC  /  사설 워커 경계 제안", 965, 312, 290, 18, BLUE)

# Local user, design, approval and ledger layers.
text("local-layer", "01  사용자 · 설계", 75, 219, 390, 19, MUTED)
rect("signals", 75, 265, 230, 105, "#eef3fb", "#6b7b91")
text("signals-title", "티켓팅 PC 관측" if proposal else "기존 관측", 95, 282, 210, 22)
text("signals-body", "CPU / RAM / /tmp\n대기열 · 신선도", 95, 313, 200, 17, MUTED)
rect("architect", 365, 265, 230, 105, "#e8f0fe", BLUE)
text("architect-title", "아키텍트", 385, 282, 185, 22)
text("architect-body", "부족 판정 · SKU 식\n보안 등급 · 대안", 385, 313, 195, 17, MUTED)
rect("artifacts", 75, 435, 230, 108, "#f0ecfb", PURPLE)
text("artifacts-title", "출력 계약", 95, 451, 190, 22)
text("artifacts-body", "편집 원본 · PNG\n표지~부록 PDF", 95, 482, 190, 17, MUTED)
rect("approval", 365, 435, 230, 108, "#fff5e8", AMBER)
text("approval-title", "사용자 승인", 385, 451, 195, 22)
text("approval-body", "제안 해시 · 범위\n만료 · 지출 상한", 385, 482, 195, 17, MUTED)
if proposal:
    rect("ticket-local-app", 75, 565, 520, 54, "#ffffff", "#9ba9b9", dashed=True)
    labels = [compact_label(value, 135, 15) for value in proposal["ticketDesign"]["localComponents"][:3]]
    components = " · ".join(labels)
    component_text = f"{components}\n로컬 구매·결제 경로 유지"
    if text_width(components, 15) > 470 or text_width("로컬 구매·결제 경로 유지", 15) > 470:
        raise ValueError("ticket component label does not fit its diagram box")
    text("ticket-local-components", component_text, 92, 574, 470, 15, MUTED)
rect("ledger", 75, 635, 520, 92, "#edf7f0", GREEN)
text("ledger-title", "자원 원장 + 비용 원장", 95, 651, 450, 22)
text("ledger-body", "가짜 lease · 추정/사용/종료 이벤트 · 유휴 TTL" if audience == "simulation" else "자원 lease · 추정/사용/종료 이벤트 · 유휴 TTL", 95, 685, 475, 17, MUTED)

# Project / region / VPC / data / observability / security layers.
text("edge-layer", "02  제어·엣지", 735, 275, 260, 18, MUTED)
text("app-layer", "03  앱·컴퓨트", 965, 335, 260, 18, MUTED)
text("data-layer", "04  데이터", 1290, 275, 200, 18, MUTED)
rect("batch", 735, 320, 165, 111, "#e8f0fe", BLUE)
text("batch-title", "Cloud Batch", 752, 344, 145, 20)
text("batch-body", "비식별 집계\n제안 전용" if proposal else "작업 배치\n제안 전용", 752, 377, 140, 16, MUTED)
rect("spot", 965, 370, 275, 126, "#ffffff", BLUE)
icon("compute", "compute-icon", 983, 392, 66)
text("spot-title", "Compute Engine", 1055, 393, 180, 19)
text("spot-body", "Spot worker\n체크포인트·재시도", 1055, 424, 180, 16, MUTED)
rect("bucket", 1280, 320, 190, 125, "#e8f0fe", BLUE)
icon("storage", "storage-icon", 1295, 340, 48)
text("storage-title", "Cloud Storage", 1353, 340, 100, 16, auto_wrap=True)
text("storage-body", "입출력 staging\n제안 전용", 1298, 393, 153, 15, MUTED, auto_wrap=True)
text("obs-layer", "05  관측 · 비용", 740, 646, 270, 18, MUTED)
text("sec-layer", "06  보안 경계", 1150, 646, 300, 18, MUTED)
rect("observability", 735, 680, 355, 68, "#eef7f6", "#2f8077")
icon("observe", "observe-icon", 750, 690, 48)
text("observe-title", "Logging / Monitoring", 807, 694, 275, 19)
text("observe-body", "예산 경보 · 사용량 대조 (제안)", 807, 719, 278, 15, MUTED)
rect("security", 1140, 680, 350, 68, "#f3eef9", PURPLE)
icon("security", "security-icon", 1155, 690, 48)
text("security-title", "IAM · Secret Manager", 1211, 694, 275, 19)
text("security-body", "조직 정책 / CMEK 필요성 검증", 1211, 719, 275, 15, MUTED)

# Flow numbers and labels. Solid = fake-world exercised; dashed = proposal only.
route("flow1", [(305, 319), (365, 319)], DARK)
badge("step1", 1, 317, 276, DARK)
route("flow2", [(480, 370), (480, 400), (190, 400), (190, 435)], PURPLE)
badge("step2", 2, 316, 378, PURPLE)
route("flow3", [(305, 489), (365, 489)], AMBER)
badge("step3", 3, 316, 447, AMBER)
route("flow4", [(595, 489), (653, 489), (653, 375), (735, 375)], GREEN)
badge("step4", 4, 650, 395, GREEN)
route("flow5", [(900, 381), (965, 381)], BLUE, dashed=True)
badge("step5", 5, 914, 345, BLUE)
route("flow6", [(1240, 431), (1290, 431)], BLUE, dashed=True)
badge("step6", 6, 1240, 450, BLUE)
route("flow7", [(1100, 496), (1100, 610), (900, 610), (900, 680)], "#2f8077", dashed=True)
badge("step7", 7, 966, 572, "#2f8077")
route("flow8", [(735, 715), (670, 715), (670, 681), (595, 681)], GREEN, dashed=True)
badge("step8", 8, 640, 680, GREEN)

# Compact legend within the editable drawing, including the simulation truth boundary.
text("legend-title", "범례 / 판독", 45, 812, 280, 19, DARK)
route("legend-solid", [(275, 829), (338, 829)], GREEN)
text("legend-solid-text", "실행된 가짜 세계 이벤트" if audience == "simulation" else "로컬 실행 이벤트", 355, 815, 380, 17, MUTED)
route("legend-dashed", [(770, 829), (833, 829)], BLUE, dashed=True)
text("legend-dashed-text", "승인 후 실행 후보 · 실제 미배포", 850, 815, 500, 17, MUTED)
text("legend-note", "출처: Google Cloud 공식 제품·카테고리 아이콘  |  프로젝트·VPC·서비스는 설계 경계이며 실제 GCP 리소스 0", 45, 862, 1480, 17, MUTED)

version = "0.2"
diagram = {"type": "excalidraw", "version": 2, "source": "elanous-gcp-architect-expand-simulation",
    "elements": elements, "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None}, "files": files}
(OUT / "architecture.excalidraw").write_text(json.dumps(diagram, ensure_ascii=False, indent=2), encoding="utf8")
(OUT / "icon-provenance.json").write_text(json.dumps({
    "sourcePage": "https://cloud.google.com/icons",
    "checkedAt": "2026-11-10T04:31:00Z",
    "sourceZips": ["https://services.google.com/fh/files/misc/core-products-icons.zip",
                   "https://services.google.com/fh/files/misc/category-icons.zip"],
    "embeddedSha256": icon_hashes,
}, ensure_ascii=False, indent=2), encoding="utf8")

html = '''<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>로컬+GCP 확장 아키텍처 | 오프라인 설계 샘플</title>
<style>
@page { size: A4 landscape; margin: 13mm; }
* { box-sizing: border-box; }
body { margin:0; color:#17243b; background:white; font-family:"Noto Sans CJK KR","WenQuanYi Zen Hei",sans-serif; font-size:10pt; line-height:1.36; }
.sheet { page-break-after:always; min-height:180mm; position:relative; padding:0 2mm 12mm; }
.sheet:last-child { page-break-after:auto; }
.kicker {font-size:9pt; letter-spacing:1.5px; color:#1a73e8; font-weight:700; text-transform:uppercase;}
h1 {font-size:29pt; line-height:1.12; letter-spacing:-1px; margin:12mm 0 7mm;}
h2 {font-size:16pt; margin:7mm 0 3mm; color:#173d78; border-bottom:1px solid #cbd7e8; padding-bottom:2mm;}
h3 {font-size:11pt; margin:4mm 0 2mm; color:#173d78;}
p {margin:2mm 0 3mm;} .muted {color:#53647a;} .small {font-size:8.5pt;color:#53647a;}
.rule {width:33mm;height:2mm;background:#1a73e8;margin:7mm 0;} .hero {font-size:14pt;color:#2d435f;max-width:185mm;}
.grid2 {display:grid; grid-template-columns:1fr 1fr; gap:8mm;} .grid3 {display:grid;grid-template-columns:1fr 1fr 1fr;gap:5mm;}
.panel {border:1px solid #cbd7e8;border-radius:3mm;padding:4mm 5mm;background:#f8fbff;}
.callout {border-left:3px solid #1a73e8;padding:3mm 5mm;background:#f2f7ff;}
table {width:100%;border-collapse:collapse;font-size:8.7pt;line-height:1.25;margin:3mm 0;}
th {background:#e8f0fe;color:#173d78;text-align:left;} th,td {border:1px solid #cbd7e8;padding:2.3mm 2.7mm;vertical-align:top;}
tr {break-inside:avoid;} ul {margin:2mm 0 3mm;padding-left:6mm;} li {margin:1.2mm 0;}
.diagram {width:100%;max-height:142mm;object-fit:contain;display:block;}
.footer {position:absolute;bottom:1mm;left:2mm;right:2mm;border-top:1px solid #cbd7e8;padding-top:2mm;font-size:8pt;color:#66778d;display:flex;justify-content:space-between;}
.toc li {list-style:none;margin:3.3mm 0;border-bottom:1px dotted #cbd7e8;padding-bottom:1mm;display:flex;justify-content:space-between;}
.toc {padding:0;margin:4mm 0 0;} .source {font-size:8pt;overflow-wrap:anywhere;}
</style></head><body>
<section class="sheet" id="cover"><div class="kicker">ELANOUS / SYSTEM ARCHITECTURE DESIGN</div><div class="rule"></div>
<h1>로컬 + Google Cloud<br>확장 아키텍처</h1><p class="hero">용량 부족 관측부터 비용 근거·보안 경계·사용자 승인·유휴 종료까지</p>
<div style="height:12mm"></div><div class="grid3"><div class="panel"><strong>문서 상태</strong><p>오프라인 시뮬레이션 샘플<br>실 GCP 호출 0</p></div><div class="panel"><strong>버전 / 기준일</strong><p>v0.2 · 2026-11-10 UTC<br>견적 금액 미산정</p></div><div class="panel"><strong>승인 상태</strong><p>실제 비용 승인 없음<br>설계·출력 검증만 수행</p></div></div>
<div style="height:9mm"></div><p class="small">이 문서는 가짜 세계 실행 기록을 근거로 만든 설계 예시다. Google Cloud 프로젝트·VPC·서비스 박스는 승인 전 아키텍처 후보이며 실제 배포 증거가 아니다.</p>
<div class="footer"><span>R-GCPX · 내부 설계 샘플</span><span>01 / 06</span></div></section>
<section class="sheet" id="summary"><div class="kicker">DOCUMENT MAP / EXECUTIVE SUMMARY</div><div class="grid2"><div><h2>목차</h2><ol class="toc"><li><span>요약 · 배경 · 요구사항</span><span>02</span></li><li><span>구성도 · 계층과 경계</span><span>03</span></li><li><span>데이터 흐름 · 보안 등급</span><span>04</span></li><li><span>비용 예측 · 절감안 · 대안</span><span>05</span></li><li><span>결정 기록 · 부록 · 출처</span><span>06</span></li></ol></div>
<div><h2>요약</h2><div class="callout">기존 PC 관측이 부족을 알리면 아키텍트가 단일 GCP 확장을 제안한다. 설계 문서와 다이어그램을 검증한 뒤 사용자 비용 승인을 받는다. 승인 없는 과금 가능 동작은 차단한다.</div><p>샘플은 공개·재생성 가능 입력의 비동기 작업을 가정하며, Batch와 Spot 워커를 후보로 둔다. 가짜 세계에서는 승인 검증, 프로젝트 이벤트, 원장 lease, 유휴 종료만 실행했다.</p><p class="small">상태: 배포되지 않음 · 실제 청구 없음 · 실제 SKU 조회 없음</p></div></div>
<h2>배경</h2><p>사용자 PC의 CPU·메모리·/tmp 가용량과 기존 작업 대기열이 작업 요구량보다 부족할 수 있다. 새 수집기 없이 기존 신호를 읽고, 결측·오래된 값은 확장 근거로 쓰지 않는다.</p>
<h2>요구사항</h2><table><tr><th>설계 문</th><th>검증할 사실</th><th>실패 시</th></tr><tr><td>용량·작업 적합성</td><td>CPU/RAM/디스크/대기열·재시도 가능성·데이터 분류</td><td>로컬 유지 또는 재측정</td></tr><tr><td>비용·승인</td><td>공식 SKU 식·사용량·리전·상한·만료·제안 해시</td><td>프로비저닝 차단</td></tr><tr><td>출력·운영</td><td>편집 다이어그램·PNG·PDF 필수 절·원장·유휴 종료</td><td>승인 요청 차단</td></tr></table>
<div class="footer"><span>설계 근거: RFC-gcp-expand-architect-plugin</span><span>02 / 06</span></div></section>
<section class="sheet" id="diagram"><div class="kicker">ARCHITECTURE / TRUST & RESOURCE BOUNDARIES</div><h2>구성도</h2><img class="diagram" src="architecture.png" alt="사용자 기기, 가짜 GCP 프로젝트, 리전, VPC, 앱, 데이터, 관측, 보안 경계와 번호가 붙은 흐름">
<div class="footer"><span>도면 v0.2 · 페이지 4 흐름표와 번호 일치</span><span>03 / 06</span></div></section>
<section class="sheet" id="flows"><div class="kicker">DATA FLOW / SECURITY CONTROL</div><div class="grid2"><div><h2>데이터 흐름</h2><table><tr><th>#</th><th>출발 → 도착</th><th>상태·검증</th></tr><tr><td>1</td><td>기존 관측 → 아키텍트</td><td>실측 축·신선도 확인</td></tr><tr><td>2</td><td>아키텍트 → 편집 원본·PDF</td><td>산출물 형식 검증</td></tr><tr><td>3</td><td>산출물 → 사용자</td><td>제안 해시·지출 범위 승인</td></tr><tr><td>4</td><td>승인 → 가짜 프로젝트</td><td>시뮬: 승인 뒤에만 생성</td></tr><tr><td>5</td><td>Batch → Spot 워커</td><td>제안 전용, 실제 미배포</td></tr><tr><td>6</td><td>워커 → Storage staging</td><td>제안 전용, 실제 전송 0</td></tr><tr><td>7</td><td>워커 → 관측 서비스</td><td>제안 전용, 비용·로그 설계</td></tr><tr><td>8</td><td>관측 → 로컬 원장</td><td>제안 전용, 실 시뮬은 로컬 이벤트</td></tr></table></div>
<div><h2>보안 등급</h2><table><tr><th>등급</th><th>기본 구성·승인 문</th></tr><tr><td>공개</td><td>작업별 최소권한, 인증 진입, 관리 활동 로그. 샘플 입력은 이 등급.</td></tr><tr><td>내부</td><td>프로젝트 분리, Secret Manager 개별 접근, 비공개 진입·리전 정책 확인.</td></tr><tr><td>기밀</td><td>VPC/PSC 지원 경로, CMEK 가능 서비스·키 책임, Data Access 로그·조직 정책 검증.</td></tr><tr><td>제한/미분류</td><td>로컬 유지. 별도 반출 승인·정책·감사 증거 없으면 클라우드 차단.</td></tr></table><div class="callout"><strong>신뢰 경계:</strong> 사용자 OAuth/ADC는 PC에만 있다. 프로젝트·리전·VPC 박스는 데이터 이동과 권한을 검토할 설계 경계다. 이 시뮬은 네트워크·비밀·키를 만들지 않았다.</div></div></div>
<div class="footer"><span>데이터 분류는 사용자 소유 · 높은 등급 우선</span><span>04 / 06</span></div></section>
<section class="sheet" id="economics"><div class="kicker">COST MODEL / OPTIONS</div><div class="grid2"><div><h2>비용 예측</h2><p><strong>월 금액: 미산정.</strong> 실제 SKU 단가·사용량·청구 통화·세금·지역·조회 시각이 확보되어야 숫자를 계산한다.</p><div class="callout">월 비용 = Σ(예상 vCPU 시간 × 해당 리전 Spot vCPU SKU 단가) + Σ(예상 GiB 시간 × Spot 메모리 SKU 단가) + 디스크 + 네트워크 이그레스 + 로그·기타.</div><table><tr><th>비용 항목</th><th>현재 샘플 근거</th><th>실행 전 필요한 값</th></tr><tr><td>Spot 워커</td><td>재시도 가능 작업 가정</td><td>리전별 공식 SKU·예상 시간</td></tr><tr><td>Storage·network</td><td>설계 후보</td><td>GiB·보존기간·이그레스</td></tr><tr><td>Logging·Monitoring</td><td>관측 설계</td><td>수집·보존량과 가격</td></tr></table><p class="small">공식 Compute Engine 가격 문서와 Cloud Billing Pricing API의 단위·구간·리전을 대조한다. 공개 고정 가격이나 절감률은 약속하지 않는다.</p></div>
<div><h2>절감안</h2><ul><li>재시도·체크포인트가 가능한 비동기 작업에만 Spot 후보를 적용한다.</li><li>유휴 TTL에 컴퓨트를 종료하고 디스크·IP·로그 잔여 과금 자원을 점검한다.</li><li>짧은 HTTP 요청이면 Cloud Run 최소 인스턴스 0을 비교한다.</li><li>약정 할인은 장기 지출 승인 없이는 선택하지 않는다.</li><li>리전·스토리지·이그레스·예산 경보를 승인 카드에 함께 표시한다.</li></ul><h2>대안</h2><table><tr><th>후보</th><th>채택/거절 기준</th></tr><tr><td>로컬 정리·대기열 조절</td><td>SLA를 만족하면 우선 유지</td></tr><tr><td>Batch + Spot</td><td>재시도 가능, 중단 허용 때 후보</td></tr><tr><td>일반 VM / Cloud Run</td><td>선점 불가 / 짧은 HTTP 요청 시 비교</td></tr><tr><td>GKE Autopilot</td><td>Kubernetes 제약이 지속될 때 총비용 재계산</td></tr></table></div></div>
<div class="footer"><span>가격 문서·SKU 조회 전 금액 표기 금지</span><span>05 / 06</span></div></section>
<section class="sheet" id="appendix"><div class="kicker">DECISIONS / EVIDENCE / APPENDIX</div><div class="grid2"><div><h2>결정 기록</h2><table><tr><th>ID</th><th>결정</th><th>남은 검증</th></tr><tr><td>DR-1</td><td>비동기 재시도 작업에 Batch + Spot을 후보로 둔다.</td><td>체크포인트·중단 허용도</td></tr><tr><td>DR-2</td><td>사용자 승인 전 과금 가능 동작 0.</td><td>실 어댑터 별도 리뷰</td></tr><tr><td>DR-3</td><td>편집 원본·PNG·PDF 검증 뒤 승인 요청.</td><td>실 입력과 문서 일치</td></tr><tr><td>DR-4</td><td>예산 경보는 지출 차단 장치로 취급하지 않는다.</td><td>잔여 자원·유휴 종료 관측</td></tr></table></div>
<div><h2>부록 A · 재현과 판정</h2><p>샘플 파일: architecture.excalidraw, architecture.png, architecture-design.html, architecture-design.pdf, fake-world.json. 편집 원본과 PNG는 diagram-master의 Excalidraw 경로, PDF는 기존 HTML→PDF 경로로 생성했다.</p><p>가짜 세계 결과: 무승인 실행 차단, 가짜 프로젝트 1, 비용 이벤트 3, 종료 후 활성 lease 0, 실제 GCP 호출 0.</p><h3>공식 출처 · 확인 2026-11-10 UTC</h3><p class="source">Google Cloud 제품 아이콘: https://cloud.google.com/icons<br>Google Cloud 참조 아키텍처: https://docs.cloud.google.com/architecture/blueprints/enterprise-application-blueprint/architecture<br>AWS 공식 아키텍처 아이콘 스타일 참고: https://aws.amazon.com/architecture/icons/<br>Compute Engine 가격: https://cloud.google.com/compute/all-pricing<br>Cloud Billing Pricing API: https://docs.cloud.google.com/billing/docs/how-to/get-pricing-information-api</p><p class="small">시각 표기 방식만 참조했다. AWS 아이콘은 사용하지 않았다.</p></div></div>
<div class="footer"><span>R-GCPX · 샘플 소스와 검증 결과는 PR에 포함</span><span>06 / 06</span></div></section>
</body></html>'''
if proposal:
    design = proposal["ticketDesign"]
    esc = html_escape.escape
    requirements = "<br>".join(esc(value) for value in design["requirements"])
    assumptions = design.get("assumptions", [])
    if assumptions:
        labels = "; ".join(f"{esc(str(item['field']))}={esc(str(item['value']))}"
                           for item in assumptions)
        html = html.replace("<h2>요구사항</h2>",
            "<h2>요구사항</h2><p class='small'><strong>미확인 설계 가정 · 출처: GCP 어댑터 기본값:</strong> "
            + labels + ". 실제 데이터 이동·지출 전에 사용자 확인이 필요하다.</p>", 1)
    html = html.replace("로컬 + Google Cloud<br>확장 아키텍처", f"{esc(design['title'])}<br>GCP 확장 아키텍처")
    html = html.replace("샘플은 공개·재생성 가능 입력의 비동기 작업을 가정하며, Batch와 Spot 워커를 후보로 둔다.",
        f"{esc(design['title'])}의 구매 경로는 로컬에 유지하고, {esc(design['offloadWorkload'])}만 Batch·Spot 후보로 둔다.")
    html = html.replace("<h2>배경</h2>", f"<h2>배경</h2><p><strong>티켓팅 설계 입력:</strong> {esc(design['summary'])} "
        f"클라우드 반출 대상은 {esc(design['exportData'])}이며, 데이터 등급은 {esc(design['dataClass'])}다.</p>")
    html = html.replace("<h2>부록 A · 재현과 판정</h2>",
        f"<h2>부록 A · 재현과 판정</h2><p><strong>설계 입력 요구:</strong> {requirements}</p>"
        f"<p class='small'>입력 설계 SHA-256: {esc(proposal['inputSha256'])} "
        f"· 제안 ID: {esc(proposal['id'])} · 입력 출처 선언: {esc(design['sourceKind'])}</p>")
    html = html.replace("<h2>비용 예측</h2>",
        f"<h2>비용 예측</h2><p><strong>기본 리전:</strong> {esc(proposal['region'])} (서울). "
        f"<strong>비교 리전:</strong> {esc(proposal['comparisonRegion'])} (아이오와). "
        "동일 사용량에 리전별 공식 SKU 단가와 이그레스·데이터 위치·지연을 대입해 비교한다. 단가 조회 전 우열·금액은 미산정.</p>")
    html = html.replace("Cloud Billing Pricing API: https://docs.cloud.google.com/billing/docs/how-to/get-pricing-information-api",
        "Cloud Billing Pricing API: https://docs.cloud.google.com/billing/docs/how-to/get-pricing-information-api"
        "<br>공식 리전 목록: https://docs.cloud.google.com/compute/docs/regions-zones")
if audience == "user":
    # User deliverables describe an unprovisioned design, not the internal fake-world machinery.
    html = html.replace("가짜 프로젝트", "프로젝트 후보").replace("가짜 세계", "오프라인 검증")
    html = html.replace("가짜 lease", "시뮬레이션 lease")
    html = html.replace("오프라인 시뮬레이션 샘플", "승인 전 오프라인 설계 제안")
(OUT / "architecture-design.html").write_text(html, encoding="utf8")

fake_command = ["bun", str(ROOT / "scripts/gcp-architect-expand/sim/fake-world.ts")]
if args.proposal:
    fake_command.extend(["--proposal", str(args.proposal.resolve())])
fake = subprocess.run(fake_command,
    capture_output=True, text=True, check=True)
(OUT / "fake-world.json").write_text(fake.stdout, encoding="utf8")

python = sys.executable
subprocess.run([python, str(ROOT / "skills/diagram-master/references/engines/excalidraw/render_excalidraw.py"),
    str(OUT / "architecture.excalidraw")], check=True)
subprocess.run([python, str(ROOT / "skills/lecture-note-digitizer/references/convert_to_pdf.py"),
    str(OUT / "architecture-design.html")], check=True)
print(OUT)
