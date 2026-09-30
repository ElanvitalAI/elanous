---
name: hwp-fill
description: Fill HWPX form placeholders and table cells while retaining their existing formatting and checking explicit page breaks.
---

# Fill an existing form

Write a UTF-8 JSON object mapping placeholder names to strings (e.g. `{"이름":"홍길동"}`) into `fields.json`. Run `python packs/elanous-hwp/scripts/hwp.py fill form.hwpx --fields fields.json -o filled.hwpx`. `{{이름}}` markers may span multiple text runs within a paragraph, including a table cell. The original file is never overwritten; the output preserves untouched ZIP members. The page check compares explicit page-break counts, not visually laid-out pages; inspect the resulting HWPX in a renderer when visual pagination matters. Consume the stdout JSON and stop if `ok` is false.
