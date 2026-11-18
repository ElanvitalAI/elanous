#!/usr/bin/env python3
"""Reflow an existing app design with the bundled Bookforge renderer.

The source is never changed. A failed build or QC gate never yields a final PDF.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

UPSTREAM_REVISION = "3f1e85ee501f5984acb8cd6d92ecb7a4c3fb5374"
ENGINE = Path(__file__).resolve().parent / "vendor" / "bookforge"
MAX_SOURCE_BYTES = 128 * 1024


def sections(markdown: str):
    """Keep a short app design in one chapter so QC does not require filler pages."""
    title = next((line[2:].strip() for line in markdown.splitlines()
                  if line.startswith("# ")), "설계 문서")
    if not markdown.strip():
        return []
    # The upstream contents builder treats inner Markdown headings as chapter
    # sections, then prints one page number for each; compact app docs make
    # that number disagree with the real page. Keep their words as bold labels.
    body = re.sub(r"(?m)^#{2,6}\s+(.+?)\s*$", r"**\1**", markdown.strip())
    return [(title, body)]


def check_dependencies():
    typst = shutil.which("typst")
    if not typst:
        return "Typst 0.14.x is required. Install Typst 0.14.x and retry."
    version = subprocess.run([typst, "--version"], capture_output=True, text=True, timeout=10)
    if version.returncode != 0 or not re.search(r"\b0\.14\.\d+\b", version.stdout):
        return "Typst 0.14.x is required; the installed typst version is unsupported."
    try:
        import pymupdf  # noqa: F401
        import markdown_it  # noqa: F401
    except ImportError:
        return "Python packages PyMuPDF and markdown-it-py are required: python3 -m pip install pymupdf markdown-it-py"
    return None


def run_script(name: str, project: Path):
    result = subprocess.run([sys.executable, str(ENGINE / "scripts" / name), str(project)],
                            capture_output=True, text=True, timeout=180)
    return result.returncode, (result.stderr or result.stdout)[-2000:]


def render(design_path: Path, out_dir: Path, title: str):
    if not design_path.is_absolute() or not out_dir.is_absolute():
        raise ValueError("designPath and outDir must be absolute")
    if design_path.is_symlink() or not design_path.is_file() or design_path.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("designPath must be a regular Markdown file of at most 128 KiB")
    if design_path.suffix.lower() != ".md":
        raise ValueError("designPath must end in .md")
    if not title or len(title) > 120 or any(ch in title for ch in "\r\n\0"):
        raise ValueError("title must be one nonempty line of at most 120 characters")
    missing = check_dependencies()
    if missing:
        return {"ok": False, "error": missing}
    source = design_path.read_bytes()
    markdown = source.decode("utf-8")
    chapters = sections(markdown)
    if not chapters:
        raise ValueError("designPath contains no design content")
    project = out_dir / "bookforge-project"
    if project.exists():
        raise ValueError("outDir/bookforge-project already exists; choose a fresh outDir")
    out_dir.mkdir(parents=True, exist_ok=True)
    scaffold = subprocess.run([sys.executable, str(ENGINE / "scripts" / "scaffold.py"), str(project),
                               "--style", "business", "--title", title, "--length", "short",
                               "--author", "Elanous"], capture_output=True, text=True, timeout=30)
    if scaffold.returncode != 0:
        return {"ok": False, "error": "Bookforge scaffold failed: " + scaffold.stderr[-1000:]}
    outline = []
    for number, (heading, body) in enumerate(chapters, 1):
        filename = f"ch-{number:02d}.md"
        safe_heading = heading.replace("\n", " ").strip()
        (project / "chapters" / filename).write_text(f"# {safe_heading}\n\n{body}\n", encoding="utf-8")
        summary = next((line.strip() for line in body.splitlines()
                        if line.strip() and not line.startswith(("#", "```", "|"))
                        and not re.fullmatch(r"\*\*[^*]+\*\*", line.strip())), safe_heading)
        outline.append({"file": filename, "title": safe_heading,
                        "summary": summary[:160], "toc_line": safe_heading})
    (project / "outline.json").write_text(json.dumps({"chapters": outline}, ensure_ascii=False, indent=2), encoding="utf-8")
    (project / "source-provenance.json").write_text(json.dumps({
        "sourcePath": str(design_path), "sourceSha256": hashlib.sha256(source).hexdigest(),
        "upstream": "https://github.com/gongnyang/bookforge", "upstreamRevision": UPSTREAM_REVISION,
        "license": "MIT; bundled fonts use OFL 1.1"}, ensure_ascii=False, indent=2), encoding="utf-8")
    code, detail = run_script("build.py", project)
    if code != 0:
        return {"ok": False, "error": "Bookforge render failed: " + detail, "projectPath": str(project)}
    code, detail = run_script("qc_gate.py", project)
    final = sorted((project / "final").glob("*.pdf")) if (project / "final").exists() else []
    if code != 0 or len(final) != 1:
        return {"ok": False, "error": "Bookforge QC gate failed: " + detail,
                "projectPath": str(project), "gateReportPath": str(project / "gate-report.json")}
    return {"ok": True, "pdfPath": str(final[0]), "projectPath": str(project),
            "sourceSha256": hashlib.sha256(source).hexdigest(), "visualReviewRequired": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--design", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--title", required=True)
    args = parser.parse_args()
    try:
        result = render(Path(args.design), Path(args.out), args.title)
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired) as error:
        result = {"ok": False, "error": str(error)}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
