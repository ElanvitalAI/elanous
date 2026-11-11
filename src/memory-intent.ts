/** Only a simple final affirmative command is saved without a model tool call. */
export function findRememberRequestClause(userText: string): string | null {
  const input = userText.trim();
  const finalStandalone = /^([^.!。?？\n\r]{4,500})[.。]\s*(기억해(?:\s*줘)?)[.!。]?$/u.exec(input);
  const statement = finalStandalone
    ? `${finalStandalone[1]!.trim()}, ${finalStandalone[2]}`
    : input.replace(/[.!。]\s*$/u, '').trim();
  if (!statement || /[\n\r?!？。.!:：;；"“”'‘’]/u.test(statement)) return null;
  if (/^(?:다음 문장|예시|인용|분석|번역|요약)/u.test(statement)) return null;
  if (/(?:아니|취소|철회|번복|기억\s*(?:하지|안|않|말|못)|안\s*기억|기억해(?:선|도|주지)|\b(?:not|never|don't|do not|cancel|retract|forget|ignore)\b)/iu.test(statement)) return null;
  if (!/(?:기억해(?:\s*줘)?|remember this)$/iu.test(statement)) return null;
  return statement;
}
