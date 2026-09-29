import type { Command } from 'commander';
import type { LLMProvider } from '../llm.js';
import { detectProviders, type DetectedProvider } from '../llm/provider-detect.js';
import { probeProvider, type ProviderProbeResult } from '../llm/provider-probe.js';
import {
  getUserConfig, reloadUserConfig, saveUserConfig, userConfigPath,
  type UserConfig,
} from '../user-config.js';

export interface LlmDetectOptions {
  json?: boolean;
  probe?: boolean;
  apply?: boolean;
}

export interface LlmDetectDeps {
  detect?: () => Promise<DetectedProvider[]>;
  resolve?: (candidate: DetectedProvider, config: UserConfig) => LLMProvider;
  probeProvider?: (provider: LLMProvider) => Promise<ProviderProbeResult>;
  config?: () => UserConfig;
  save?: (config: UserConfig) => void;
  output?: (line: string) => void;
}

export interface LlmDetectResult {
  candidates: Array<DetectedProvider & { probe?: ProviderProbeResult; command?: string }>;
  selected: string | null;
  applied: boolean;
  /** Why a selected provider was not written (an explicit llm.provider is never overwritten). */
  notApplied?: string;
  error?: string;
}

/** Discovery alone cannot validate credentials. Only a successful probe can select a provider. */
export async function runLlmDetect(
  options: LlmDetectOptions = {}, deps: LlmDetectDeps = {},
): Promise<LlmDetectResult> {
  const output = deps.output ?? console.log;
  if (options.apply && !options.probe) {
    const result: LlmDetectResult = { candidates: [], selected: null, applied: false, error: '--apply requires --probe' };
    output(options.json ? JSON.stringify(result) : result.error!);
    return result;
  }

  const config = (deps.config ?? getUserConfig)();
  const candidates = (await (deps.detect ?? detectProviders)())
    .sort((a, b) => a.rank - b.rank)
    .map(({ provider, auth, source, available, rank, agent }) => ({
      provider, auth, source, available, rank, ...(agent ? {
        agent, command: `elanous agent-mission … --backend ${agent.cli === 'claude' ? 'claude' : 'gemini'}`,
      } : {}),
    }));
  const rows: LlmDetectResult['candidates'] = candidates;
  let selected: string | null = null;
  if (options.probe) {
    for (const candidate of rows) {
      if (!candidate.available || candidate.auth === 'agent-cli') continue;
      try {
        const provider = await (deps.resolve ?? (async (entry, cfg) => {
          const { getProviderForConfig } = await import('../llm.js');
          return getProviderForConfig({
            ...cfg,
            llm: { ...cfg.llm, provider: entry.provider as UserConfig['llm']['provider'] },
          });
        }))(candidate, config);
        if (provider.name !== candidate.provider || !provider.available()) continue;
        const outcome = await (deps.probeProvider ?? probeProvider)(provider);
        candidate.probe = {
          success: outcome.success, durationMs: outcome.durationMs, model: outcome.model,
          ...(outcome.error ? { error: ['timeout', 'empty response', 'probe failed'].includes(outcome.error) ? outcome.error : 'probe failed' } : {}),
        };
        if (outcome.success) { selected = candidate.provider; break; }
      } catch {
        candidate.probe = { success: false, durationMs: 0, model: '', error: 'probe failed' };
      }
    }
  }

  let applied = false;
  let notApplied: string | undefined;
  const previous = config.llm?.provider ?? 'auto';
  if (options.apply && selected && previous !== 'auto') {
    notApplied = `llm.provider is already ${previous} — left unchanged`;
  } else if (options.apply && selected) {
    const next = { ...config, llm: { ...config.llm, provider: selected as UserConfig['llm']['provider'] } };
    if (deps.save) deps.save(next);
    else {
      const path = userConfigPath();
      saveUserConfig(next, path);
      reloadUserConfig(path);
    }
    applied = true;
  }
  const result: LlmDetectResult = { candidates: rows, selected, applied, ...(notApplied ? { notApplied } : {}) };
  if (options.json) output(JSON.stringify(result));
  else {
    if (rows.length === 0) output('No LLM providers detected.');
    for (const row of rows) {
      if (row.auth === 'agent-cli') {
        const claude = row.agent?.cli === 'claude';
        const stored = claude && row.agent?.loggedIn === true && row.agent.storedLoggedIn === true;
        const sessionOnly = claude && row.agent?.loggedIn === true && row.agent.storedLoggedIn === false;
        const status = stored ? 'logged-in (stored)'
          : sessionOnly ? 'session token only — run `claude` then `/login` in a normal terminal for unattended use'
          : row.agent?.loggedIn === true ? 'logged-in' : row.agent?.loggedIn === false ? 'logged-out' : 'login unknown';
        const method = !stored && !sessionOnly && row.agent?.method
          ? ` (${row.agent.method === 'claude.ai' || row.agent.method === 'oauth_token' ? 'oauth' : row.agent.method})` : '';
        output(`agent  ${row.provider}  ${status}${method}  → ${row.command}`);
      } else {
        output(`${row.provider}  ${row.auth}  ${row.source}  ${row.probe ? (row.probe.success ? `probe passed (${row.probe.model})` : `probe ${row.probe.error ?? 'failed'}`) : 'not probed'}`);
      }
    }
    if (options.probe && !selected) output('No provider passed the probe; configuration unchanged.');
    if (applied) output(`Applied llm.provider=${selected} — revert: elanous config set llm.provider auto`);
    if (notApplied) output(notApplied);
  }
  return result;
}

export function registerLlmDetectCommand(program: Command): void {
  program.command('llm').description('LLM 공급자')
    .command('detect').description('이 기계에 이미 있는 구독·키를 찾아 순위대로 보여 준다 (--probe 한 턴 검증 · --apply 는 llm.provider 가 auto 일 때만 쓴다)')
    .option('--probe', '위에서부터 한 턴(«OK») 검증해 첫 통과를 고른다')
    .option('--apply', '검증을 통과한 공급자를 llm.provider 로 저장 (--probe 필요 · 이미 명시돼 있으면 안 바꾼다)')
    .option('--json', 'JSON 출력')
    .action(async (opts: LlmDetectOptions) => {
      const result = await runLlmDetect(opts);
      if (result.error) process.exitCode = 2;
    });
}
