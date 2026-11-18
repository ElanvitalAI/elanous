import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { UserConfig } from '../user-config/schema.js';

type Reason = 'missing-file' | 'expired' | 'other';
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type NextTuiAuthFailureKind = 'codex-auth-missing' | 'codex-auth-failed' | 'glm-auth-missing';
/** Public, fixed text per kind — never provider error text or credential values. */
export const NEXT_TUI_AUTH_FAILURE_TEXT: Readonly<Record<NextTuiAuthFailureKind, string>> = {
  'codex-auth-missing': 'Codex 인증이 준비되지 않았습니다. 주인 호스트에서 접근 미러를 갱신하세요.',
  'codex-auth-failed': 'Codex 인증에 실패했습니다. eln login openai-codex를 확인하세요.',
  // Same text as ZAI_CREDENTIAL_MISSING_REASON (src/llm/zai-coding-plan.ts) — kept literal so the TUI core
  // import graph does not load the Z.ai provider module; the focused test pins the two equal.
  'glm-auth-missing': 'GLM 자격 없음: ZAI Coding Plan 키(~/.cache/zai_api_key 또는 ZAI_API_KEY)를 찾지 못했습니다',
};
/** Only these preflights may create a public auth failure. */
export class NextTuiAuthError extends Error {
  constructor(readonly kind: NextTuiAuthFailureKind) {
    super(NEXT_TUI_AUTH_FAILURE_TEXT[kind]);
    this.name = 'NextTuiAuthError';
  }
}

/** TUI-GLM-PROVIDER-USES-ZAI-CODING-PLAN — a glm turn with no Z.ai Coding Plan key used to end in 0s
 * as a generic failure. Judge with the production resolver (key cache → ZAI_API_KEY; presence only)
 * and surface the reason before the child starts. */
export function preflightNextTuiGlmAuth(provider: string | undefined, available: () => boolean): void {
  if (provider !== 'glm') return;
  if (!available()) throw new NextTuiAuthError('glm-auth-missing');
}

export function classifyNextAuthFailure(error: unknown): Reason {
  const message = error instanceof Error ? error.message : String(error);
  if (/reason=missing-file|mirror.*(?:missing|absent)/i.test(message)) return 'missing-file';
  if (/reason=expiry|expired|expires/i.test(message)) return 'expired';
  return 'other';
}

/** The owner validates its own lease and sends access-only credentials. This
 * seat never reads or transports a refresh token. One bounded request only. */
export function requestOwnerMirrorOnce(config: UserConfig): boolean {
  const owner = config.llm.codexTokenOwnerHost?.trim();
  const target = config.hq?.hostName?.trim() || hostname();
  if (!owner || !HOST.test(owner) || !HOST.test(target) || owner === target) return false;
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=1', owner,
    `~/.local/share/elanous/bin/eln codex mirror push ${target}`],
  { timeout: 1_500, encoding: 'utf8', stdio: 'ignore' });
  return result.status === 0;
}

export async function preflightNextTuiAuth(
  config: UserConfig,
  deps: { load: () => Promise<unknown>; request: () => boolean; observe?: (reason: Reason, requested: boolean) => void },
): Promise<void> {
  if (config.llm.provider !== 'openai-codex') return;
  try {
    if (await deps.load()) return;
    throw new Error('Codex auth absent');
  } catch (error) {
    const reason = classifyNextAuthFailure(error);
    const requested = (reason === 'missing-file' || reason === 'expired') && deps.request();
    deps.observe?.(reason, requested);
    if (requested) {
      try { if (await deps.load()) return; } catch { /* show one safe recovery line */ }
    }
    throw new NextTuiAuthError(reason === 'missing-file' || reason === 'expired'
      ? 'codex-auth-missing' : 'codex-auth-failed');
  }
}
