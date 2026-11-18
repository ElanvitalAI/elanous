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
        self.assertIn("**context — 맥락**\n실제 사용자 흐름.", parts[0][1])
        self.assertIn("**api — API**\nGET /items", parts[0][1])

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


if __name__ == "__main__":
    unittest.main()
