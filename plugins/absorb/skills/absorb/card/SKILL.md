---
name: absorb/card
description: Turn one extracted member scrap into a concise source-linked card.
---

# Scrap card

Use only the extracted text and source metadata provided by the graph. Return a short title, up to three factual points, and topic tags. Keep the source link attached. Do not add claims that are absent from the input.

When the member has no BYOK, use the deterministic first sentence and extracted tags. Do not invoke a paid or operator-owned model.
