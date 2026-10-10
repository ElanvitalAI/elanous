import type { Command } from 'commander';
import { resolve } from 'node:path';
import { getUserConfig, reloadUserConfig } from '../user-config.js';
import { handleOnboardingRefusal, needsOnboarding, runOnboarding } from '../onboarding.js';
import { runTurn, ensureCliSession, sessionBudget } from '../session/chat.js';
import { suggestProjectForFolder } from '../project/project-store.js';
import { NoLlmProviderAvailableError, noProviderAvailableMessage } from '../llm.js';
import { resolveSessionId, getActiveSessionId, setActiveSessionId } from '../session/index.js';
import { getHarnessSpace } from '../harness/harness-space.js';
import { encodeDetachedProgressFrame } from '../harness/dispatch-detached.js';
import type { FeedbackEnvelope } from '../feedback/envelope.js';
import { buildPlanTool, buildMarkStepDoneTool, dispatchPlan, dispatchMarkStepDone } from '../boot/daemon-tools/index.js';
import { applyDocumentReferences, applyHarnessPolicy, DOCUMENT_REFERENCES_ENV, HARNESS_POLICY_ENV } from '../self-implement/harness-policy.js';
import { inspectActiveProvider, oneLineProvider } from '../provider-summary.js';
import { writeStdoutJson } from './stdout-json.js';
import { debug } from '../debug/log.js';
import * as ui from '../ui.js';

export function emitDetachedProgress(
  env: FeedbackEnvelope,
  writeLine: (line: string) => void = (line) => process.stdout.write(line),
): void {
  const payloadLines = 'lines' in env.payload && Array.isArray(env.payload.lines) ? env.payload.lines : undefined;
  const humanLine = payloadLines?.[0] ?? env.asciiFallback[0] ?? '';
  const normalizedHumanLine = String(humanLine).replace(/\n/g, ' ');
  if (humanLine) writeLine(`PROGRESS:${normalizedHumanLine}\n`);
  const sharedFrame = {
    version: 1 as const,
    planId: env.blockId,
    seq: env.seq,
    ...(humanLine ? { humanLine: normalizedHumanLine } : {}),
  };
  const stepId = 'stepId' in env.payload && typeof env.payload.stepId === 'string'
    ? env.payload.stepId
    : env.phase;
  const frame = env.kind === 'agent.plan'
    ? { ...sharedFrame, kind: 'plan' as const }
    : { ...sharedFrame, kind: 'step' as const, stepId };
  writeLine(`${encodeDetachedProgressFrame(frame)}\n`);
}

export function emitHarnessFeedbackProgress(
  env: FeedbackEnvelope,
  writeLine: (line: string) => void = (line) => process.stdout.write(line),
): void {
  emitDetachedProgress(env, writeLine);
}
// ── agent (chat with tool loop on) ──
// Declared as `.command('agent').argument('[text...]')` rather than
// `.command('agent <text...>')` so the `dispatch` sub-command below can hang
// off it. Commander 13 routes `agent dispatch …` to the sub-command and
// everything else to this action (verified against commander 13.1 before the
// change). The argument is optional at the parser level only — an empty
// invocation is rejected explicitly in the action so the operator still gets
// a named failure instead of an empty turn.
type CliAgentDispatch = typeof import('../skills/tools/agent.js').dispatchAgent;
let cliAgentDispatchForTesting: CliAgentDispatch | undefined;

export function setCliAgentDispatchForTesting(dispatch: CliAgentDispatch | undefined): void {
  cliAgentDispatchForTesting = dispatch;
}

export function registerAgentCommands(program: Command): void {
  const agentCommand = program
  .command('agent')
  .argument('[text...]', 'Prompt text for the single-turn agent.')
  .description('Single-turn agent — same as `chat` but with the tool loop on by default (Read/Grep/Glob/ListDir/Edit/Write + Bash). Use this when the LLM needs to inspect files / run commands / debug itself.')
  .option('--new', 'Force a new session instead of using the active one')
  .option('--session <id>', 'Continue an explicit session (id or unique prefix). Overrides --new and active session.')
  .option('--json', 'Emit a single JSON line {sessionId, provider, model, reply, logPath, budget} instead of streaming text + ui.info trailer. Stable shape for LLM self-spawn.')
  .option('--no-tools', 'Disable the tool loop and fall back to text-only chat (for benchmarking / parity with `chat`).')
  .action(async (parts: string[], opts: { new?: boolean; session?: string; json?: boolean; tools?: boolean }) => {
    if (!parts || parts.length === 0) {
      console.error("error: missing required argument 'text'");
      process.exit(1);
    }
    // `elanous agent` is a standalone process that does not inherit the nexus
    // StoreSink, so register the agent logs.db sink first — otherwise core-turn
    // debug.log (e.g. capability.resolve) never reaches logs.db. Fail-open:
    // logging must never block the agent turn. See src/chat/agent-cli-entry.ts.
    try {
      const { initializeAgentCliLogSink } = await import('../chat/agent-cli-entry.js');
      await initializeAgentCliLogSink();
    } catch (err) {
      // Fail-open: logging must never block the agent turn. But do not go fully
      // silent — surface the sink failure to the file trail (FileSink, independent
      // of the StoreSink that just failed) so an observability outage is itself
      // observable. Uses debug.log, not stdout, so the --json contract stays intact.
      try {
        const { debug } = await import('../debug/log.js');
        debug.log('agent.log-sink', 'register-failed', { error: String(err) }, { level: 'warn' });
      } catch { /* diagnostics are best-effort */ }
    }
    const cfg = getUserConfig();
    if (needsOnboarding(cfg)) {
      ui.info('No config yet — launching setup wizard first.');
      try {
        await runOnboarding();
      } catch (error) {
        if (handleOnboardingRefusal(error, 'agent')) return;
        throw error;
      }
    }
    const refreshed = reloadUserConfig();
    await runChatTurnCli({
      cfg: refreshed,
      userText: parts.join(' '),
      explicitSessionId: opts.session,
      reuseActive: opts.new !== true,
      forceNew: opts.new === true,
      json: opts.json === true,
      // commander stores --no-tools as `tools: false`, plain absence as undefined → default true here.
      enableTools: opts.tools !== false,
    });
  });

// ── agent dispatch — RFC #7333 `A1` (트리거) ──
//
// The `Agent` sub-agent tool has existed and been fully instrumented
// (`agent.spawn.dispatch` → `agent.done.finish`) for months, but it had NO
// human entrance: measured 2026-08-23, all 15 recorded dispatches came from an
// LLM deciding to call the tool mid-turn. That is exactly the gap the RFC
// names — *"장치는 있고 관측도 끝까지 있다. 없는 것은 「쓴 적」이다."*
//
// A CLI sub-command (rather than a TUI slash) is deliberate: the point of A1
// is to make SAMPLES, and only a scriptable entrance lets an operator fan out
// repeat dispatches and diff them. It also keeps the result on stdout with a
// real exit code, instead of the hidden-pane output path that slash commands
// currently take.
agentCommand
  .command('dispatch <subagent_type> <prompt...>')
  .description('Spawn one sub-agent from the terminal and print its final message. Observe with `elanous logs --category agent.spawn` / `--category agent.done` — the printed cid pairs the two.')
  .option('--description <text>', 'Short label for the spawn (3–8 words). Defaults to the first 8 words of the prompt.')
  .option('--max-turns <n>', 'Tool-loop budget for the sub-agent. Defaults to the Agent tool default.')
  .option('--background', 'Return as soon as the child is spawned instead of waiting for its final message.')
  .option('--isolation <mode>', 'Child isolation: "worktree" (fresh git worktree + branch) or "cwd".')
  .option('--name <label>', 'UI label for this spawn (agent-roster / logs).')
  .option('--quiet', 'Suppress the per-tool progress lines on stderr.')
  .option('--json', 'Emit one JSON line {cid, agent, taskId, durationMs, background, isolation, cwd, output} instead of human text.')
  .action(async (
    subagentType: string,
    promptParts: string[],
    o: {
      description?: string; maxTurns?: string; background?: boolean;
      isolation?: string; name?: string; quiet?: boolean; json?: boolean;
    },
  ) => {
    // Same rationale as `elanous agent`: a standalone CLI process does not
    // inherit the nexus StoreSink, so without this the dispatch would run but
    // `elanous logs --category agent.spawn` would show nothing — the exact
    // "instrumented but invisible" failure this command exists to close.
    try {
      const { initializeAgentCliLogSink } = await import('../chat/agent-cli-entry.js');
      await initializeAgentCliLogSink();
    } catch (err) {
      try {
        const { debug } = await import('../debug/log.js');
        debug.log('agent.log-sink', 'register-failed', { error: String(err) }, { level: 'warn' });
      } catch { /* diagnostics are best-effort */ }
    }

    // Validate before spawning. Bad input must fail by NAME, not by silently
    // falling through to a default that makes the run look successful.
    let maxTurns: number | undefined;
    if (o.maxTurns !== undefined) {
      const n = Number(o.maxTurns);
      if (!Number.isFinite(n) || n < 1) {
        console.error(`Agent dispatch blocked: --max-turns must be a positive number — got ${JSON.stringify(o.maxTurns)}.`);
        process.exit(2);
      }
      maxTurns = n;
    }
    if (o.isolation !== undefined && o.isolation !== 'worktree' && o.isolation !== 'cwd') {
      console.error(`Agent dispatch blocked: --isolation must be "worktree" or "cwd" — got ${JSON.stringify(o.isolation)}.`);
      process.exit(2);
    }

    const prompt = promptParts.join(' ').trim();
    if (!prompt) {
      console.error('Agent dispatch blocked: prompt is empty.');
      process.exit(2);
    }
    const description = o.description?.trim()
      ? o.description.trim()
      : prompt.split(/\s+/).slice(0, 8).join(' ');

    const cfg = reloadUserConfig();
    // The child gets the CLI coding core (Read/Grep/Glob/ListDir/Edit/Write +
    // Bash + shared app tools). Note this catalog does NOT contain `Agent`
    // itself, so a dispatched child cannot recurse into another spawn.
    const built = buildCliAgentTools(cfg);
    const buildChildToolCatalog = (childCwd: string) => buildCliAgentTools(cfg, undefined, childCwd);
    const controller = new AbortController();
    const onSigint = (): void => controller.abort();
    process.once('SIGINT', onSigint);

    try {
      const dispatchAgent = cliAgentDispatchForTesting
        ?? (await import('../skills/tools/agent.js')).dispatchAgent;
      const res = await dispatchAgent({
        description,
        prompt,
        subagent_type: subagentType,
        ...(maxTurns !== undefined ? { max_turns: maxTurns } : {}),
        ...(o.background ? { run_in_background: true } : {}),
        ...(o.isolation ? { isolation: o.isolation } : {}),
        ...(o.name ? { name: o.name } : {}),
      }, {
        hostTools: built.specs,
        dispatchTool: built.dispatch,
        buildChildToolCatalog,
        signal: controller.signal,
        // Progress goes to stderr so `--json` (and plain stdout capture) stay
        // machine-clean while a human watching the terminal still sees motion.
        ...(o.quiet || o.json ? {} : {
          onChildToolCall: (ev: { name: string; callIdx: number }) => {
            process.stderr.write(`  ⎿ ${ev.name} (#${ev.callIdx})\n`);
          },
        }),
      });

      // `cid` is optional on the type for a gate reason documented at its
      // declaration, but dispatchAgent sets it on every return path. If it is
      // ever missing, say so by name rather than printing `cid=undefined` —
      // a silent `undefined` would look like a working key that finds nothing.
      const cid = res.cid ?? '(cid-missing)';
      if (o.json) {
        await writeStdoutJson(JSON.stringify({
          cid,
          agent: res.agent,
          taskId: res.taskId,
          durationMs: res.durationMs,
          maxTurns: res.maxTurns,
          ...(res.background ? { background: true } : {}),
          ...(res.isolation ? { isolation: res.isolation } : {}),
          ...(res.cwd ? { cwd: res.cwd } : {}),
          output: res.output,
        }) + '\n');
      } else {
        console.log(res.output);
        // The cid trailer is the whole point of the entrance: it is the key
        // that pairs this dispatch against agent.spawn / agent.done.
        console.error(
          `\n[agent dispatch] cid=${cid} agent=${res.agent} taskId=${res.taskId} `
          + `durationMs=${res.durationMs}${res.background ? ' background=true' : ''}`
          + `\n[agent dispatch] observe: elanous logs --category agent.done --json --json-data | rg ${cid}`,
        );
      }
    } catch (err) {
      console.error(`Agent dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
  });

// ── elanous registry — 모델 카탈로그 SSoT 관측(drift 자기감지·제1원칙) ──
const registryCmd = program
  .command('registry')
  .description('모델 카탈로그(catalog/=SSoT) 관측 — 라우팅 맵 drift 감사');
registryCmd.hook('preAction', async () => {
  try {
    const { registerStandaloneLogSink } = await import('../domains/standalone-log-sink.js');
    await registerStandaloneLogSink('registry');
  } catch { /* fail-open — observation wiring must not block registry */ }
});
registryCmd
  .command('drift')
  .description('라우팅 핀(alias·tier-map·mission-router)이 catalog active id 와 정합인지 감사 — HITL 역제안(자동 집행 없음)')
  .option('--json', 'JSON 출력(미션/프로그래매틱 소비)')
  .action(async (opts: { json?: boolean }) => {
    const { detectRoutingDrift, buildRoutingDriftRecommendation } = await import('../registry/llm-routing-drift.js');
    const drift = detectRoutingDrift();
    try { const { debug } = await import('../debug/log.js'); debug.log('llm.drift', 'audit', { count: drift.length, models: drift.map((d) => d.model) }); } catch { /* fail-soft */ }
    if (opts.json) { await writeStdoutJson(JSON.stringify(drift, null, 2) + '\n'); return; }
    if (!drift.length) { ui.info('✅ 라우팅 맵 drift 없음 — 모든 핀이 catalog SSoT 와 정합'); return; }
    ui.header(`LLM 라우팅 drift ${drift.length}건 (catalog SSoT 미정합 · HITL 역제안·자동 집행 없음)`);
    for (const d of drift) console.log(`  [${d.status}] ${buildRoutingDriftRecommendation(d)}`);
  });

// 대표 2026-09-23 «카탈로그를 파생한다» — 고른 소스만 돌려 스냅숏에 «병합». ⛔ S3 푸시 없음(이 문엔 그 칸이 없다).
//   기본은 드라이런(쓰지 않는다) — `--write` 일 때만 스냅숏 파일을 바꾼다.
registryCmd
  .command('discover')
  .description('발견 소스를 골라 돌리고 기존 스냅숏에 병합 — 기본 드라이런 · --write 로 기록 · S3 푸시 없음')
  .option('--source <id...>', '돌릴 소스 id (여러 개 가능 · 예: openrouter)')
  .option('--write', '스냅숏 파일에 병합해 기록한다(없으면 드라이런)')
  .option('--json', 'JSON 출력')
  .action(async (opts: { source?: string[]; write?: boolean; json?: boolean }) => {
    const { BUILTIN_SOURCES, runDiscovery } = await import('../registry/discovery/runner.js');
    const { readDiscoveryCache, defaultDiscoveryCachePath } = await import('../registry/discovery/cache.js');
    const { mergeDiscoverySnapshot } = await import('../registry/discovery/merge.js');
    const known = BUILTIN_SOURCES.map((x) => x.id);
    const wanted = opts.source ?? [];
    const unknown = wanted.filter((id) => !known.includes(id as never));
    if (!wanted.length || unknown.length) {
      ui.error(`--source 를 주십시오${unknown.length ? ` (모르는 id: ${unknown.join(', ')})` : ''} — 가능: ${known.join(', ')}`);
      process.exit(2);
    }
    const sources = BUILTIN_SOURCES.filter((x) => wanted.includes(x.id));
    const { results } = await runDiscovery({ sources, skipCacheWrite: true, s3Push: false });
    const path = defaultDiscoveryCachePath();
    const prev = readDiscoveryCache({ cachePath: path });
    const merged = mergeDiscoverySnapshot(prev, results);
    const summary = {
      path, write: !!opts.write, prevGeneratedAt: prev?.generatedAt ?? null,
      prevModels: prev?.models.length ?? 0, mergedModels: merged.models.length,
      sources: results.map((r) => ({ id: r.source, ok: r.ok, models: r.models.length, ...(r.error ? { error: r.error } : {}) })),
    };
    try { const { debug } = await import('../debug/log.js'); debug.log('registry.discovery', 'discover-cli', summary); } catch { /* fail-soft */ }
    if (opts.write) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(merged, null, 2), 'utf-8');
    }
    if (opts.json) { await writeStdoutJson(JSON.stringify(summary, null, 2) + '\n'); return; }
    for (const r of summary.sources) console.log(`  ${r.ok ? '✅' : '⛔'} ${r.id}: ${r.models}개${r.error ? ` · ${r.error}` : ''}`);
    console.log(`  스냅숏 ${summary.prevModels} → ${summary.mergedModels}개 (직전 ${summary.prevGeneratedAt ?? '없음'}) · ${path}`);
    console.log(opts.write ? '  ✍️ 기록했다 — 카탈로그 폴드는 다음 로드(데몬 재시작·reloadCatalog)부터 보인다.' : '  🔎 드라이런 — 기록하려면 --write');
    if (summary.sources.some((r) => !r.ok)) process.exitCode = 1;
  });

// ── tier SSOT — provider × tier → 모델 authoritative 조회(대표: "grok low tier" 헷갈림 종식) ──
const tierCmd = program
  .command('tier')
  .description('LLM tier→모델 SSOT 조회 — provider별 budget/balanced/better/best/loaded 사다리(llm-tier-map). "grok low" 같은 별칭 흡수.');

tierCmd
  .command('resolve <provider> [tier]', { isDefault: true })
  .description('provider(+tier) → 모델 해석. tier 생략 시 5단 전부. 별칭 low/mid/high/max 허용.')
  .option('--json', 'JSON 출력')
  .action(async (provider: string, tier: string | undefined, opts: { json?: boolean }) => {
    const m = await import('../model-tier/llm-tier-map.js');
    const t = await import('../model-tier/types.js');
    const prov = provider.toLowerCase() as any;
    const map = m.LLM_TIER_MAP_BY_PROVIDER[prov as keyof typeof m.LLM_TIER_MAP_BY_PROVIDER];
    if (!map) { ui.error(`알 수 없는 provider: ${provider} (가능: ${m.TIER_PROVIDERS.join(', ')})`); process.exit(2); }
    const rows = (tier ? [m.parseTierArg(tier)].filter(Boolean) as any[] : t.MODEL_TIERS) as readonly (typeof t.MODEL_TIERS)[number][];
    if (tier && !rows.length) { ui.error(`알 수 없는 tier: ${tier} (canonical: ${t.MODEL_TIERS.join('/')} · 별칭: low/mid/high/max)`); process.exit(2); }
    if (opts.json) {
      await writeStdoutJson(JSON.stringify(rows.map((tk) => ({ provider: prov, tier: tk, ...map[tk] })), null, 2) + '\n');
      return;
    }
    ui.header(`🎚️  ${prov} tier SSOT${tier ? ` · ${tier}→${m.parseTierArg(tier)}` : ''}`);
    for (const tk of rows) {
      const s = map[tk];
      console.log(`  ${t.MODEL_TIER_LABELS[tk].padEnd(9)} → ${s.model.padEnd(30)} ${s.reasoningLevel ? `[reasoning:${s.reasoningLevel}]` : ''} · ${s.rationale}${s.status === 'wip' ? ' ⚠️wip' : ''}`);
    }
  });

tierCmd
  .command('list [provider]')
  .alias('ls')
  .description('전체 매트릭스(provider × 5 tier) 또는 한 provider. tier 헷갈림 방지용 한눈 표.')
  .option('--json', 'JSON 출력')
  .action(async (provider: string | undefined, opts: { json?: boolean }) => {
    const m = await import('../model-tier/llm-tier-map.js');
    const t = await import('../model-tier/types.js');
    const provs = provider ? [provider.toLowerCase()] : m.TIER_PROVIDERS;
    if (opts.json) {
      const out: Record<string, unknown> = {};
      for (const p of provs) { const map = (m.LLM_TIER_MAP_BY_PROVIDER as any)[p]; if (map) out[p] = Object.fromEntries(t.MODEL_TIERS.map((tk) => [tk, map[tk].model])); }
      await writeStdoutJson(JSON.stringify(out, null, 2) + '\n'); return;
    }
    ui.header('🎚️  LLM tier→모델 SSOT 매트릭스 (llm-tier-map.ts · low=budget·mid=better·high=best·max=loaded)');
    console.log(`  ${'provider'.padEnd(13)} ${t.MODEL_TIERS.map((tk) => tk.padEnd(13)).join(' ')}`);
    console.log('  ' + '─'.repeat(13 + 14 * t.MODEL_TIERS.length));
    for (const p of provs) {
      const map = (m.LLM_TIER_MAP_BY_PROVIDER as any)[p];
      if (!map) { ui.error(`알 수 없는 provider: ${p}`); continue; }
      console.log(`  ${p.padEnd(13)} ${t.MODEL_TIERS.map((tk) => (map[tk].model.length > 13 ? map[tk].model.slice(0, 12) + '…' : map[tk].model).padEnd(13)).join(' ')}`);
    }
  });

tierCmd
  .command('providers')
  .description('tier ladder 가 정의된 provider 목록.')
  .action(async () => {
    const m = await import('../model-tier/llm-tier-map.js');
    console.log(m.TIER_PROVIDERS.join('\n'));
  });

}

/** Single-turn CLI driver shared by `elanous ask` and `elanous chat`.
 *
 *  Resolution order for sessionId:
 *    1. opts.explicitSessionId (`--session`)  — wins, validates against
 *       resolveSessionId so a 6-char prefix works
 *    2. active session                         — when reuseActive
 *    3. fresh session                          — otherwise
 *
 *  When `json` is true, the function suppresses the streaming text +
 *  ui.info trailer and instead emits exactly ONE JSON line on stdout
 *  at end-of-turn:
 *    {sessionId, provider, model, reply, finalReply, transcript, logPath,
 *     budget, durationMs, ts}
 *  Stable shape so LLMs can self-spawn `elanous chat` for follow-ups
 *  without parsing human-readable terminal output. */
export async function runChatTurnCli(opts: {
  cfg: ReturnType<typeof reloadUserConfig>;
  userText: string;
  explicitSessionId: string | undefined;
  reuseActive: boolean;
  forceNew: boolean;
  json: boolean;
  /** When true, build a CORE-native + Bash tool catalog and route
   *  through streamLLMWithTools so the LLM can drive multi-turn
   *  exploration (file reads, grep, shell). Default false — CLI
   *  chat path stays text-only and matches telegram/discord etc.
   *  for backward compatibility. `elanous agent` flips this on. */
  enableTools?: boolean;
  /** ⭐ substrate 통합 — goal-loop 아밍. true 면 tool-loop 을 runGoalLoop 으로 감싸
   *  목표 완료(GOAL-COMPLETE 증거게이트)까지 across-turn 반복. config
   *  llm.goalLoop.enabled 로도 아밍(ACP bridge 와 동일 SSOT). enableTools 필요. */
  goalLoop?: boolean;
  /** Test-only seam for observing the production CLI turn's final request without an LLM call. */
  runTurn?: typeof runTurn;
}): Promise<void> {
  const startedAt = Date.now();
  let resolvedSessionIdHint: string | undefined;
  if (opts.explicitSessionId) {
    const id = resolveSessionId(opts.explicitSessionId);
    if (!id) {
      const msg = `no session matching "${opts.explicitSessionId}"`;
      if (opts.json) await writeStdoutJson(JSON.stringify({ error: msg, sessionRequested: opts.explicitSessionId }) + '\n');
      else ui.error(msg);
      process.exit(1);
    }
    resolvedSessionIdHint = id;
  } else if (opts.reuseActive && !opts.forceNew) {
    resolvedSessionIdHint = getActiveSessionId() ?? undefined;
  }
  const session = ensureCliSession(opts.cfg, resolvedSessionIdHint);
  setActiveSessionId(session.id);
  if (!opts.json && (!resolvedSessionIdHint || session.id !== resolvedSessionIdHint)) {
    try {
      const project = suggestProjectForFolder(process.cwd());
      if (project) console.log(`Project suggestion: ${project.name} (${project.id})`);
    } catch { /* suggestions must not interrupt a CLI conversation */ }
  }
  const harnessSpace = getHarnessSpace();
  // Tag the debug log with this session id so every event in this
  // process attributes correctly. enrichDebugRecord picks up the
  // ambient value on the next event.
  try {
    const dbg = await import('../debug/log.js');
    dbg.setAmbientSessionId?.(session.id);
  } catch { /* debug module unavailable — fine */ }
  const replyChunks: string[] = [];
  // Tool calls delimit assistant messages. finalReply retains its last non-empty-message meaning.
  let segmentChunks: string[] = [];
  let lastSegment = '';
  let finalMessage = '';
  let sawToolCall = false;
  const closeSegment = (): void => {
    finalMessage = segmentChunks.join('').trim();
    if (finalMessage) lastSegment = finalMessage;
    segmentChunks = [];
  };
  if (!opts.json) {
    console.log(`[elanous] ${oneLineProvider(inspectActiveProvider(opts.cfg))}`);
    process.stdout.write('');  // flush
  }
  // Tool catalog + dispatcher — only built when enableTools is on
  // (i.e. `elanous agent` or `elanous chat --tools`). The catalog mirrors
  // the dashboard's CORE 6 native (Read/Grep/Glob/ListDir/Edit/Write)
  // and adds Bash so the LLM can shell out for self-debugging.
  // Scheduler/plugin/runtime tools are deliberately excluded — they
  // depend on dashboard wiring that isn't available in the CLI.
  let tools: ReturnType<typeof buildCliAgentTools> | undefined;
  let dispatchTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
  let enabledToolNames: string[] | undefined;
  if (opts.enableTools) {
    const built = buildCliAgentTools(opts.cfg, harnessSpace ? {
      sessionId: session.id,
      emitFeedback: emitHarnessFeedbackProgress,
    } : undefined);   // ★ cfg 전달 → financeEnabled 시 finance 팩 노출(서피스 게이팅 정리)
    tools = built;
    dispatchTool = built.dispatch;
    enabledToolNames = built.specs.map(s => s.name);
  }
  // Wire the universal preamble (project anchor + project tree +
  // family addendum + session-specific guidance) into every CLI system
  // prompt. Tool-enabled turns additionally pass their active tool names
  // so session-specific guidance remains unchanged.
  let agentSystemPrompt: string | undefined;
  try {
    const ulMod = require('../prompt-library/universal-preamble.js') as typeof import('../prompt-library/universal-preamble.js');
    const modelsMod = require('../models/prompts.js') as typeof import('../models/prompts.js');
    const modelId = opts.cfg.llm.model;
    const modelFamily = modelId ? modelsMod.getModelFamily(modelId) : undefined;
    const universal = ulMod.buildUniversalPreamble({
      cwd: process.cwd(),
      ...(modelFamily !== undefined ? { modelFamily } : {}),
      ...(enabledToolNames !== undefined ? { enabledTools: enabledToolNames } : {}),
    });
    const joined = universal
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .filter(s => s.length > 0)
      .join('\n\n');
    if (joined.length > 0) {
      agentSystemPrompt = joined;
    }
  } catch { /* universal-preamble unavailable — proceed without it */ }
  agentSystemPrompt = applyHarnessPolicy(agentSystemPrompt, process.env[HARNESS_POLICY_ENV]);
  agentSystemPrompt = applyDocumentReferences(agentSystemPrompt, process.env[DOCUMENT_REFERENCES_ENV]);
  // Archon-port T1.2 (2026-05-08) — apply user-config `chat.toolDeny`
  // to the CLI agent's tool roster. Prior to T1.2 this code path
  // ignored toolDeny entirely (only `eval-prompt-cli.ts` honored it),
  // so a global block list silently failed in `elanous ask`.
  let cliToolSpecs = tools?.specs;
  if (cliToolSpecs && opts.cfg.chat.toolDeny.length > 0) {
    const { applyToolPolicy } = require('../tool-runtime/tool-policy.js') as typeof import('../tool-runtime/tool-policy.js');
    cliToolSpecs = applyToolPolicy(cliToolSpecs, { deny: opts.cfg.chat.toolDeny }) ?? cliToolSpecs;
  }
  // ⭐ 도구 프로필(BACKLOG L1) — 하니스 구현 자식은 `ELANOUS_TOOL_PROFILE=coding` 으로 도메인·운영 도구를 뺀다.
  {
    const { activeToolProfile, applyToolProfile, omittedToolGroupsNote } = require('../agent/tool-profile.js') as typeof import('../agent/tool-profile.js');
    const profile = activeToolProfile();
    if (profile && cliToolSpecs) {
      const before = cliToolSpecs.length;
      const r = applyToolProfile(cliToolSpecs, profile);
      cliToolSpecs = r.tools;
      debug.log('chat.tools', 'profile-applied', { profile: profile.name, groups: [...profile.groups], before, after: cliToolSpecs?.length ?? 0, removed: r.removed });
      // ⭐ 뺀 묶음을 «한 줄»로 알린다 — 자식이 상황을 보고 ToolSearch 로 불러 쓴다(ToolSearch 는 전체 목록에서 찾는다).
      const note = omittedToolGroupsNote(r.removed);
      if (note) agentSystemPrompt = agentSystemPrompt ? `${agentSystemPrompt}\n\n${note}` : note;
    }
  }
  let result: Awaited<ReturnType<typeof runTurn>>;
  try {
    result = await (opts.runTurn ?? runTurn)({
      userConfig: opts.cfg,
      sessionId: session.id,
      userText: opts.userText,
      systemPrompt: agentSystemPrompt,
      onDelta: (d) => {
        replyChunks.push(d);
        segmentChunks.push(d);
        if (!opts.json && !opts.enableTools) process.stdout.write(d);
      },
      tools: cliToolSpecs,
      dispatchTool,
      ...(opts.goalLoop ? { goalLoop: true } : {}),
      onToolCall: (call) => {
        // The next delta belongs to the next assistant message.
        sawToolCall = true;
        closeSegment();
        if (!opts.json) {
          process.stdout.write(`\n  ⏺ ${call.name}(${truncateArgsForLog(call.args)})\n`);
        }
      },
      onToolResult: (call) => {
        if (!opts.json) {
          const preview = truncateResultForLog(call.result);
          process.stdout.write(`     ↳ ${preview}\n`);
        }
      },
    });
  } catch (err) {
    if (err instanceof NoLlmProviderAvailableError) {
      console.error(noProviderAvailableMessage());
      process.exit(2);
    }
    throw err;
  }
  if (!sawToolCall && replyChunks.length === 0 && result.text) {
    replyChunks.push(result.text);
    segmentChunks.push(result.text);
    if (!opts.json && !opts.enableTools) process.stdout.write(result.text);
  }
  closeSegment();
  if (opts.json) {
    let logPath: string | null = null;
    try {
      const dbg = await import('../debug/log.js');
      const status = dbg.debug?.status?.();
      if (status?.path) logPath = status.path;
    } catch { /* debug status unavailable — log path stays null */ }
    const out = {
      sessionId: session.id,
      provider: result.provider,
      model: result.model ?? null,
      reply: finalMessage,
      transcript: replyChunks.join(''),
      finalReply: lastSegment,
      budget: sessionBudget(session.id),
      durationMs: Date.now() - startedAt,
      logPath,
      ts: new Date().toISOString(),
    };
    await writeStdoutJson(JSON.stringify(out) + '\n');
    return;
  }
  if (opts.enableTools) process.stdout.write(`${finalMessage}\n`);
  else process.stdout.write('\n');
  ui.info(`[session ${session.id.slice(0, 8)}  ${result.provider}${result.model ? '/' + result.model : ''}  ${sessionBudget(session.id)}]`);
}

/** Build the CLI agent's minimal tool catalog + dispatcher. Returns
 *  the spec list to pass into runTurn's `tools` field plus a single
 *  dispatch function. Native tools are sourced from
 *  SESSION_NATIVE_TOOL_RULES (the same module the dashboard uses);
 *  Bash is added explicitly because it lives outside that registry
 *  (in the dashboard-optional umbrella). All dispatch errors are
 *  caught and returned as `{error: '...'}` so the tool loop can
 *  continue rather than aborting. */
export function buildCliAgentTools(
  cfg?: import('../user-config.js').UserConfig,
  harnessPlan?: {
    sessionId: string;
    emitFeedback: (env: import('../feedback/envelope.js').FeedbackEnvelope) => void;
  },
  trustedWorkingDirectory?: string,
): {
  specs: import('../llm.js').LLMToolSpec[];
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  workingDirectory: string;
} {
  // An explicitly assigned child cwd is stable for its isolated lifetime. An
  // omitted cwd deliberately remains late-bound at dispatch: the exposed
  // snapshot is only for trusted-catalog mismatch observation.
  const workingDirectory = trustedWorkingDirectory ?? process.cwd();
  const dispatchWorkingDirectory = (): string => trustedWorkingDirectory ?? process.cwd();
  const defaultSearchPath = trustedWorkingDirectory;
  const specs: import('../llm.js').LLMToolSpec[] = [];
  const dispatchByName = new Map<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>>();
  const resolveChildPath = (value: unknown): unknown =>
    typeof value === 'string' && !value.startsWith('/') ? resolve(dispatchWorkingDirectory(), value) : value;
  const bindWorkingDirectory = (name: string, args: Record<string, unknown>): Record<string, unknown> => {
    switch (name) {
      case 'Read':
      case 'Edit':
      case 'Write':
        return { ...args, file_path: resolveChildPath(args.file_path) };
      case 'Grep':
      case 'Glob':
      case 'ListDir':
        return { ...args, path: resolveChildPath(args.path ?? defaultSearchPath) };
      default:
        return args;
    }
  };
  // Native CORE — Read / Grep / Glob / ListDir / Edit / Write. Resolve through
  // the same surface profile the dashboard uses so behavior matches.
  // ★ turn 조립기 통일 Phase 2(2026-07-22) — native 코딩코어 조립을 buildCodingCoreNativeSpecs 단일
  //   출처로(continuation-turn-runner 와 공유·"kept in sync deliberately" 수동 동기화 스멜 제거).
  const sr = require('../session-runtime/index.js') as typeof import('../session-runtime/index.js');
  const codingCore = require('../agent/coding-core-tools.js') as typeof import('../agent/coding-core-tools.js');
  for (const spec of codingCore.buildCodingCoreNativeSpecs()) {
    specs.push(spec);
  }
  // Bash — wired directly because it's a dashboard-optional tool,
  // not in SESSION_NATIVE_TOOL_RULES. We always expose it in the
  // CLI agent path because file-IO + shell is the minimum surface
  // for self-debugging (per user's umbrella-survivor invariant).
  const bashMod = require('../skills/tools/index.js') as typeof import('../skills/tools/index.js');
  const bashSpec = bashMod.buildBashTool();
  specs.push(bashSpec);
  dispatchByName.set('Bash', async (args) => bashMod.dispatchBash(args, { cwd: dispatchWorkingDirectory() }));
  // L2 코어 앱 도구(schedule_manage·memory_recall·… — 도메인 무관·전 서피스 공용). 단일
  // 출처(core-tools.ts)에서 상속. CLI 채팅도 자기 예약·기억을 조회/관리.
  // ★ turn 조립기 통일 Phase 0(2026-07-22) — L2 core + L3 finance(gated) 공통 조립을 buildSharedAppTools
  //   단일 헬퍼로. 종전 core/finance 를 각자 조립하던 것 통일(specs 순서 보존·무회귀). finance=financeEnabled
  //   게이트. [[project_skill_native_duplication_surface_gating]].
  const shared = (require('../agent/shared-app-tools.js') as typeof import('../agent/shared-app-tools.js')).buildSharedAppTools(cfg);
  for (const s of shared.specs) specs.push(s);
  for (const name of shared.names) dispatchByName.set(name, async (args) => shared.dispatch(name, args));
  // Installed knowledge is queryable in CLI chat as well as the dashboard runtime.
  // No installed packs => preserve the existing CLI tool list and avoid creating a KGS database.
  const { kgsDefaultDbPath } = require('../knowledge/kgs/sqlite-store.js') as typeof import('../knowledge/kgs/sqlite-store.js');
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  let hasInstalledPacks = false;
  try {
    if (existsSync(kgsDefaultDbPath())) {
      const { listInstalledPacks } = require('../knowledge/query.js') as typeof import('../knowledge/query.js');
      hasInstalledPacks = listInstalledPacks().length > 0;
    }
  } catch (err) {
    // An unreadable/corrupt KGS store must not break chat tool assembly for turns that never query knowledge.
    debug.log('cli.agent', 'knowledge-query.tool-skipped', { reason: err instanceof Error ? err.message : String(err) });
  }
  if (hasInstalledPacks) {
    const { buildKnowledgeQueryTool, dispatchKnowledgeQuery } = require('../knowledge/tools/knowledge-query.js') as typeof import('../knowledge/tools/knowledge-query.js');
    const knowledgeSpec = buildKnowledgeQueryTool();
    specs.push(knowledgeSpec);
    dispatchByName.set(knowledgeSpec.name, async (args) => dispatchKnowledgeQuery(args));
  }
  if (harnessPlan) {
    specs.push(buildPlanTool(), buildMarkStepDoneTool());
    const planCtx = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      sessionId: harnessPlan.sessionId,
      emitFeedback: harnessPlan.emitFeedback,
    };
    dispatchByName.set('Plan', async (args) => dispatchPlan(
      args as unknown as Parameters<typeof dispatchPlan>[0],
      planCtx,
    ));
    dispatchByName.set('MarkStepDone', async (args) => dispatchMarkStepDone(
      args as unknown as Parameters<typeof dispatchMarkStepDone>[0],
      planCtx,
    ));
  }
  // Native dispatch — route through dispatchSessionRuntimeTool so we
  // pick up all the dashboard guards (broad-search-block, scoped-
  // analysis, dedup planner). Scheduler/plugin/runtime stubs return
  // not-available since the CLI doesn't wire those subsystems.
  const dispatchSessionRuntimeTool = sr.dispatchSessionRuntimeTool;
  const createPlanner = sr.createSearchPlannerState;
  const plannerState = createPlanner({ maxAutoNarrowCandidates: 2 });
  const dispatch = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      const direct = dispatchByName.get(name);
      if (direct) return await direct(args);
      // ⭐ BACKLOG L1b (2026-09-25) — ToolSearch 는 지연 도구가 있으면 «자동으로 광고»되는데 이 CLI 디스패처만
      //   라우팅이 없어 `plugin tool unavailable in CLI: ToolSearch` 로 죽었다(daemon·monad-agent-turn 은 라우팅한다).
      //   ⇒ 같은 공용 라우터로 이 CLI 의 도구 풀에서 찾는다.
      const tsRoute = require('../skills/tools/tool-search-route.js') as typeof import('../skills/tools/tool-search-route.js');
      if (tsRoute.isToolSearchCall(name)) return tsRoute.routeToolSearch(args, specs, { surface: 'cli' });
      return await dispatchSessionRuntimeTool(name, bindWorkingDirectory(name, args), {
        signal: undefined,
        userText: '',
        modelFamily: undefined,
        agentHostTools: specs,
        agentDispatchTool: dispatch,
        buildChildToolCatalog: (childCwd: string) => buildCliAgentTools(cfg, undefined, childCwd),
        searchPlannerState: plannerState,
        turnIndex: undefined,
        ptyDashboardOn: false,
        getToolRuntime: () => undefined,
        dispatchToolRuntime: async (n) => ({ error: `runtime tool unavailable in CLI: ${n}` }),
        dispatchPluginTool: async (n) => ({ ok: false as const, error: `plugin tool unavailable in CLI: ${n}` }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `dispatch failed: ${msg}` };
    }
  };
  return { specs, dispatch, workingDirectory };
}

function truncateArgsForLog(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return json.length > 120 ? json.slice(0, 120) + '…' : json;
}

function truncateResultForLog(result: unknown): string {
  let preview: string;
  if (typeof result === 'string') preview = result;
  else if (result && typeof result === 'object' && 'output' in result && typeof (result as { output?: unknown }).output === 'string') {
    preview = String((result as { output: string }).output);
  } else {
    preview = JSON.stringify(result);
  }
  preview = preview.replace(/\s+/g, ' ').trim();
  return preview.length > 200 ? preview.slice(0, 200) + '…' : preview;
}

