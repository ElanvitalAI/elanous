// TUI-UNKNOWN-SLASH-NOT-SENT — an unregistered «/명령» must not become a paid model turn.
// Only a bare command-shaped first token (`/foo`, `/foo bar`) is treated as a mistyped command; a path
// (`/Users/x`), `//text` and prose that merely contains a slash still go to the model unchanged.

// TUI-SLASH-DURING-TURN — during-turn 즉시 실행 판정기(slash/during-turn.ts)가 같은 모양 규칙을 쓴다.
export const COMMAND_SHAPE = /^\/[A-Za-z][\w-]*$/;

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** Up to three registered spellings that look like what was typed (prefix first, then edit distance ≤ 2). */
export function suggestSlashCommands(typed: string, known: readonly string[]): string[] {
  const word = typed.toLowerCase();
  const spellings = [...new Set(known.filter((text) => COMMAND_SHAPE.test(text)))];
  const prefix = spellings.filter((text) => text.startsWith(word) || word.startsWith(text));
  const close = spellings.filter((text) => !prefix.includes(text) && distance(word, text) <= 2);
  return [...prefix, ...close].slice(0, 3);
}

/** The notice lines for an unregistered slash command, or null when the input must go to the model. */
export function unknownSlashNotice(submitted: string, known: readonly string[]): string[] | null {
  const first = submitted.trim().split(/\s+/)[0] ?? '';
  if (!COMMAND_SHAPE.test(first)) return null;
  const suggestions = suggestSlashCommands(first, known);
  return [
    `Unknown command: ${first} · not sent to the model`,
    suggestions.length ? `Similar commands: ${suggestions.join(' · ')}` : 'See /help for the command list',
  ];
}
