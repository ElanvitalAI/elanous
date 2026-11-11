# Plugins

## Expert notes to a knowledge pack (simulation)

`invest-arg/recipes/notes-to-pack.yaml` with `src/knowledge/notes-to-pack.ts` provides the deterministic `notesToPack(notes, identity)` recipe. Each attributed expert note supplies a claim, premise, falsifier, asset, time horizon and optional HTTPS source with capture time. The recipe produces one KPACK1 document card and two Bloom question cards (analysis level 4 and evaluation level 5) per note. Missing sources are marked `근거 없음`; the recipe does not invent evidence or investment advice.

The returned `files` map contains `knowledge-pack.json` and `content/*.json` values. A caller writes these into a directory, validates it with the ordinary KPACK1 validator, and only then sends it through the normal signing and publishing path. The manifest carries a placeholder key ID for this offline simulation; this recipe does not publish or install a pack. Run `bun test test/notes-to-pack.test.ts` to exercise three fixed notes and the KPACK1 boundary.
