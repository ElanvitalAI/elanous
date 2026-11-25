import { redactSecretText } from '../../debug/log.js';

function safeErrorText(text: string): string {
  return redactSecretText(text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')).trim();
}

/** A failed turn's public receipt and the next useful action. */
export function nextTuiErrorCard(
  error: string,
  authFailureKind?: 'codex-auth-missing' | 'codex-auth-failed' | 'glm-auth-missing' | 'llm-unset',
): string[] {
  const authDetails = {
    'codex-auth-missing': 'Codex authentication is not ready.',
    'codex-auth-failed': 'Codex authentication failed.',
    'glm-auth-missing': 'GLM authentication is not ready.',
    'llm-unset': 'No LLM is set up yet.',
  } as const;
  const safe = safeErrorText(error);
  const detail = authFailureKind ? authDetails[authFailureKind] :
    safe.replace(/^요청을 처리하지 못했습니다\.(?=\s*\(|$)/u, 'Could not process the request.') || 'No error detail';
  return [
    `✘ ${detail}`,
    authFailureKind === 'llm-unset' ? '  Next: run `elanous login openai-codex` or `elanous setup keys` → ↑ recall input → Enter resend'
      : authFailureKind ? '  Check /provider · renew auth → ↑ recall input → Enter resend'
      : '  ↑ recall input → Enter resend · check /provider · /resume to continue',
  ];
}

/** NEXT-TUI-UX-ERROR-CARD: a short, secret-free cause label so a provider failure, a cut stream and a timeout do
 *  not all read as «요청을 처리하지 못했습니다». Matches only the error's class of wording; the raw text is never shown. */
/** Every label {@link classifyTurnFailure} can return (NEXT-TUI-FEATURE-COMPLETE ② · a reloaded failure may keep only these). */
export const TURN_FAILURE_CAUSE_LABELS: readonly string[] = [
  'Authentication was denied', 'Rate limit exceeded or provider overloaded', 'Provider server error',
  'No response; timed out', 'Response stream was cut', 'Network connection failed',
  'A tool schema was rejected by the provider',
];

export function classifyTurnFailure(error: string | undefined): string | null {
  const text = (error ?? '').toLowerCase();
  if (!text) return null;
  if (/tool schema has unsupported top-level composition|tool-schema-rejected/.test(text)) return 'A tool schema was rejected by the provider';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|authentication/.test(text)) return 'Authentication was denied';
  if (/\b429\b|rate[ _-]?limit|too many requests|quota|overloaded|\b529\b|한도/.test(text)) return 'Rate limit exceeded or provider overloaded';
  if (/\b50[0234]\b|bad gateway|service unavailable|gateway time-?out|internal server error/.test(text)) return 'Provider server error';
  if (/idle|timed? ?out|timeout|etimedout|시간 ?초과|stalled/.test(text)) return 'No response; timed out';
  if (/econnreset|socket hang up|premature close|terminated|stream (?:ended|closed|error)|aborted|스트림/.test(text)) return 'Response stream was cut';
  if (/enotfound|econnrefused|eai_again|fetch failed|network|offline|연결 ?실패/.test(text)) return 'Network connection failed';
  return null;
}
