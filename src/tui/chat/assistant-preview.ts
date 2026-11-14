/** Preview only complete words so a credential split across deltas reaches the
 * existing secret-safe renderer as one token. The canonical final answer is not
 * shortened; its last word appears when the turn settles. */
export function nextAssistantPreviewText(text: string): string {
  // A partial private-key block must not become visible line by line before its
  // closing marker makes the shared redactor recognize the complete block.
  for (const opening of text.matchAll(/-----BEGIN[ A-Z0-9_-]*PRIVATE KEY(?: BLOCK)?-----/giu)) {
    if (!/-----END[ A-Z0-9_-]*PRIVATE KEY(?: BLOCK)?-----/iu.test(text.slice(opening.index))) {
      text = text.slice(0, opening.index);
      break;
    }
  }
  const unfinishedWord = /\S+$/u.exec(text);
  return unfinishedWord ? text.slice(0, unfinishedWord.index) : text;
}
