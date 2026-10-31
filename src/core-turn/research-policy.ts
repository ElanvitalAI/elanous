/** Shared guardrails for every core-turn research surface. */
export const RESEARCH_TURN_MAX_TOOL_TURNS = 20;
export const RESEARCH_TURN_FIRST_REPLY_BUDGET_MS = 15_000;
export const RESEARCH_TURN_DEEP_BUDGET_MS = 3 * 60_000;
export const RESEARCH_TURN_DEADLINE_STOP_ERROR = 'research stopped by its deadline';

/** Research turns only receive these tools; unrelated writers are never implicit. */
export const RESEARCH_TOOL_ALLOWLIST = [
  'OmniSearch',
  'WebFetch',
  'Agent',
  'Read',
  // TUI quick-route contracts: every quick turn can recall memory, and the
  // investigation route may list (but never mutate) the seat mailbox.
  'memory_recall',
  'MsgList',
] as const;

const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(RESEARCH_TOOL_ALLOWLIST);
export const RESEARCH_DOCUMENT_WRITE_TOOLS = ['Edit', 'Write'] as const;

/** A research turn may write only when the user explicitly asks for a document at a concrete path. */
const DOCUMENT_OUTPUT_PATH = /(?:^|[\s"'\x60])(?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|txt|rst|adoc|html|json|ya?ml|csv)\b/i;
const DOCUMENT_OUTPUT_PATH_GLOBAL = /(?:^|[\s"'\x60])(?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|txt|rst|adoc|html|json|ya?ml|csv)\b/gi;
const POSITIVE_DOCUMENT_WRITE_INTENT = /\b(?:write|writes|writing|written|draft|drafts|drafting|create|creates|creating|author|authors|authoring|produce|produces|producing|save|saves|saving)\b|작성|초안|생성|기록/i;
const NEGATED_DOCUMENT_WRITE_INTENT = /\b(?:do\s+not|don['’]?t|never|must\s+not|should\s+not|avoid)\s+(?:(?:be|to)\s+)*(?:write|writes|writing|written|draft|drafts|drafting|create|creates|creating|author|authors|authoring|produce|produces|producing|save|saves|saving)\b|(?:작성|초안|생성|기록)(?:\s*(?:을|를))?\s*(?:하지\s*마|하지\s*말|하지\s*않|금지)/i;

/** A research turn may write only when the user explicitly asks for a document at a concrete path. */
export function requestsResearchDocumentWrite(text: string | undefined): boolean {
  if (!text || !DOCUMENT_OUTPUT_PATH.test(text)) return false;
  const intentText = text.replace(DOCUMENT_OUTPUT_PATH_GLOBAL, ' ');
  return POSITIVE_DOCUMENT_WRITE_INTENT.test(intentText)
    && !NEGATED_DOCUMENT_WRITE_INTENT.test(intentText);
}
export function isResearchToolAllowed(name: string): boolean {
  return RESEARCH_TOOL_NAMES.has(name);
}
