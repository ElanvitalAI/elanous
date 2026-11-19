// ELS-GREP-PANES (seat-state/OP/orders/ELS-OP-SMALLWINS-1119.md 칸5 · 0.3.30 P0) — the pure half of `els grep "<패턴>"`:
// which lines of a pane's last screen carry the literal pattern. The gathering half lives around it (src/els/core.ts
// renders each pane of the owner's journal, src/els/server.ts·src/cli/els-cli.ts carry the command); this module only
// decides matches, so every surface that greps shares one rule and the literals test it.
//
// 완료선 «비밀 가림» (TC #102214 · 0.3.30 P0): the match decision runs on the raw line (what a person quoted is what
// is searched), but the hit carries the redacted line — the 공용 redactSecretText (gitleaks 이식 · #38865 합집합) —
// so a secret printed on a pane screen never reaches grep output. Fail-closed: masking can only hide more.

import { redactSecretText } from '../debug/secret-redaction.js';

/** One pane's last screen, ready to be searched. `address` is the pane's `ws/tab/pane` (`host:ws/tab/pane` on a remote pane). */
export interface GrepScreen {
  readonly address: string;
  readonly screen: string;
}

/** A line that carries the pattern: the pane's address, the 1-based line number and the line as it stands. */
export interface GrepHit {
  readonly address: string;
  readonly line: number;
  readonly text: string;
}

/** The lines of `panes` that carry the literal `pattern` — panes in the order given, lines top to bottom, nothing
 *  else (no regex, no case folding: what a person quotes is what is searched). An empty pattern matches nothing
 *  here; the command layer refuses it first (exit 2), so this is the fail-closed backstop. The hit's `text` is the
 *  redacted line (공용 redactSecretText): a secret-shaped token printed on the pane screen shows up masked, never raw. */
export function grepScreens(pattern: string, panes: readonly GrepScreen[]): readonly GrepHit[] {
  const hits: GrepHit[] = [];
  if (pattern === '') return hits;
  for (const pane of panes) {
    const lines = pane.screen.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const text = lines[index]!;
      if (text.includes(pattern)) hits.push({ address: pane.address, line: index + 1, text: redactSecretText(text) });
    }
  }
  return hits;
}
