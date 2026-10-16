export function parseGeminiServerTools(raw: unknown): { googleSearch?: boolean; codeExecution?: boolean; urlContext?: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: { googleSearch?: boolean; codeExecution?: boolean; urlContext?: boolean } = {};
  if (obj.googleSearch === true) out.googleSearch = true;
  if (obj.codeExecution === true) out.codeExecution = true;
  if (obj.urlContext === true) out.urlContext = true;
  return (Object.keys(out).length > 0) ? out : undefined;
}
