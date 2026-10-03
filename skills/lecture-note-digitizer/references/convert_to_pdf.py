"""Convert integrated lecture notes HTML to PDF using Playwright."""
import sys
from pathlib import Path

def main():
    html_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not html_path or not html_path.exists():
        print(f"Usage: python convert_to_pdf.py <html_file>")
        sys.exit(1)

    pdf_path = html_path.with_suffix(".pdf")

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(f"file://{html_path.resolve()}")
        page.wait_for_timeout(2000)
        page.pdf(
            path=str(pdf_path),
            format="A4",
            margin={"top": "15mm", "bottom": "15mm",
                    "left": "15mm", "right": "15mm"},
            print_background=True,
        )
        browser.close()
    print(pdf_path)

if __name__ == "__main__":
    main()
