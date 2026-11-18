---
name: bookforge
description: Reflow an existing app architecture Markdown file into a Korean PDF with bundled Gongnyang Bookforge. Use for app design PDF and book typesetting requests.
requires: []
---

# Bookforge PDF

This installation bundles [Gongnyang Bookforge](https://github.com/gongnyang/bookforge) at upstream revision `3f1e85ee501f5984acb8cd6d92ecb7a4c3fb5374`. The original code and documentation use the MIT license. Bundled fonts use their separate OFL notices. Preserve this attribution in redistributed output documentation.

For an existing app architecture Markdown file, run the declared `bookforge-app-docs-pdf` graph with absolute `designPath` and `outDir` input paths. The graph reflows the supplied text, runs Bookforge's renderer and QC gate, and returns an output path only on success. It does not write invented design facts or publish the PDF.

The engine requires Typst 0.14.x plus Python 3 with `pymupdf` and `markdown-it-py`. If a dependency is absent, the graph returns its exact missing dependency and installation guidance. The bundled upstream procedure is at `vendor/bookforge/SKILL.md` relative to this file.

After a successful QC gate, visually inspect the cover, table of contents, chapter opening, and body pages with the bundled `contact_sheet.py` before presenting the PDF as finished.
