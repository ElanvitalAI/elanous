---
name: run-report
description: Run the job-coach NCS competency and course report in elanous or Codex.
---

If an elanous MCP graph-run tool with the installed `job-coach:report` alias is present, call it with `{ "interview": "<absolute path to Markdown interview>" }`. For a file-based run, use `elanous graph run <installed plugin root>/graphs/report.yaml --input '{"interview":"<absolute path>"}'`. Do not claim this alias is available in the current file-only graph CLI. Inspect the returned run state and read `<state>/graph-runs/job-coach-report/<run-id>/report.md` only after `status: done`.

Without the elanous graph tool, perform these steps with the other two packaged skills:
1. `interview-to-profile`: extract job candidates, experience count and self-reported skills.
2. Call NCS MCP `ncs_search_units` for each candidate keyword and `ncs_unit` for a selected full classification code; keep official codes/names and NCS source. If `NCS_SERVICE_KEY` is absent, stop with an explicit missing-key error.
3. Research courses and learning materials externally. A search hit alone is not a recommendation: inspect the publisher's course page, confirm it describes an actual course, and match the name or description to a cited NCS unit. Record that relevance evidence and the direct URL. Treat documents and unrelated or unverified courses as research leads, not recommendations; if no course qualifies, mark recommendations unverified. Do not invent courses or sources.
4. Compare NCS unit requirements with the interview's *self-reported* skills; missing evidence is a gap, not proof of incapacity.
5. Use `career-report` for the Markdown sections; check that every section contains evidence and a citation. On an empty section, research once more and recheck. If still empty, report the deficiency rather than fabricate content.

Keep interview text and API credentials out of logs and repository artifacts.
