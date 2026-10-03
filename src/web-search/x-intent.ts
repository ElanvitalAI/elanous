// Recognize explicit requests for X/Twitter sources, not incidental letters in words.
export function wantsXSearch(query: string): boolean {
  return /(?:^|[^\p{L}\p{N}_])(?:x에서|엑스에서|x\s+(?:반응|여론)|트위터(?:에서|의|에|로|는|가)?|트윗(?:에서|의|을|이|들|은|도)?)(?![\p{L}\p{N}_])/iu.test(query)
    || /(?:^|[^\p{L}\p{N}_])(?:x\.com(?![\p{L}\p{N}_.-])|twitter(?:\.com)?(?![\p{L}\p{N}_])|on\s+x(?![\p{L}\p{N}_])|x\s+reactions?(?![\p{L}\p{N}_]))/iu.test(query);
}
