"""Mermaid 다이어그램을 고품질 PNG로 렌더링 (단일 포맷 전용)

사용법:
    cd references
    uv run python render_mermaid.py diagram.mmd [--output output.png] [--scale 3]

처음 실행 전:
    uv sync
    uv run playwright install chromium
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def render(mmd_path: Path, output_path: Path | None = None, scale: int = 3):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright not installed.")
        print("Run: uv sync && uv run playwright install chromium")
        sys.exit(1)

    if output_path is None:
        output_path = mmd_path.with_suffix(".png")

    # Mermaid Live Editor 스타일 template (classDef/ELK 완벽 지원)
    html_content = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
  <style>
    body { margin:0; padding:40px; background:#ffffff; font-family:sans-serif; }
    #diagram { max-width:100%; }
    #diagram .nodeLabel { white-space: pre-wrap !important; max-width: 500px !important; }
  </style>
</head>
<body>
  <div id="diagram"></div>
  <script>
    mermaid.initialize({
      startOnLoad: true,
      theme: 'base',
      flowchart: { curve: 'linear' },
      securityLevel: 'loose'
    });
    window.renderMermaid = async function(code) {
      try {
        const { svg } = await mermaid.render('mermaid-diagram', code);
        document.getElementById('diagram').innerHTML = svg;
        return { success: true };
      } catch(e) {
        return { success: false, error: e.message };
      }
    };
  </script>
</body>
</html>"""

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(
            device_scale_factor=scale,
            viewport={"width": 1600, "height": 1200},
        )

        # 임시 HTML 생성
        temp_html = mmd_path.parent / "temp_mermaid_render.html"
        temp_html.write_text(html_content, encoding="utf-8")

        page.goto(temp_html.as_uri())
        page.wait_for_timeout(1000)

        mermaid_code = mmd_path.read_text(encoding="utf-8")

        # backtick 이스케이프 처리
        escaped_code = mermaid_code.replace("\\", "\\\\").replace("`", "\\`").replace("$", "\\$")
        result = page.evaluate(f"window.renderMermaid(`{escaped_code}`)")

        if not result.get("success"):
            print(f"Render error: {result.get('error')}")
            browser.close()
            temp_html.unlink(missing_ok=True)
            return None

        # SVG 스크린샷 (고해상도 — device_scale_factor로 처리)
        svg_el = page.query_selector("#diagram svg")
        if svg_el:
            svg_el.screenshot(path=str(output_path))
            print(f"✅ 성공: {output_path}")
        else:
            print("SVG element not found")
            output_path = None

        browser.close()
        temp_html.unlink(missing_ok=True)

    return output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Mermaid 다이어그램을 고품질 PNG로 렌더링")
    parser.add_argument("input", type=Path, help=".mmd 파일 경로")
    parser.add_argument("--output", "-o", type=Path, default=None, help="출력 PNG 경로")
    parser.add_argument("--scale", "-s", type=int, default=3, help="렌더링 스케일 (기본값: 3)")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"파일 없음: {args.input}")
        sys.exit(1)

    render(args.input, args.output, args.scale)
