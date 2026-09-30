---
name: hwp-write
description: Create an HWPX report or official letter from Markdown headings, lists, tables and bold text.
---

# Write Korean HWPX documents

Save the requested Markdown to a UTF-8 `.md` file in the workdir. Run `python packs/elanous-hwp/scripts/hwp.py write input.md --template report -o output.hwpx` (choose `official-letter` for formal correspondence). Read stdout JSON for `ok` and `output`. Never overwrite an input. The templates in `templates/` specify font, size, margins and table styling. To deliver a job-coach report, put grounded NCS codes and findings in the Markdown first, then render with `report`.
