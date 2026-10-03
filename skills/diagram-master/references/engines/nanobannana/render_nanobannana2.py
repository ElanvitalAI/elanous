#!/usr/bin/env python3
"""
Nano Banana 2 렌더러 — diagram-master 스킬용.

Gemini 3.1 Flash Image Preview (gemini-3.1-flash-image-preview) 모델을 사용하여
텍스트 프롬프트로 다이어그램/인포그래픽/시각화를 생성.

사용법:
  # 텍스트 프롬프트로 다이어그램 생성
  uv run python render_nanobannana2.py "수요 공급 곡선 다이어그램, 균형점 표시" --output supply_demand.png

  # 프롬프트 파일에서 읽기
  uv run python render_nanobannana2.py --file prompt.txt --output diagram.png

  # 참고 이미지 + 프롬프트 (PDF에서 추출한 이미지를 참고하여 재생성)
  uv run python render_nanobannana2.py "이 다이어그램을 깔끔하게 다시 그려줘" --ref original.png --output clean.png

  # 4K 해상도
  uv run python render_nanobannana2.py "IS-LM 모델" --output islm.png --aspect 16:9

환경변수:
  GEMINI_API_KEY 또는 GOOGLE_API_KEY (환경변수에서 탐색)
"""

import argparse
import base64
import os
import sys
import textwrap
from pathlib import Path


def find_api_key() -> str:
    """Read the user's Gemini credential from the process environment."""
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if key:
        return key

    print("Error: GEMINI_API_KEY not found in the environment.", file=sys.stderr)
    sys.exit(1)


def build_diagram_prompt(user_prompt: str) -> str:
    """다이어그램 생성에 최적화된 시스템 프롬프트 구성."""
    return (
        "You are a professional diagram and infographic designer. "
        "Create a clean, publication-quality diagram based on the following description. "
        "Rules:\n"
        "- Use clear labels and annotations\n"
        "- Use a clean white background unless specified otherwise\n"
        "- Use semantic colors (blue for primary, red for important, green for success)\n"
        "- Ensure all text is legible and properly sized\n"
        "- Include a title at the top\n"
        "- Use professional, modern design aesthetics\n"
        "- If mathematical equations are involved, render them correctly\n"
        "- For Korean text, use clean sans-serif Korean typography\n\n"
        f"Diagram request: {user_prompt}"
    )


def render(prompt: str, output: str, ref_image: str | None = None,
           aspect: str | None = None) -> str:
    """Nano Banana 2로 다이어그램 생성."""
    import google.generativeai as genai

    api_key = find_api_key()
    genai.configure(api_key=api_key)

    model = genai.GenerativeModel("gemini-3.1-flash-image-preview")

    # 프롬프트 구성
    full_prompt = build_diagram_prompt(prompt)

    # 생성 설정
    gen_config = genai.types.GenerationConfig(
        response_modalities=["image", "text"],
    )

    # 참고 이미지가 있으면 멀티모달 입력
    contents = []
    if ref_image:
        ref_path = Path(ref_image)
        if not ref_path.exists():
            print(f"Error: Reference image {ref_image} not found", file=sys.stderr)
            sys.exit(1)

        # 이미지 MIME 타입 판단
        suffix = ref_path.suffix.lower()
        mime_map = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                    ".webp": "image/webp", ".gif": "image/gif"}
        mime = mime_map.get(suffix, "image/png")

        img_data = ref_path.read_bytes()
        contents = [
            {"mime_type": mime, "data": img_data},
            full_prompt,
        ]
    else:
        contents = [full_prompt]

    # 생성
    try:
        response = model.generate_content(contents, generation_config=gen_config)
    except Exception as e:
        print(f"Error generating image: {e}", file=sys.stderr)
        sys.exit(1)

    # 이미지 추출 및 저장
    out_path = Path(output)
    saved = False

    if response.candidates:
        for part in response.candidates[0].content.parts:
            if hasattr(part, "inline_data") and part.inline_data:
                img_bytes = part.inline_data.data
                out_path.write_bytes(img_bytes)
                saved = True
                print(f"Saved: {out_path}")
                break

    if not saved:
        # text response만 온 경우
        if response.text:
            print(f"Model returned text instead of image:\n{response.text[:500]}", file=sys.stderr)
        else:
            print("Error: No image generated", file=sys.stderr)
        sys.exit(1)

    return str(out_path)


def main():
    parser = argparse.ArgumentParser(
        description="Nano Banana 2 렌더러 — AI 다이어그램 생성",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            예시:
              uv run python render_nanobannana2.py "수요 공급 곡선 다이어그램"
              uv run python render_nanobannana2.py "IS-LM 모델" --output islm.png
              uv run python render_nanobannana2.py "이 다이어그램을 깔끔하게 재생성" --ref original.png
              uv run python render_nanobannana2.py --file prompt.txt --output result.png
        """),
    )
    parser.add_argument("prompt", nargs="?", help="다이어그램 설명 프롬프트")
    parser.add_argument("--file", "-f", help="프롬프트를 파일에서 읽기")
    parser.add_argument("--output", "-o", default="diagram.png", help="출력 PNG 경로 (기본: diagram.png)")
    parser.add_argument("--ref", help="참고 이미지 경로 (PDF 추출 이미지 등)")
    parser.add_argument("--aspect", help="종횡비 (예: 16:9, 1:1, 4:3)")

    args = parser.parse_args()

    # 프롬프트 결정
    if args.file:
        prompt = Path(args.file).read_text(encoding="utf-8").strip()
    elif args.prompt:
        prompt = args.prompt
    else:
        parser.error("프롬프트 또는 --file 옵션이 필요합니다")
        return

    if args.aspect:
        prompt += f"\n\nAspect ratio: {args.aspect}"

    render(prompt, args.output, args.ref, args.aspect)


if __name__ == "__main__":
    main()
