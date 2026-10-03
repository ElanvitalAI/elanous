#!/usr/bin/env python3
"""
Matplotlib 렌더러 — diagram-master 스킬용.

사용법:
  # Python 스크립트 파일 렌더링
  uv run python render_matplotlib.py chart.py

  # 출력 경로 지정
  uv run python render_matplotlib.py chart.py --output /path/to/output.png

  # DPI 변경 (기본 300)
  uv run python render_matplotlib.py chart.py --dpi 150

  # 크기 변경 (기본 10x6 인치)
  uv run python render_matplotlib.py chart.py --figsize 12 8

  # 다크 테마
  uv run python render_matplotlib.py chart.py --style dark_background

chart.py 작성 규칙:
  - fig, ax 변수를 사용하거나 plt 직접 사용
  - plt.savefig() / plt.show() 호출 금지 (렌더러가 처리)
  - 한글은 자동 지원 (시스템 폰트 탐지)
"""

import argparse
import sys
import textwrap
from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # 비-GUI 백엔드

import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
import numpy as np  # noqa: F401 — 스크립트에서 사용 가능하도록


def setup_korean_font():
    """시스템에서 한글 폰트를 자동 탐지하여 설정."""
    korean_fonts = [
        "Apple SD Gothic Neo",       # macOS
        "AppleGothic",               # macOS fallback
        "Noto Sans KR",              # Cross-platform
        "NanumGothic",               # Korean standard
        "Malgun Gothic",             # Windows
        "NanumBarunGothic",
    ]

    available = {f.name for f in fm.fontManager.ttflist}

    for font_name in korean_fonts:
        if font_name in available:
            plt.rcParams["font.family"] = font_name
            plt.rcParams["axes.unicode_minus"] = False
            return font_name

    # fallback: sans-serif에 추가
    for font_name in korean_fonts:
        if font_name in available:
            plt.rcParams["font.sans-serif"] = [font_name] + plt.rcParams["font.sans-serif"]
            plt.rcParams["axes.unicode_minus"] = False
            return font_name

    return None


def setup_style(style: str | None):
    """Matplotlib 스타일 설정."""
    if style:
        plt.style.use(style)
    else:
        # 깔끔한 기본 스타일
        plt.rcParams.update({
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "axes.grid": True,
            "grid.alpha": 0.3,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "font.size": 12,
            "axes.titlesize": 14,
            "axes.labelsize": 12,
        })


def render(script_path: str, output: str | None = None, dpi: int = 300,
           figsize: tuple[float, float] | None = None, style: str | None = None) -> str:
    """Python 스크립트를 실행하여 PNG로 렌더링."""
    script = Path(script_path)
    if not script.exists():
        print(f"Error: {script_path} not found", file=sys.stderr)
        sys.exit(1)

    # 한글 폰트 설정
    korean_font = setup_korean_font()
    if korean_font:
        print(f"Korean font: {korean_font}")

    # 스타일 설정
    setup_style(style)

    # figsize 설정
    if figsize:
        plt.rcParams["figure.figsize"] = figsize

    # 스크립트 실행을 위한 네임스페이스 준비
    namespace = {
        "plt": plt,
        "np": np,
        "fig": None,
        "ax": None,
        "__name__": "__main__",
    }

    # fig, ax 자동 생성 (스크립트에서 직접 만들지 않으면 사용됨)
    code = script.read_text(encoding="utf-8")

    # 스크립트에서 plt.figure/plt.subplots를 호출하지 않으면 자동 생성
    if "plt.figure" not in code and "plt.subplots" not in code and "fig" not in code:
        fig_size = figsize or (10, 6)
        fig, ax = plt.subplots(figsize=fig_size)
        namespace["fig"] = fig
        namespace["ax"] = ax

    # 스크립트 실행
    try:
        exec(compile(code, str(script), "exec"), namespace)
    except Exception as e:
        print(f"Error executing {script_path}: {e}", file=sys.stderr)
        sys.exit(1)

    # 출력 경로 결정
    if output:
        out_path = Path(output)
    else:
        out_path = script.with_suffix(".png")

    # 현재 figure 저장
    current_fig = plt.gcf()
    if current_fig.get_axes():
        current_fig.savefig(
            str(out_path),
            dpi=dpi,
            bbox_inches="tight",
            pad_inches=0.2,
            facecolor=current_fig.get_facecolor(),
            edgecolor="none",
        )
        plt.close("all")
        print(f"Saved: {out_path} ({dpi} DPI)")
        return str(out_path)
    else:
        print("Warning: No plot was created by the script", file=sys.stderr)
        plt.close("all")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Matplotlib 렌더러 — Python 스크립트를 PNG로 변환",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            예시:
              uv run python render_matplotlib.py supply_demand.py
              uv run python render_matplotlib.py dist.py --dpi 150 --style seaborn-v0_8
              uv run python render_matplotlib.py chart.py --figsize 12 8 --output result.png
        """),
    )
    parser.add_argument("script", help="렌더링할 Python 스크립트 경로")
    parser.add_argument("--output", "-o", help="출력 PNG 경로 (기본: 스크립트명.png)")
    parser.add_argument("--dpi", type=int, default=300, help="DPI (기본: 300)")
    parser.add_argument("--figsize", nargs=2, type=float, metavar=("W", "H"),
                        help="Figure 크기 (인치, 기본: 10 6)")
    parser.add_argument("--style", help="Matplotlib 스타일 (e.g., dark_background, seaborn-v0_8)")

    args = parser.parse_args()
    figsize = tuple(args.figsize) if args.figsize else None
    render(args.script, args.output, args.dpi, figsize, args.style)


if __name__ == "__main__":
    main()
