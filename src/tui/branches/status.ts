import { inspectActiveProvider, type ActiveProviderInfo, type AuthKind } from '../../provider-summary.js';
import { activeCodexAccountView } from '../../oauth/codex-account-store.js';
import { explicitTurnTier } from '../../model-tier/turn-tier.js';
import { getSessionProvider } from '../../tui-client/session-provider.js';
import { resolveNextTuiSelection } from '../chat/status-model.js';
import { getUserConfig } from '../../user-config/reader.js';
import { resolveProviderCredential } from '../../llm/provider-credentials.js';
import { zaiCodingPlanAvailable } from '../../llm/zai-coding-plan.js';
import { runningBuild } from '../../pty-shell/tui-run-state.js';
import { buildCommitTime, versionLabel } from '../../version/build-stamp.js';

export interface NextTuiStatusSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly auth: AuthKind;
  readonly account?: { readonly name: string; readonly source: string } | null;
  /** `0.3.27 · official` · `0.3.28-dev.0 · 261117_1925 · dev` (src/version/build-stamp.ts) */
  readonly version?: string;
}

export interface NextTuiStatusHost {
  addLines(...lines: string[]): void;
  sessionId?: string;
}

function connectionLabel(auth: AuthKind): string {
  if (auth === 'oauth') return 'OAuth configured · no live connection check';
  if (auth === 'apikey') return 'API key configured · no live connection check';
  if (auth === 'local') return 'Local endpoint configured · no live connection check';
  return 'Not set';
}

function accountLabel(account: NextTuiStatusSnapshot['account']): string {
  if (!account) return 'Cannot look up account name for this provider';
  const name = displayValue(account.name);
  const source = account.source === 'env'
    ? 'selected by env'
    : account.source === 'rotated'
      ? 'switched by usage policy'
      : 'default account';
  return `${name || 'unknown'} (${source})`;
}

function displayValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Render one read-only status screen without probing the provider or exposing credentials. */
export function renderNextTuiStatus(snapshot: NextTuiStatusSnapshot): readonly string[] {
  return [
    'Model · connection · account status',
    `Model: ${displayValue(snapshot.provider) || 'unknown'} / ${displayValue(snapshot.model) || 'unknown'}`,
    `Connection: ${connectionLabel(snapshot.auth)}`,
    `Account: ${accountLabel(snapshot.account)}`,
    ...(snapshot.version ? [`Version: ${displayValue(snapshot.version)}`] : []),
  ];
}

function selectedCredentialPresent(config: ReturnType<typeof getUserConfig>, provider: string): boolean {
  try {
    if (provider === 'glm' && zaiCodingPlanAvailable()) return true;
    return resolveProviderCredential({ provider: provider as never, rotation: config.llm.rotation,
      baseProvider: config.llm.provider, baseApiKey: config.llm.apiKey }).source !== 'none';
  } catch { return false; }
}

function readStatusSnapshot(sessionId?: string): NextTuiStatusSnapshot {
  const config = getUserConfig();
  const runtimeModel = sessionId ? explicitTurnTier(config, sessionId)?.model : undefined;
  // The session's own provider/model (e.g. `--provider glm --model glm-5`) is what the next request uses, so
  // `/status` reads the same selection as the status bar instead of the global default.
  const selected = sessionId ? getSessionProvider(sessionId) : undefined;
  const selection = selected ? resolveNextTuiSelection(sessionId) : undefined;
  const provider: ActiveProviderInfo = selection
    ? inspectActiveProvider({ ...config, llm: { ...config.llm, provider: selection.provider as typeof config.llm.provider, model: selection.model } }, runtimeModel)
    : inspectActiveProvider(config, runtimeModel);
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
  // The provider token is the one the user selected (what the status bar shows). The connection decision can
  // name a different backend while the session's credentials are not in plain config (live: glm → «local»).
  // For a session-selected provider whose key lives in the secret store / Z.ai plan (not plain config) the
  // connection decision reads «none»; judge the selected provider's own credential instead of printing «미설정».
  const auth: AuthKind = selection && provider.auth === 'none' && selectedCredentialPresent(config, selection.provider)
    ? (selection.provider === 'openai-codex' ? 'oauth' : 'apikey') : provider.auth;
  const build = runningBuild();
  const version = versionLabel(build, buildCommitTime(build)).label;
  return { provider: selection?.provider ?? provider.provider, model: provider.model, auth, account, version };
}

/** The registry resolves `/status` and `/st` here; extra text is ignored because this is a fixed view. */
export async function runNextTuiStatusBranchRoute(
  input: string,
  host: NextTuiStatusHost,
  readSnapshot: (sessionId?: string) => NextTuiStatusSnapshot = readStatusSnapshot,
): Promise<void> {
  if (!/^\/(?:status|st)(?:\s|$)/u.test(input.trim())) return;
  host.addLines(...renderNextTuiStatus(readSnapshot(host.sessionId)));
}
