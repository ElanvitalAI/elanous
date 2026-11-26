import type { Command } from 'commander';
import type { LLMProvider } from '../llm.js';
import { detectProviders, type DetectedProvider } from '../llm/provider-detect.js';
import { probeProvider, type ProviderProbeResult } from '../llm/provider-probe.js';
import { openrouterSource } from '../registry/discovery/sources/openrouter.js';
import { getUserConfig, reloadUserConfig, saveUserConfig, userConfigPath } from '../user-config.js';
import type { UserConfig } from '../user-config/types.js';

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
  discoverUpstageModels?: () => Promise<string[] | null>;
}

export interface LlmDetectResult {
  candidates: Array<DetectedProvider & { probe?: ProviderProbeResult; command?: string }>;
  selected: string | null;
  applied: boolean;
  /** Why a selected provider was not written (an explicit llm.provider is never overwritten). */
  notApplied?: string;
  error?: string;
  /** OpenRouter /models candidates; null means discovery was unavailable, not an empty catalogue. */
  upstageCandidates?: string[] | null;
}

async function discoverUpstageModels(): Promise<string[] | null> {
  const result = await openrouterSource.run({ timeoutMs: 3_000 });
  if (!result.ok) return null;
  return result.models.map(({ id }) => id).filter((id) => /^upstage\/[^/]+$/.test(id))
    .map((id) => `openrouter/${id}`).sort();
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

  let upstageCandidates: string[] | null | undefined;
  if (!options.apply && (!options.probe || selected === 'openrouter')
    && rows.some((row) => row.provider === 'openrouter' && row.available && row.auth === 'apikey')) {
    try { upstageCandidates = await (deps.discoverUpstageModels ?? discoverUpstageModels)(); }
    catch { upstageCandidates = null; }
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
  const result: LlmDetectResult = { candidates: rows, selected, applied,
    ...(upstageCandidates !== undefined ? { upstageCandidates } : {}), ...(notApplied ? { notApplied } : {}) };
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
    if (upstageCandidates !== undefined) output(upstageCandidates === null
      ? 'Upstage candidates: catalogue unavailable'
      : `Upstage candidates: ${upstageCandidates.join(', ') || '(none in OpenRouter /models)'}`);
    if (applied) output(`Applied llm.provider=${selected} — revert: elanous config set llm.provider auto`);
    if (notApplied) output(notApplied);
  }
  return result;
}

export function registerLlmDetectCommand(program: Command): void {
  const llmCommand = program.command('llm [text...]')
    .description('Ask a model without Elanous context, tools, or a session; use `detect` to inspect providers')
    .option('--json', 'Emit one JSON line with provider, model, and reply')
    .action(async (parts: string[] = [], options: { json?: boolean }) => {
      const text = parts.join(' ');
      if (!text.trim()) {
        console.error("error: missing required argument 'text'");
        process.exitCode = 1;
        return;
      }
      try {
        const { llmQuery } = await import('./llm-cli.js');
        const llm = await import('../llm.js');
        const { getUserConfig } = await import('../user-config.js');
        const { trimToBudget } = await import('../tokens.js');
        // Plain mode streams the reply as it arrives (an orchestration's reduce tab fills in live); --json stays one line.
        let streamed = false;
        const onDelta = options.json ? undefined : (delta: string): void => { if (delta) { streamed = true; process.stdout.write(delta); } };
        const result = await llmQuery({ text, ...(onDelta ? { onDelta } : {}), deps: {
          getUserConfig, decideProviderForConfig: llm.decideProviderForConfig, getProviderForConfig: llm.getProviderForConfig,
          streamLLM: llm.streamLLM, trimToBudget,
        } });
        if (options.json) process.stdout.write(JSON.stringify({ sessionId: null, ...result, logPath: null, budget: null }) + '\n');
        else if (streamed) process.stdout.write('\n');
        else process.stdout.write(result.reply.endsWith('\n') ? result.reply : `${result.reply}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) process.stdout.write(JSON.stringify({ error: message }) + '\n');
        else console.error(`llm failed: ${message}`);
        process.exitCode = 1;
      }
    });
  llmCommand.command('detect').description('이 기계에 이미 있는 구독·키를 찾아 순위대로 보여 준다 (--probe 한 턴 검증 · --apply 는 llm.provider 가 auto 일 때만 쓴다)')
    .option('--probe', '위에서부터 한 턴(«OK») 검증해 첫 통과를 고른다')
    .option('--apply', '검증을 통과한 공급자를 llm.provider 로 저장 (--probe 필요 · 이미 명시돼 있으면 안 바꾼다)')
    .option('--json', 'JSON 출력')
    .action(async (opts: LlmDetectOptions) => {
      const result = await runLlmDetect(opts);
      if (result.error) process.exitCode = 2;
    });
  // LLM 지출 정책 한 장(ONE-SHOT) — 조회만. 쓰기는 «패널» 칸(넥서스 편집 API · owner 인증)이 맡는다.
  const policyCommand = llmCommand.command('policy').description('LLM 지출 정책 한 장 — 적용 값 전부(코드 기본+저장 덮어씀) · 각 값 출처(default/yaml) · 공급자 상태는 주입된 실측만(없으면 unmeasured)')
    .option('--json', 'JSON 출력(패널·시험용)')
    .action(async (opts: { json?: boolean }) => {
      const { runLlmPolicyView } = await import('./llm-policy-cli.js');
      await runLlmPolicyView({ json: Boolean(opts.json) });
    });
  // 합성 사건 주입 — 정책이 있는 우주에서만. 관측 저장소 source 'synthetic' + 전환 원장 synthetic:true 강제 표시. 비밀 입력 0.
  policyCommand.command('inject').description('합성 사건 «결정 드라이런» — 지금 이 사건이면 무엇을 골랐나(실호출 0 · 실 저장소 쓰기 0) · 정책 정본이 있는 우주에서만')
    .option('--row <행>', '정책 행 이름')
    .option('--event <사건>', 'usage_limit_reached|insufficient_credits|window-reset|spend-cap|auto-topup|window-usage')
    .option('--resets-at <ISO>', 'usage_limit_reached 의 창 리셋 시각')
    .option('--used-pct <N>', 'window-usage 의 창 사용률(%)')
    .option('--slope-pct-per-hour <N>', 'window-usage 의 소진 기울기(%/h)')
    .option('--amount-usd <N>', 'spend-cap(지출액)·auto-topup(충전액) USD')
    .option('--role <역할>', '드라이런 결정 요청 역할(기본 authoring)')
    .option('--difficulty <등급>', 'high|mid|low')
    .option('--model <모델>', '드라이런 요청 모델')
    .option('--live-synthetic', '시험 우주 전용 — 실 관문 저장소에 합성 관측 저장(시험 우주 신원 필요 · 운영 신원이면 거부)')
    .option('--json', 'JSON 출력')
    .action(async (opts: { row?: string; event?: string; resetsAt?: string; amountUsd?: string; usedPct?: string; slopePctPerHour?: string; role?: string; difficulty?: string; model?: string; liveSynthetic?: boolean; json?: boolean }) => {
      const { runLlmPolicyInject } = await import('./llm-policy-cli.js');
      const result = await runLlmPolicyInject({
        ...(opts.row !== undefined ? { row: opts.row } : {}), ...(opts.event !== undefined ? { event: opts.event } : {}),
        ...(opts.resetsAt !== undefined ? { resetsAt: opts.resetsAt } : {}), ...(opts.amountUsd !== undefined ? { amountUsd: opts.amountUsd } : {}),
        ...(opts.usedPct !== undefined ? { usedPct: opts.usedPct } : {}), ...(opts.slopePctPerHour !== undefined ? { slopePctPerHour: opts.slopePctPerHour } : {}),
        ...(opts.role !== undefined ? { role: opts.role } : {}), ...(opts.difficulty !== undefined ? { difficulty: opts.difficulty } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}), liveSynthetic: Boolean(opts.liveSynthetic), json: Boolean(opts.json),
      });
      if (!result.ok) process.exitCode = 2;
    });
  // LLM 지출 절감 영수 — SMART-ROUTER-DEMO-SAVINGS(타임리 시연 · OP #116366). 실측 원장(llm-usage)만 · 가격 비공개(비율만).
  llmCommand.command('savings').description('스마트 라우터 절감 영수 — 실측 원장 창의 호출 표 · 고급/전체 · «강 단독» 대비 절감 비율(가격·금액 비공개)')
    .option('--premium-model <모델>', '«강 단독» 기준 모델 id(필수 — 이 모델로 다 돌았을 때와 비교)')
    .option('--premium-include <모델들>', '고급 호출 수에 추가할 정확한 모델 id(쉼표 구분); 비용 기준 모델은 바꾸지 않는다')
    .option('--minutes <N>', '측정 창(분 · 기본 60)')
    .option('--run-id <id>', '특정 런만')
    .option('--json', 'JSON 출력(영수 수치)')
    .action(async (opts: { premiumModel?: string; premiumInclude?: string; minutes?: string; runId?: string; json?: boolean }) => {
      const { runLlmSavings } = await import('./llm-savings-cli.js');
      if (opts.premiumInclude !== undefined && opts.premiumInclude.split(',').some(value => !value.trim())) {
        console.error('--premium-include requires comma-separated model IDs'); process.exitCode = 2; return;
      }
      const minutes = opts.minutes !== undefined ? Number(opts.minutes) : undefined;
      const result = await runLlmSavings({
        ...(opts.premiumModel !== undefined ? { premiumModel: opts.premiumModel } : {}),
        ...(opts.premiumInclude !== undefined ? { premiumModels: opts.premiumInclude.split(',').map(value => value.trim()).filter(Boolean) } : {}),
        ...((minutes !== undefined && Number.isFinite(minutes)) ? { minutes } : {}),
        ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
        json: Boolean(opts.json),
      });
      if (result.error) { console.error(result.error); process.exitCode = 2; }
    });
}
