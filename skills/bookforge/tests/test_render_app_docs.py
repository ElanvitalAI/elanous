import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "render_app_docs.py"
SPEC = importlib.util.spec_from_file_location("bookforge_app_docs", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BookforgeAppDocsTest(unittest.TestCase):
    def test_reflow_uses_only_existing_headings_and_body(self):
        source = "# 서비스 설계\n\n## context — 맥락\n실제 사용자 흐름.\n\n## api — API\nGET /items\n"
        parts = MODULE.sections(source)
        self.assertEqual([heading for heading, _ in parts], ["서비스 설계"])
        self.assertIn("## context — 맥락\n실제 사용자 흐름.", parts[0][1])
        self.assertIn("## api — API\nGET /items", parts[0][1])

    def test_inner_headings_are_demoted_before_vendor_build(self):
        source = "# 서비스 설계\n\n## 배경\n실제 사용자 흐름.\n\n### 세부\n그대로.\n"
        kept = MODULE.sections(source)[0][1]
        self.assertIn("## 배경\n실제 사용자 흐름.", kept)
        prepared = MODULE.prepare_chapter(f"# 서비스 설계\n\n{kept}")
        self.assertIn("### 배경\n실제 사용자 흐름.", prepared)
        self.assertNotRegex(prepared, r"(?m)^## ")
        self.assertIn("### 세부\n그대로.", prepared)
        self.assertFalse((SCRIPT.parent / "app_docs_build.py").exists())

    def test_nine_architecture_sections_stay_on_their_own_lines(self):
        body = "\n\n".join(f"## {name}\n이 절의 본문은 스무 글자를 넘긴다." for name in MODULE.NINE_SECTIONS)
        parts = MODULE.sections(f"# 설계\n\n{body}\n")
        kept = parts[0][1]
        for name in MODULE.NINE_SECTIONS:
            self.assertIn(f"## {name}\n", kept)
            self.assertNotIn(f"**{name}**", kept)

    def test_missing_typst_fails_before_creating_output(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "ARCHITECTURE.md"
            source.write_text("## 설계\n실제 내용\n", encoding="utf-8")
            output = Path(root) / "pdf"
            with patch.object(MODULE, "check_dependencies", return_value="Typst 0.14.x is required"):
                result = MODULE.render(source, output, "서비스 설계")
            self.assertFalse(result["ok"])
            self.assertIn("Typst 0.14.x", result["error"])
            self.assertFalse(output.exists())

    def test_typst_renders_one_pdf_with_at_least_one_page(self):
        if MODULE.check_dependencies():
            self.skipTest(MODULE.check_dependencies())
        body = "\n\n".join(
            f"## {name}\n이 절의 본문은 스무 글자를 넘긴다." for name in MODULE.NINE_SECTIONS)
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "ARCHITECTURE.md"
            source.write_text(f"# 설계\n\n{body}\n", encoding="utf-8")
            result = MODULE.render(source, Path(root) / "pdf", "설계")
            self.assertTrue(result["ok"], result.get("error"))
            pdf = Path(result["pdfPath"])
            self.assertTrue(pdf.is_file())
            self.assertGreaterEqual(result["pageCount"], 1)
            self.assertEqual(MODULE.pdf_page_count(pdf), result["pageCount"])
            self.assertGreaterEqual(pdf.stat().st_size, 5)
            self.assertTrue(pdf.read_bytes().startswith(b"%PDF-"))


if __name__ == "__main__":
    unittest.main()
