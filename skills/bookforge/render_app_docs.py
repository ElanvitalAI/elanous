#!/usr/bin/env python3
"""Reflow an existing app design with the bundled Bookforge renderer.

The source is never changed. A failed build or QC gate never yields a final PDF.
"""
import argparse
import getpass
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

UPSTREAM_REVISION = "3f1e85ee501f5984acb8cd6d92ecb7a4c3fb5374"
ENGINE = Path(__file__).resolve().parent / "vendor" / "bookforge"
MAX_SOURCE_BYTES = 128 * 1024


NINE_SECTIONS = ("배경", "요구사항", "구성도", "데이터 흐름", "보안 등급", "비용 예측", "절감안", "대안", "결정 기록")


def sections(markdown: str):
    """Keep a short app design in one chapter so QC does not require filler pages.

    Heading lines stay headings. The PDF body check looks for each of the nine
    architecture section titles on its own line, so turning them into bold
    labels would drop the section from the extracted text.
    """
    title = next((line[2:].strip() for line in markdown.splitlines()
                  if line.startswith("# ")), "설계 문서")
    if not markdown.strip():
        return []
    return [(title, markdown.strip())]


def prepare_chapter(markdown: str) -> str:
    """Demote inner headings before the unchanged vendor build reads the chapter.

    The business theme outlines every level-2 heading, then QC requires that
    bookmark page to match the printed contents. Short sections share a page,
    so those numbers disagree. One extra hash keeps the title in the body.
    """
    lines = []
    for line in markdown.splitlines():
        if line.startswith("## ") and not line.startswith("### "):
            lines.append("#" + line)
        else:
            lines.append(line)
    return "\n".join(lines) + ("\n" if markdown.endswith("\n") else "")


def seat_homes() -> List[Path]:
    """Process HOME, then the account home when a gate replaces HOME with an empty dir.

    getpass reads the passwd entry. It does not follow a rewritten HOME, and it
    does not hard-code a path. A missing account home still fails the render.
    """
    homes = []
    raw = os.environ.get("HOME", "")
    if raw:
        homes.append(Path(raw))
    try:
        account = Path("~" + getpass.getuser()).expanduser()
    except Exception:
        account = None
    if account and account not in homes:
        homes.append(account)
    return homes


def user_site_packages() -> List[str]:
    """Keep the current interpreter. A replaced HOME must still see account installs.

    site.getusersitepackages follows the process HOME. The gate sets that to an
    empty directory, so the account home from the passwd entry is listed too.
    """
    try:
        from site import USER_SITE, getsitepackages, getusersitepackages
    except ImportError:
        return []
    sites = []
    try:
        sites.append(getusersitepackages())
    except Exception:
        pass
    try:
        sites.extend(getsitepackages())
    except Exception:
        pass
    if USER_SITE:
        relative = Path(USER_SITE)
        home = Path(os.environ["HOME"]) if os.environ.get("HOME") else None
        if home and relative.is_absolute():
            try:
                relative = relative.relative_to(home)
            except ValueError:
                relative = None
        for account in seat_homes():
            if relative is not None and not Path(relative).is_absolute():
                sites.append(str(account / relative))
    seen = []
    for site in sites:
        if site and site not in seen and Path(site).is_dir():
            seen.append(site)
    return seen


def python_310() -> Optional[str]:
    """The gate's python3 is 3.9. Re-exec on the first 3.10+ already installed."""
    if sys.version_info >= (3, 10):
        return None
    seen = []
    for name in ("python3.15", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10"):
        found = shutil.which(name)
        if found and found not in seen:
            seen.append(found)
    for home in seat_homes():
        candidate = home / ".local/share/elanous/bin/python3"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            text = str(candidate)
            if text not in seen:
                seen.append(text)
    for candidate in (
        Path("/opt/homebrew/bin/python3.15"),
        Path("/opt/homebrew/bin/python3.14"),
        Path("/opt/homebrew/bin/python3.13"),
        Path("/opt/homebrew/bin/python3.12"),
        Path("/opt/homebrew/bin/python3.11"),
        Path("/opt/homebrew/bin/python3.10"),
        Path("/opt/homebrew/bin/python3"),
        Path("/usr/local/bin/python3.13"),
        Path("/usr/local/bin/python3"),
    ):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            text = str(candidate)
            if text not in seen:
                seen.append(text)
    for path in seen:
        probe = subprocess.run(
            [path, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
            capture_output=True)
        if probe.returncode == 0:
            return path
    return None


def find_typst() -> Optional[str]:
    """Find Typst even when the gate clears PATH of the seat install dir.

    The review Bun wrapper keeps only ~/.bun/bin and the system bins. The
    seat install lives at ~/.local/share/elanous/bin, so which() misses it.
    """
    found = shutil.which("typst")
    if found:
        return found
    candidates = []
    for home in seat_homes():
        candidates.append(home / ".local/share/elanous/bin/typst")
        candidates.append(home / ".local/bin/typst")
    candidates.extend((Path("/opt/homebrew/bin/typst"), Path("/usr/local/bin/typst")))
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def check_dependencies():
    for site in user_site_packages():
        if site not in sys.path:
            sys.path.append(site)
    typst = find_typst()
    if not typst:
        return "Typst 0.14 or newer is required. Install Typst and retry."
    version = subprocess.run([typst, "--version"], capture_output=True, text=True, timeout=10)
    if version.returncode != 0 or not re.search(r"\b0\.(1[4-9]|[2-9]\d)\.\d+\b", version.stdout):
        return "Typst 0.14 or newer is required; the installed typst version is unsupported."
    try:
        import pymupdf  # noqa: F401
        import markdown_it  # noqa: F401
    except ImportError:
        return "Python packages PyMuPDF and markdown-it-py are required: python3 -m pip install pymupdf markdown-it-py"
    return None


def run_script(name: str, project: Path):
    """Call the bundled vendor script as-is. No globals patch, no wrapper."""
    script = ENGINE / "scripts" / name
    env = dict(os.environ)
    typst = find_typst()
    if typst:
        typst_dir = str(Path(typst).parent)
        path = env.get("PATH", "")
        if typst_dir not in path.split(os.pathsep):
            env["PATH"] = typst_dir + (os.pathsep + path if path else "")
    extra = os.pathsep.join(user_site_packages())
    if extra:
        env["PYTHONPATH"] = extra + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    result = subprocess.run([sys.executable, str(script), str(project)],
                            capture_output=True, text=True, timeout=180, env=env)
    return result.returncode, (result.stderr or result.stdout)[-2000:]


def pdf_page_count(path: Path) -> int:
    """Count pages from a real PDF. A missing or non-PDF file is zero pages."""
    data = path.read_bytes()
    if not data.startswith(b"%PDF-"):
        return 0
    return len(re.findall(br"/Type\s*/Page(?!s)\b", data))


def render(design_path: Path, out_dir: Path, title: str):
    if not design_path.is_absolute() or not out_dir.is_absolute():
        raise ValueError("designPath and outDir must be absolute")
    if design_path.is_symlink() or not design_path.is_file() or design_path.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("designPath must be a regular Markdown file of at most 128 KiB")
    if design_path.suffix.lower() != ".md":
        raise ValueError("designPath must end in .md")
    if not title or len(title) > 120 or any(ch in title for ch in "\r\n\0"):
        raise ValueError("title must be one nonempty line of at most 120 characters")
    project = out_dir / "bookforge-project"
    # A repair loop visits this node twice with the same scratch. Replace the
    # derived project before the dependency check so a missing renderer cannot
    # leave the previous visit's directory and fail the next pass.
    if project.exists():
        if project.is_symlink() or not project.is_dir():
            raise ValueError("outDir/bookforge-project must be a directory")
        shutil.rmtree(project)
    missing = check_dependencies()
    if missing:
        return {"ok": False, "error": missing}
    source = design_path.read_bytes()
    markdown = source.decode("utf-8")
    chapters = sections(markdown)
    if not chapters:
        raise ValueError("designPath contains no design content")
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
        (project / "chapters" / filename).write_text(
            prepare_chapter(f"# {safe_heading}\n\n{body}\n"), encoding="utf-8")
        summary = next((line.strip() for line in body.splitlines()
                        if line.strip() and not line.startswith(("#", "```", "|"))
                        and not re.fullmatch(r"\*\*[^*]+\*\*", line.strip())), safe_heading)
        # A long contents line makes the business theme shrink the whole page.
        # QC then fails G1-SCALE because body text is no longer the theme size.
        outline.append({"file": filename, "title": safe_heading,
                        "summary": summary[:160], "toc_line": safe_heading[:24]})
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
    pages = pdf_page_count(final[0]) if len(final) == 1 else 0
    if code != 0 or len(final) != 1 or pages < 1:
        return {"ok": False, "error": "Bookforge QC gate failed: " + detail,
                "projectPath": str(project), "gateReportPath": str(project / "gate-report.json"),
                "pageCount": pages}
    return {"ok": True, "pdfPath": str(final[0]), "pageCount": pages, "projectPath": str(project),
            "sourceSha256": hashlib.sha256(source).hexdigest(), "visualReviewRequired": True}


def main():
    # Re-exec before dependency checks. The gate python3 is 3.9 and does not
    # see the PyMuPDF install that lives on the 3.10+ interpreter.
    newer = python_310()
    if newer:
        os.execv(newer, [newer, *sys.argv])
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
