"""Extract specific slides from PDF as high-quality PNG images.

Usage:
    python extract_slide_diagram.py input.pdf --page 11
    python extract_slide_diagram.py input.pdf --page 11 --output diagram.png
    python extract_slide_diagram.py input.pdf --page 11 --crop "5,15,90,70"
    python extract_slide_diagram.py input.pdf --pages 9,11,19,20

Crop: percentage coordinates "left,top,width,height" (0-100).
DPI: default 300 for high quality. Use --dpi 450 for extra sharp.
"""
import argparse
import sys
from pathlib import Path


def extract_page(pdf_path: Path, page_num: int, output_path: Path,
                 crop: str | None = None, dpi: int = 300):
    import fitz  # PyMuPDF

    doc = fitz.open(str(pdf_path))
    if page_num < 1 or page_num > len(doc):
        print(f"Page {page_num} out of range (1-{len(doc)})")
        return None

    page = doc[page_num - 1]  # 0-indexed
    mat = fitz.Matrix(dpi / 72, dpi / 72)

    clip = None
    if crop:
        parts = [float(x) for x in crop.split(",")]
        r = page.rect
        clip = fitz.Rect(
            r.x0 + parts[0] / 100 * r.width,
            r.y0 + parts[1] / 100 * r.height,
            r.x0 + (parts[0] + parts[2]) / 100 * r.width,
            r.y0 + (parts[1] + parts[3]) / 100 * r.height,
        )

    pix = page.get_pixmap(matrix=mat, clip=clip)

    pix.save(str(output_path))
    doc.close()
    print(f"✅ Page {page_num} → {output_path} ({pix.width}x{pix.height}px)")
    return output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PDF 슬라이드에서 다이어그램 추출")
    parser.add_argument("input", type=Path, help="PDF 파일 경로")
    parser.add_argument("--page", "-p", type=int, default=None, help="추출할 페이지 번호")
    parser.add_argument("--pages", type=str, default=None, help="여러 페이지 (쉼표 구분: 9,11,19)")
    parser.add_argument("--output", "-o", type=Path, default=None, help="출력 PNG 경로")
    parser.add_argument("--crop", "-c", type=str, default=None,
                        help="크롭 영역 (%%): left,top,width,height")
    parser.add_argument("--dpi", type=int, default=300, help="렌더링 DPI (기본: 300)")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"파일 없음: {args.input}")
        sys.exit(1)

    if args.pages:
        page_nums = [int(p.strip()) for p in args.pages.split(",")]
        for pn in page_nums:
            out = args.input.with_name(f"{args.input.stem}_page{pn}.png")
            extract_page(args.input, pn, out, args.crop, args.dpi)
    elif args.page:
        out = args.output or args.input.with_name(f"{args.input.stem}_page{args.page}.png")
        extract_page(args.input, args.page, out, args.crop, args.dpi)
    else:
        print("--page 또는 --pages 옵션을 지정해주세요")
        sys.exit(1)
