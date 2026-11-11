import { inspectActiveProvider, type ActiveProviderInfo, type AuthKind } from '../../provider-summary.js';
import { activeCodexAccountView } from '../../oauth/codex-account-store.js';
import { explicitTurnTier } from '../../model-tier/turn-tier.js';
import { getUserConfig } from '../../user-config/reader.js';

export interface NextTuiStatusSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly auth: AuthKind;
  readonly account?: { readonly name: string; readonly source: string } | null;
}

export interface NextTuiStatusHost {
  addLines(...lines: string[]): void;
  sessionId?: string;
}

function connectionLabel(auth: AuthKind): string {
  if (auth === 'oauth') return 'OAuth 자격 설정됨 · 실연결은 확인하지 않음';
  if (auth === 'apikey') return 'API 키 설정됨 · 실연결은 확인하지 않음';
  if (auth === 'local') return '로컬 endpoint 설정됨 · 실연결은 확인하지 않음';
  return '미설정';
}

function accountLabel(account: NextTuiStatusSnapshot['account']): string {
  if (!account) return '이 provider의 계정 이름을 조회할 수 없음';
  const name = displayValue(account.name);
  const source = account.source === 'env'
    ? '환경에서 선택'
    : account.source === 'rotated'
      ? '사용량 정책으로 전환'
      : '기본 계정';
  return `${name || '알 수 없음'} (${source})`;
}

function displayValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Render one read-only status screen without probing the provider or exposing credentials. */
export function renderNextTuiStatus(snapshot: NextTuiStatusSnapshot): readonly string[] {
  return [
    '모델·연결·계정 상태',
    `모델: ${displayValue(snapshot.provider) || '알 수 없음'} / ${displayValue(snapshot.model) || '알 수 없음'}`,
    `연결 설정: ${connectionLabel(snapshot.auth)}`,
    `계정: ${accountLabel(snapshot.account)}`,
  ];
}

function readStatusSnapshot(sessionId?: string): NextTuiStatusSnapshot {
  const config = getUserConfig();
  const runtimeModel = sessionId ? explicitTurnTier(config, sessionId)?.model : undefined;
  const provider: ActiveProviderInfo = inspectActiveProvider(config, runtimeModel);
  let account: NextTuiStatusSnapshot['account'] = null;
  if (provider.provider.includes('codex')) {
    try {
      const view = activeCodexAccountView();
      account = { name: view.name, source: view.source };
    } catch {
      // An unreadable account store is unknown; never substitute a different account.
      account = null;
    }
  }
  return { provider: provider.provider, model: provider.model, auth: provider.auth, account };
}

/** The registry resolves `/status` here; extra text is ignored because this is a fixed view. */
export async function runNextTuiStatusBranchRoute(
  input: string,
  host: NextTuiStatusHost,
  readSnapshot: (sessionId?: string) => NextTuiStatusSnapshot = readStatusSnapshot,
): Promise<void> {
  if (!/^\/status(?:\s|$)/u.test(input.trim())) return;
  host.addLines(...renderNextTuiStatus(readSnapshot(host.sessionId)));
}
