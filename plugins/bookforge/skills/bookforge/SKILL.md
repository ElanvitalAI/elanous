---
name: bookforge
description: Reflow an existing app architecture Markdown file into a Korean PDF with bundled Gongnyang Bookforge. Use for app design PDF and book typesetting requests.
requires: []
---

# Bookforge PDF

This installed plugin uses the Bookforge skill and engine shipped with Elanous under `skills/bookforge/`. The original [Gongnyang Bookforge](https://github.com/gongnyang/bookforge) revision is `3f1e85ee501f5984acb8cd6d92ecb7a4c3fb5374` (MIT code and documentation; separate OFL font notices).

For an existing app architecture Markdown file, use the `bookforge-app-docs-pdf` graph with absolute `designPath`, fresh absolute `outDir`, and one-line `title`. It preserves source content, records its SHA-256, runs the bundled renderer and QC gate, and returns a PDF path only when the gate passes. It does not publish or claim visual inspection.

Typst 0.14.x and Python 3 with PyMuPDF and markdown-it-py are required. Missing dependencies return a specific error before output. Inspect the cover, contents, chapter opening, and body contact sheet before presenting the PDF as finished.
