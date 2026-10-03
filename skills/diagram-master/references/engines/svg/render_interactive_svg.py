"""Render Interactive SVG HTML to PNG using Playwright + headless Chromium.

Usage:
    cd references
    uv run python render_interactive_svg.py diagram.html [--output diagram.png] [--scale 2] [--width 1920] [--capture-states]

--capture-states 옵션을 주면:
- diagram.png          (기본 상태)
- diagram-hover.png    (주요 요소 hover 상태)
- diagram-detail.png   (Evidence Artifact 클릭 상태)
총 3개 PNG를 생성하여 시각적 검증을 강력하게 지원합니다.

First-time setup:
    cd references
    uv sync
    uv run playwright install chromium
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path


def validate_interactive_html(data: str) -> list[str]:
    """HTML이 interactive SVG 다이어그램으로 적합한지 간단 검증"""
    errors: list[str] = []

    if not data.strip():
        errors.append("HTML 파일이 비어있습니다")

    if "<svg" not in data.lower():
        errors.append("SVG 요소를 찾을 수 없습니다. interactive-svg-diagram skill로 생성된 HTML인가요?")

    if "tailwind" not in data.lower() and "style" not in data.lower():
        errors.append("Tailwind 또는 인라인 스타일이 부족합니다. 제대로 된 HTML인가요?")

    return errors


def compute_viewport_size(page) -> tuple[int, int]:
    """페이지 로드 후 실제 SVG 크기에 맞춰 viewport 계산"""
    try:
        dimensions = page.evaluate("""() => {
            const svg = document.querySelector('svg');
            const container = document.getElementById('diagram-container') ||
                            document.getElementById('diagram') ||
                            document.getElementById('root') ||
                            document.body;

            const rect = svg ? svg.getBoundingClientRect() : container.getBoundingClientRect();
            return {
                width: Math.ceil(rect.width) + 120,
                height: Math.ceil(rect.height) + 80
            };
        }""")

        width = min(dimensions["width"], 2400)
        height = dimensions["height"]

        return width, max(height, 600)
    except Exception:
        return 1600, 900


def take_screenshot(page, output_path: Path, label: str = "base"):
    """스크린샷 촬영 + 간단한 안내 출력"""
    page.screenshot(path=str(output_path), full_page=False)
    print(f"  {label}: {output_path.name}")


def render(
    html_path: Path,
    output_path: Path | None = None,
    scale: int = 2,
    max_width: int = 1920,
    capture_states: bool = False,
) -> list[Path]:
    """Interactive HTML을 PNG로 렌더링"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright not installed.", file=sys.stderr)
        print("Run: cd references && uv sync && uv run playwright install chromium", file=sys.stderr)
        sys.exit(1)

    raw_html = html_path.read_text(encoding="utf-8")
    errors = validate_interactive_html(raw_html)
    if errors:
        print("ERROR: Invalid interactive diagram HTML:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

    if output_path is None:
        output_path = html_path.with_suffix(".png")

    png_files: list[Path] = []

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception as e:
            if "Executable doesn't exist" in str(e):
                print("ERROR: Chromium not installed.", file=sys.stderr)
                print("Run: uv run playwright install chromium", file=sys.stderr)
                sys.exit(1)
            raise

        page = browser.new_page(
            viewport={"width": max_width, "height": 1200},
            device_scale_factor=scale,
        )

        page.goto(html_path.as_uri())
        page.wait_for_load_state("networkidle", timeout=15000)
        page.wait_for_selector("svg", timeout=10000)

        # Wait for render complete signal
        try:
            page.wait_for_function(
                "window.__renderComplete === true || window.__diagramReady === true",
                timeout=10000,
            )
        except Exception:
            # If no signal, just wait a bit for rendering to settle
            pass

        # Viewport 최적화
        vp_width, vp_height = compute_viewport_size(page)
        page.set_viewport_size({"width": vp_width, "height": vp_height})

        time.sleep(0.8)  # animation settle

        # 기본 상태
        base_path = output_path
        take_screenshot(page, base_path, "Base")
        png_files.append(base_path)

        # Interactive states
        if capture_states:
            stem = html_path.stem

            # Hover
            try:
                hover_elements = page.query_selector_all(
                    "g[role='button'], .interactive-node, [data-interactive='true'], rect"
                )
                if hover_elements:
                    hover_elements[0].hover()
                    time.sleep(0.6)
                    hover_path = html_path.with_name(f"{stem}-hover.png")
                    take_screenshot(page, hover_path, "Hover")
                    png_files.append(hover_path)
            except Exception as e:
                print(f"  Hover capture skipped: {e}")

            # Detail (Evidence click)
            try:
                detail_elements = page.query_selector_all(
                    ".evidence-artifact, .artifact, [data-evidence='true'], [data-interactive='true']"
                )
                if detail_elements and len(detail_elements) > 0:
                    # Click the first evidence element
                    target = detail_elements[min(1, len(detail_elements) - 1)]
                    target.click()
                    time.sleep(1.0)
                    detail_path = html_path.with_name(f"{stem}-detail.png")
                    take_screenshot(page, detail_path, "Detail")
                    png_files.append(detail_path)
            except Exception as e:
                print(f"  Detail capture skipped: {e}")

        browser.close()

    print(f"\nRender completed! Generated {len(png_files)} PNG file(s).")
    for f in png_files:
        print(f"  {f}")
    return png_files


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render Interactive SVG HTML diagram to PNG (with interaction states)"
    )
    parser.add_argument("input", type=Path, help="Path to diagram.html file")
    parser.add_argument("--output", "-o", type=Path, default=None, help="Base output PNG path")
    parser.add_argument("--scale", "-s", type=int, default=2, help="Device scale factor (default: 2)")
    parser.add_argument("--width", "-w", type=int, default=1920, help="Max viewport width (default: 1920)")
    parser.add_argument(
        "--capture-states",
        "-c",
        action="store_true",
        help="Capture hover and detail (clicked) states as well (recommended for validation)",
    )

    args = parser.parse_args()

    if not args.input.exists():
        print(f"ERROR: File not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    if not args.input.suffix.lower() == ".html":
        print("WARNING: Input is not .html file. Make sure it's the output of interactive-svg-diagram skill.")

    render(args.input, args.output, args.scale, args.width, args.capture_states)


if __name__ == "__main__":
    main()
