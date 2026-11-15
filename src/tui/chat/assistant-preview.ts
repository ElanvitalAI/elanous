/** Hold unfinished ASCII/numeric identifiers for credential redaction while
 * non-ASCII Unicode prose can paint. Earlier prose cannot predict a future
 * identifier suffix; only the currently received tail is classified. */
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
  if (!unfinishedWord) return text;
  // Unicode Letter includes prolonged sound marks; Punctuation includes
  // fullwidth comma/colon. ASCII letters and numeric tails remain buffered.
  // Require non-ASCII prose; punctuation-only ASCII tails such as --- wait.
  // A prose prefix painted in an earlier delta cannot be retracted here.
  if (/^[\p{L}\p{P}]+$/u.test(unfinishedWord[0]) && !/[A-Za-z0-9]/u.test(unfinishedWord[0]) && /[^\x00-\x7f]/u.test(unfinishedWord[0])) return text;
  return text.slice(0, unfinishedWord.index);
}
