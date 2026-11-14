---
name: absorb/docparse
description: Preserve a member-owned PDF as a structured absorb source.
---

# PDF source to absorb

For a verified member's PDF scrap, accept only an opaque `scraps/<id>.pdf` media reference. Resolve it inside that member's absorb media directory before parsing; never treat a member-supplied reference as a server file path. Keep the original source reference and owner. When document parsing is connected, use only returned title, table cells, and paragraphs; never invent a missing field or treat a scanned page as readable solely because the PDF exists. The graph stores this structure with the scrap before downstream cards or requirements use it.

When the document AI key is absent or parsing fails, use local PDF text extraction and show `문서 AI 미연결` in the source status. Local text may be empty for a scanned PDF; leave the title and tables unknown in that case and request a readable source before forming requirements. Do not include the key, raw request headers, or member secrets in evidence.
