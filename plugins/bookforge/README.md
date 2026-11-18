# Bookforge app design PDF

The `bookforge-app-docs-pdf` graph consumes an existing application `ARCHITECTURE.md` and a fresh absolute output directory. Its `reflow` node splits the existing sections into chapters, records the input SHA-256, calls the bundled [Gongnyang Bookforge](https://github.com/gongnyang/bookforge) renderer, and requires its QC gate before returning a final PDF path. It does not publish the PDF or claim visual review.

Example input for `elanous graph run plugins/bookforge/graphs/app-docs-pdf.yaml --input`:

```json
{"designPath":"/absolute/app/ARCHITECTURE.md","outDir":"/absolute/output","title":"서비스 설계"}
```

Typst 0.14.x and Python 3 with PyMuPDF and markdown-it-py are required. Missing dependencies return a specific error before creating output. The graph returns `visualReviewRequired: true`; inspect the cover, contents, chapter opening, and body with the bundled contact sheet tool before calling the result finished.

The bundled upstream snapshot is revision `3f1e85ee501f5984acb8cd6d92ecb7a4c3fb5374`. Bookforge source and documentation retain their MIT license. Fonts retain separate OFL notices under `../../skills/bookforge/vendor/bookforge/assets/fonts/`. The root skill and this plugin are both part of the package's existing `skills/` and `plugins/` export paths.
