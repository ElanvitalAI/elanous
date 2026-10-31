---
name: demo-browser-hand
description: Navigate and inspect web pages with the existing browser tools, handing off when a person must act.
---

# Browser hand

Use the existing `BrowserOpen`, `BrowserNavigate`, `BrowserRead`, `BrowserScreenshot`, and `BrowserClose` tools. Ask the user to complete authentication, consent, or other human-only steps in the browser when required. Do not claim a page changed unless a fresh read confirms it.
