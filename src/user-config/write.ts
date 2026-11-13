// Serialization owns the canonical typed-to-sparse on-disk projection.
import type { UserConfig, AcpConfig, VwEntryConfig, VwKnownName } from './types.js';
import type { ModelTierUserConfig } from '../model-tier/types.js';

export interface UserConfigSerializerDependencies {
  parseProjectRubricAxes(id: string, axes: unknown): Array<{ key: string; weight: number }>;
  stripUndef<T extends Record<string, unknown>>(obj: T): Partial<T>;
  acpApprovalTimeoutMs(value: unknown): number | undefined;
  acpApprovalTimeoutEnv(): number | undefined;
  acpDefaults: AcpConfig;
  vwOrderDefault: VwKnownName[];
  vwEntryDefaults: Record<VwKnownName, VwEntryConfig>;
  parseModelTierConfig(raw: unknown): ModelTierUserConfig | undefined;
  parseDiagnosticsConfig(raw: unknown): UserConfig['diagnostics'];
}

export function serializeUserConfig(cfg: UserConfig, deps: UserConfigSerializerDependencies): Record<string, unknown> {
  const { parseProjectRubricAxes, stripUndef, acpApprovalTimeoutMs, acpApprovalTimeoutEnv,
    acpDefaults, vwOrderDefault, vwEntryDefaults, parseModelTierConfig, parseDiagnosticsConfig } = deps;
  const rawRest = { ...(cfg.raw ?? {}) };
  delete rawRest.roleLlm;
  const rawOutbound = rawRest.outbound && typeof rawRest.outbound === 'object' && !Array.isArray(rawRest.outbound)
    ? rawRest.outbound as Record<string, unknown> : undefined;
  delete rawRest.outbound;
  // projects: raw entries are kept verbatim — an invalid entry loaded from disk is preserved, not blocked (its error
  // surfaces in resolveRubricAxes) — and typed axes handed to save are validated (invalid ones refuse the save).
  const rawProjectsValue = rawRest.projects;
  const rawProjects = rawRest.projects && typeof rawRest.projects === 'object' && !Array.isArray(rawRest.projects)
    ? rawRest.projects as Record<string, unknown> : undefined;
  const savedProjects: Record<string, unknown> | undefined = rawProjects || cfg.projects ? { ...(rawProjects ?? {}) } : undefined;
  for (const [id, project] of Object.entries(cfg.projects ?? {})) {
    if (project?.rubric?.axes === undefined) continue;
    const axes = parseProjectRubricAxes(id, project.rubric.axes);
    const rawProject = rawProjects?.[id] && typeof rawProjects[id] === 'object' && !Array.isArray(rawProjects[id])
      ? rawProjects[id] as Record<string, unknown> : {};
    const rawRubric = rawProject.rubric && typeof rawProject.rubric === 'object' && !Array.isArray(rawProject.rubric)
      ? rawProject.rubric as Record<string, unknown> : {};
    savedProjects![id] = { ...rawProject, rubric: { ...rawRubric, axes } };
  }
  // Strip typed sections from raw so we don't double-write stale copies.
  delete rawRest.skillRouter;
  delete rawRest.llm;
  delete rawRest.skills;
  delete rawRest.obsidian;
  delete rawRest.telegram;
  delete rawRest.discord;
  delete rawRest.onboarding;
  delete rawRest.debug;
  delete rawRest.shell;
  delete rawRest.tui;
  delete rawRest.chat;
  delete rawRest.dashboard;
  delete rawRest.vw;
  delete rawRest.acp;
  delete rawRest.lsp;
  delete rawRest.plan;
  delete rawRest.controlPlane;
  // Phase 2: NEXUS schema fields are written explicitly below so the
  // round-trip preserves any cfg.global / cfg.tabs / cfg.version mutations
  // applied between read and write (e.g. `elanous config set global.x ...`).
  delete rawRest.version;
  delete rawRest.global;
  delete rawRest.tabs;
  // M1-2b (PLAN-friction-free-model-selection-ux-2026-05-12) — the
  // three friction-free-UX sub-trees round-trip through their typed
  // parsers; strip from raw so stale copies don't double-write.
  delete rawRest.modelTier;
  delete rawRest.sessionFabric;
  delete rawRest.nextFluent;
  delete rawRest.taste;
  delete rawRest.budget;
  delete rawRest.smartDefaults;
  delete rawRest.grounding;
  delete rawRest.diagnostics;
  delete rawRest.projects;
  delete rawRest.starter;
  delete rawRest.watch;
  delete rawRest.guardian;
  const rawHarness = rawRest.harness && typeof rawRest.harness === 'object' && !Array.isArray(rawRest.harness)
    ? rawRest.harness as Record<string, unknown> : {};
  delete rawRest.harness;
  const rawAutopilot = rawRest.autopilot && typeof rawRest.autopilot === 'object' && !Array.isArray(rawRest.autopilot)
    ? rawRest.autopilot as Record<string, unknown> : {};
  const rawLoops = rawRest.loops && typeof rawRest.loops === 'object' && !Array.isArray(rawRest.loops)
    ? rawRest.loops as Record<string, unknown> : {};
  const rawSteward = rawLoops.steward && typeof rawLoops.steward === 'object' && !Array.isArray(rawLoops.steward)
    ? rawLoops.steward as Record<string, unknown> : {};
  if (cfg.loops) delete rawRest.loops;
  if (cfg.pod?.hostMirror) {
    const rawPod = rawRest.pod && typeof rawRest.pod === 'object' && !Array.isArray(rawRest.pod)
      ? rawRest.pod as Record<string, unknown> : {};
    rawRest.pod = { ...rawPod, hostMirror: cfg.pod.hostMirror };
  }

  const out: Record<string, unknown> = {
    harness: stripUndef({
      ...rawHarness,
      pod: cfg.harness?.pod ?? rawHarness.pod,
      budgetGate: cfg.harness?.budgetGate ?? rawHarness.budgetGate,
      exposeGate: cfg.harness?.exposeGate ?? rawHarness.exposeGate,
      revertGuard: cfg.harness?.revertGuard ?? rawHarness.revertGuard,
      difficultyPlacement: cfg.harness?.difficultyPlacement ?? rawHarness.difficultyPlacement,
      defaultRepo: cfg.harness?.defaultRepo ?? rawHarness.defaultRepo,
      repo: cfg.harness?.repo,
      substrate: cfg.harness?.substrate,
      podPool: cfg.harness?.podPool,
      authorOnPod: cfg.harness?.authorOnPod === true ? true : undefined,
      followUp: cfg.harness?.followUp === 'live' ? 'live' : undefined,
      queue: cfg.harness?.queue ?? rawHarness.queue,
      helper: cfg.harness?.helper ?? rawHarness.helper,
    }),
    ...rawRest,
    ...(cfg.roleLlm ? { roleLlm: cfg.roleLlm } : {}),
    ...(savedProjects ? { projects: savedProjects } : rawProjectsValue !== undefined ? { projects: rawProjectsValue } : {}),
    ...(cfg.starter ? { starter: cfg.starter } : {}),
    ...(cfg.watch ? { watch: cfg.watch } : {}),
    ...(cfg.guardian ? { guardian: cfg.guardian } : {}),
    ...(cfg.loops ? { loops: {
      ...rawLoops,
      owners: cfg.loops.owners ?? {}, defaultOwner: cfg.loops.defaultOwner ?? 'OP',
      ...(cfg.loops.steward ? { steward: { ...rawSteward, mode: cfg.loops.steward.mode ?? cfg.loops.steward.launch ?? 'shadow' } } : {}),
      ...(cfg.loops.orchestrator ? { orchestrator: cfg.loops.orchestrator } : {}),
      ...(cfg.loops.seat ? { seat: {
        mode: cfg.loops.seat.mode,
        questions: cfg.loops.seat.questions ?? 'shadow',
        seats: cfg.loops.seat.seats ?? ['MK'],
        podPool: cfg.loops.seat.podPool ?? 'pool-node-b@node-b:8',
        ...(cfg.loops.seat.neighbors ? { neighbors: cfg.loops.seat.neighbors } : {}),
        ...(cfg.loops.seat.reportPr === undefined ? {} : { reportPr: cfg.loops.seat.reportPr }),
        ...(cfg.loops.seat.stall ? { stall: cfg.loops.seat.stall } : {}),
        ...(cfg.loops.seat.repeatStop === undefined ? {} : { repeatStop: cfg.loops.seat.repeatStop }),
        ...(cfg.loops.seat.opDecide ? { opDecide: cfg.loops.seat.opDecide } : {}),
        ...(cfg.loops.seat.idleLadder ? { idleLadder: cfg.loops.seat.idleLadder } : {}),
      } } : {}),
    } } : {}),
    ...(cfg.autopilot ? { autopilot: {
      ...rawAutopilot,
      ...cfg.autopilot,
      ...(cfg.autopilot.trackAgent ? { trackAgent: {
        ...(rawAutopilot.trackAgent && typeof rawAutopilot.trackAgent === 'object' && !Array.isArray(rawAutopilot.trackAgent)
          ? rawAutopilot.trackAgent as Record<string, unknown> : {}),
        ...cfg.autopilot.trackAgent,
      } } : {}),
      ...(cfg.autopilot.trackCourier ? { trackCourier: {
        ...(rawAutopilot.trackCourier && typeof rawAutopilot.trackCourier === 'object' && !Array.isArray(rawAutopilot.trackCourier)
          ? rawAutopilot.trackCourier as Record<string, unknown> : {}),
        ...cfg.autopilot.trackCourier,
      } } : {}),
    } } : {}),
    skillRouter: cfg.skillRouter,
    llm: stripUndef({
      provider: cfg.llm.provider,
      apiKey: cfg.llm.apiKey,
      model: cfg.llm.model,
      baseUrl: cfg.llm.baseUrl,
      streamIdleTimeoutMs: cfg.llm.streamIdleTimeoutMs,
      // Persist the rotation exactly as held in memory — each entry
      // stripped of its own undefined fields so the on-disk JSON
      // stays minimal. Omit the key entirely when no rotation is
      // configured (keeps configs of single-provider users clean).
      rotation: cfg.llm.rotation && cfg.llm.rotation.length > 0
        ? cfg.llm.rotation.map(e => stripUndef({
            provider: e.provider,
            model:    e.model,
            apiKey:   e.apiKey,
            baseUrl:  e.baseUrl,
            label:    e.label,
          }))
        : undefined,
      // Reasoning fields (added 2026-05-03). Both omitted by stripUndef
      // when undefined so opt-out users keep the legacy minimal JSON.
      // CRITICAL: these MUST be in sync with the parser in getUserConfig
      // — a missing field here = silent drop on every save (user
      // changes /reasoning to high → file write loses it → reload
      // picks up capability fallback 'medium' → user thinks fix
      // regressed).
      reasoningLevel: cfg.llm.reasoningLevel,
      codexTokenOwnerHost: cfg.llm.codexTokenOwnerHost,
      codexReasoning: cfg.llm.codexReasoning,
      goalLoop: cfg.llm.goalLoop,
      memoryJudge: cfg.llm.memoryJudge,
      codexInspectExempt: cfg.llm.codexInspectExempt,
      podHostAcpReview: cfg.llm.podHostAcpReview,
      codexAccountRotation: cfg.llm.codexAccountRotation,
      codexAccountAlerts: cfg.llm.codexAccountAlerts,
      codexAccountRotationThresholdPercent: cfg.llm.codexAccountRotationThresholdPercent,
      codexAccountRotationThresholdPercentByAccount: cfg.llm.codexAccountRotationThresholdPercentByAccount,
      codexAccountOrder: cfg.llm.codexAccountOrder,
      codexAccountHostWeights: cfg.llm.codexAccountHostWeights,
      // ★ 2026-09-28: 타입·파서에만 넣고 이 whitelist 를 빠뜨려 `config set llm.codexCreditsAllowed true` 가 «직렬화 드롭» 됐다(#21375 직후 운영 실측).
      codexCreditsAllowed: cfg.llm.codexCreditsAllowed,
      codexQuotaPolicy: cfg.llm.codexQuotaPolicy,
      codexCreditReserve: cfg.llm.codexCreditReserve,
      grokWeeklyCapPct: cfg.llm.grokWeeklyCapPct,
      zaiCodingPlan: cfg.llm.zaiCodingPlan,
      fallbackChain: cfg.llm.fallbackChain,
      openrouter: cfg.llm.openrouter,
      reviewFallbackModels: cfg.llm.reviewFallbackModels,
      geminiSafety: cfg.llm.geminiSafety,
      geminiServerTools: cfg.llm.geminiServerTools,
      answerPriority: cfg.llm.answerPriority,
      maxTurns: cfg.llm.maxTurns,
      missionRouting: cfg.llm.missionRouting,
      // ⛔ 로드(parseLlmRoutePolicy)만 있고 저장이 없으면 `config set llm.routePolicy` 가 «조용히» 떨어진다
      //   (10-14 OP 실측 — set 뒤 get 이 undefined · TUI-MODEL-SESSION-SCOPE ①).
      routePolicy: cfg.llm.routePolicy,
    }),
    skills: stripUndef({
      activeSet: cfg.skills.activeSet,
      dirs: [...cfg.skills.dirs],
      giftEndpoint: cfg.skills.giftEndpoint === 'https://elanous.ai' ? undefined : cfg.skills.giftEndpoint,
      // EN5 — only connected roots are persisted (preset/shared/package are derived). The dev-only `connected` key is not written back.
      sources: cfg.skills.sources && cfg.skills.sources.some((source) => source.kind === 'connected')
        ? cfg.skills.sources.filter((source) => source.kind === 'connected').map(({ id, path, enabled }) => ({ id, path, enabled }))
        : undefined,
      // Omit allow/deny when empty to keep disk JSON minimal for the
      // common "no filter" case.
      allow: cfg.skills.allow && cfg.skills.allow.length > 0 ? [...cfg.skills.allow] : undefined,
      deny:  cfg.skills.deny  && cfg.skills.deny.length  > 0 ? [...cfg.skills.deny]  : undefined,
      // ⚠️ 옵셔널이다 — 없는데 접으면 saveUserConfig 가 터진다(테스트가 그 경로를 탄다).
      urlRouting: cfg.skills.urlRouting ? {
        enabled: cfg.skills.urlRouting.enabled,
        twoStage: cfg.skills.urlRouting.twoStage,
        defaultTargets: [...cfg.skills.urlRouting.defaultTargets],
        guardKeywords: [...cfg.skills.urlRouting.guardKeywords],
        absorbKeywords: [...cfg.skills.urlRouting.absorbKeywords],
        map: { ...cfg.skills.urlRouting.map },
        absorbSkill: cfg.skills.urlRouting.absorbSkill,
      } : undefined,
      devRequestRouting: cfg.skills.devRequestRouting ? {
        enabled: cfg.skills.devRequestRouting.enabled,
        verbs: [...cfg.skills.devRequestRouting.verbs],
        guardKeywords: [...cfg.skills.devRequestRouting.guardKeywords],
      } : undefined,
      includeClaudePackageSkills: cfg.skills.includeClaudePackageSkills === true ? true : undefined,
      includeClaudePackageCommands: cfg.skills.includeClaudePackageCommands === true ? true : undefined,
    }),
    obsidian: { vault: cfg.obsidian.vault, ...(cfg.obsidian.testVault ? { testVault: cfg.obsidian.testVault } : {}) },
    telegram: stripUndef({
      enabled: cfg.telegram.enabled,
      botToken: cfg.telegram.botToken,
      allowedUsers: [...cfg.telegram.allowedUsers],
      homeChannel: cfg.telegram.homeChannel,
      reportChannel: cfg.telegram.reportChannel
        ? stripUndef({
            chatId: cfg.telegram.reportChannel.chatId,
            botToken: cfg.telegram.reportChannel.botToken,
          })
        : undefined,
      channels: cfg.telegram.channels
        ? cfg.telegram.channels.map(c => ({ ...c, roles: [...c.roles] }))
        : undefined,
      testChannel: cfg.telegram.testChannel
        ? stripUndef({
            botToken: cfg.telegram.testChannel.botToken,
            allowedUsers: cfg.telegram.testChannel.allowedUsers
              ? [...cfg.telegram.testChannel.allowedUsers] : undefined,
            // ★ botUsername 은 타입·파서(normalizeTestChannel)에 있으나 이 저장
            //   직렬화 whitelist 에서 빠져 `config set` 후 재읽기에서 드롭되던 모순
            //   (2026-07-22). round-trip 을 맞춘다.
            botUsername: cfg.telegram.testChannel.botUsername,
          })
        : undefined,
      // ★ 2026-09-25: `poller`(T1 분리 스위치)가 파서엔 있고 이 whitelist 에 없어 `config set telegram.poller` 가
      //   「직렬화 드롭」으로 조용히 사라졌다 — 운영 전환 스위치를 켤 방법이 없었다(07-22 botUsername 과 같은 모양).
      poller: cfg.telegram.poller,
      fieldDefaultEvent: cfg.telegram.fieldDefaultEvent,
      fieldReelMode: cfg.telegram.fieldReelMode,
    }),
    discord: stripUndef({
      enabled: cfg.discord.enabled,
      botToken: cfg.discord.botToken,
      allowedUsers: [...cfg.discord.allowedUsers],
      homeChannel: cfg.discord.homeChannel,
      chatChannels: cfg.discord.chatChannels ? [...cfg.discord.chatChannels] : undefined,
      testChannel: cfg.discord.testChannel
        ? stripUndef({
            channelId: cfg.discord.testChannel.channelId,
            allowedUsers: cfg.discord.testChannel.allowedUsers
              ? [...cfg.discord.testChannel.allowedUsers] : undefined,
            botToken: cfg.discord.testChannel.botToken,
          })
        : undefined,
    }),
    // ★ finance 직렬화 whitelist 를 스키마 전체와 정합(2026-07-22). 종전엔 enabled/morningNarrative/
    //   autoLoop 3개만 저장 → morningHeatmapImage·dig·kg·replay·conatusNativePort·liveOrders 는 `config set`
    //   후 재읽기에서 드롭(botUsername 모순과 동종). stripUndef 로 미설정 필드는 생략, 설정분은 round-trip.
    finance: stripUndef({
      enabled: cfg.finance.enabled,
      autoLoop: cfg.finance.autoLoop,
      dig: cfg.finance.dig,
      kg: cfg.finance.kg,
      replay: cfg.finance.replay,
      conatusNativePort: cfg.finance.conatusNativePort,
      secContactEmail: cfg.finance.secContactEmail,
      liveOrders: cfg.finance.liveOrders,
      relaxedGates: cfg.finance.relaxedGates,
    }),
    onboarding: stripUndef({
      webFirst: cfg.onboarding.webFirst,
      ready: cfg.onboarding.ready,
      completed: cfg.onboarding.completed,
      completedAt: cfg.onboarding.completedAt,
      version: cfg.onboarding.version,
    }),
    debug: cfg.debug,
    logs: cfg.logs,
    shell: cfg.shell,
    errorReports: cfg.errorReports ? stripUndef({ ...cfg.errorReports }) : undefined,
    chat: stripUndef({
      fastPath: cfg.chat.fastPath,
      conciseness: stripUndef({
        enabled: cfg.chat.conciseness.enabled,
        finalMessageMaxLines: cfg.chat.conciseness.finalMessageMaxLines,
        preambleMaxWords: cfg.chat.conciseness.preambleMaxWords,
        flatBullets: cfg.chat.conciseness.flatBullets,
      }),
      toolOutput: stripUndef({
        persistOnOverflow: cfg.chat.toolOutput.persistOnOverflow,
        retentionDays: cfg.chat.toolOutput.retentionDays,
        previewLines: cfg.chat.toolOutput.previewLines,
      }),
      autoCompact: stripUndef({
        enabled: cfg.chat.autoCompact.enabled,
        triggerRatio: cfg.chat.autoCompact.triggerRatio,
        preserveLastN: cfg.chat.autoCompact.preserveLastN,
        preserveFirstN: cfg.chat.autoCompact.preserveFirstN,
        partial: cfg.chat.autoCompact.partial,
      }),
      autoCopyQaToClipboard: cfg.chat.autoCopyQaToClipboard,
      systemPrompt: stripUndef({
        overridePath: cfg.chat.systemPrompt.overridePath,
        taskVariant: cfg.chat.systemPrompt.taskVariant,
        forceBuiltinVariant: cfg.chat.systemPrompt.forceBuiltinVariant,
      }),
    }),
    intake: { ...(rawRest.intake && typeof rawRest.intake === 'object' ? rawRest.intake as Record<string, unknown> : {}), ...cfg.intake },
    dashboard: stripUndef({
      promptBank: cfg.dashboard.promptBank,
    }),
    acp: stripUndef({
      hopCap: stripUndef({
        claude: cfg.acp.hopCap.claude,
        codex: cfg.acp.hopCap.codex,
        gemini: cfg.acp.hopCap.gemini,
        default: cfg.acp.hopCap.default,
      }),
      reviewBackend: cfg.acp.reviewBackend,
      reworkBackend: cfg.acp.reworkBackend,
      binaryPaths: cfg.acp.binaryPaths && Object.keys(cfg.acp.binaryPaths).length > 0
        ? { ...cfg.acp.binaryPaths }
        : undefined,
      slashMaxTurns: cfg.acp.slashMaxTurns,
      editApproval: cfg.acp.editApproval ? true : undefined,
      toolApproval: acpApprovalTimeoutMs(
        (cfg.raw?.acp as { toolApproval?: { timeoutMs?: unknown } } | undefined)?.toolApproval?.timeoutMs,
      ) !== undefined || cfg.acp.toolApproval.timeoutMs !== (acpApprovalTimeoutEnv() ?? acpDefaults.toolApproval.timeoutMs)
        ? { timeoutMs: cfg.acp.toolApproval.timeoutMs } : undefined,
    }),
    lsp: stripUndef({
      enabled: cfg.lsp.enabled,
      typescript: cfg.lsp.typescript === false ? false : stripUndef({
        command: cfg.lsp.typescript.command,
        args: cfg.lsp.typescript.args ? [...cfg.lsp.typescript.args] : undefined,
        extensions: [...cfg.lsp.typescript.extensions],
      }),
      python: cfg.lsp.python === false ? false : stripUndef({
        command: cfg.lsp.python.command,
        args: cfg.lsp.python.args ? [...cfg.lsp.python.args] : undefined,
        extensions: [...cfg.lsp.python.extensions],
      }),
      rust: cfg.lsp.rust === false ? false : stripUndef({
        command: cfg.lsp.rust.command,
        args: cfg.lsp.rust.args ? [...cfg.lsp.rust.args] : undefined,
        extensions: [...cfg.lsp.rust.extensions],
      }),
      idleTimeoutMs: cfg.lsp.idleTimeoutMs,
      workspaceSymbolLanguage: cfg.lsp.workspaceSymbolLanguage,
    }),
    // VW config now prefers named entries (`iul`, `acp`, `sim`) so
    // registration order in JSON is itself the canonical order.
    ...(() => {
      const order = cfg.vw.order ?? vwOrderDefault;
      const orderedEntries = order.map((name) => {
        const entry = cfg.vw.entries?.[name] ?? vwEntryDefaults[name];
        const defaults = vwEntryDefaults[name];
        const value = stripUndef({
          resident: entry.resident !== defaults.resident ? entry.resident : undefined,
          foregroundOnStartup: entry.foregroundOnStartup === true ? true : undefined,
        });
        const preserveForOrder = JSON.stringify(order) !== JSON.stringify(vwOrderDefault);
        return [name, (Object.keys(value).length > 0 || preserveForOrder) ? value : undefined] as const;
      });
      const hasNamedEntries = orderedEntries.some(([, value]) => value !== undefined);
      const hasNames = Object.keys(cfg.vw.windowNames).length > 0 || Object.keys(cfg.vw.paneNames).length > 0;
      if (!hasNamedEntries && !hasNames) return {};
      const named: Record<string, unknown> = {};
      for (const [name, value] of orderedEntries) {
        if (value !== undefined) named[name] = value;
      }
      return {
        vw: {
          ...stripUndef({
            windowNames: Object.keys(cfg.vw.windowNames).length > 0 ? { ...cfg.vw.windowNames } : undefined,
            paneNames: Object.keys(cfg.vw.paneNames).length > 0 ? { ...cfg.vw.paneNames } : undefined,
          }),
          ...named,
        },
      };
    })(),
    // Plan: omit the key entirely when the (single) flag matches the
    // default to keep on-disk JSON minimal for users who don't opt in.
    ...(cfg.plan.autoWorktree ? { plan: { autoWorktree: true } } : {}),
    // Registry (FU A6-real P5 round-trip): only persist non-empty
    // discovery sub-blocks so a clean install's config.json stays
    // free of empty `registry: { discovery: { cron: {}, firecrawl: {} } }`.
    ...(() => {
      const discovery: Record<string, unknown> = {};
      const cron = cfg.registry?.discovery?.cron;
      const firecrawl = cfg.registry?.discovery?.firecrawl;
      if (cron && typeof cron.intervalMs === 'number' && cron.intervalMs > 0) {
        discovery.cron = { intervalMs: cron.intervalMs };
      }
      if (firecrawl && typeof firecrawl.apiKey === 'string' && firecrawl.apiKey.trim().length > 0) {
        discovery.firecrawl = { apiKey: firecrawl.apiKey };
      }
      return Object.keys(discovery).length > 0 ? { registry: { discovery } } : {};
    })(),
    // Phase 2: round-trip NEXUS schema fields when present. omit when
    // unset so a Path-A-only user's file stays clean (no empty global:{}).
    ...(typeof cfg.version === 'number' ? { version: cfg.version } : {}),
    ...(cfg.global && Object.keys(cfg.global).length > 0 ? { global: cfg.global } : {}),
    ...(cfg.tabs && Object.keys(cfg.tabs).length > 0 ? { tabs: cfg.tabs } : {}),
    // M1-2b: sparse — emit only when explicitly set. Keeps Path-A-only
    // users' file clean (no empty modelTier:{} blobs).
    ...(cfg.modelTier ? { modelTier: parseModelTierConfig(cfg.modelTier) } : {}),
    ...((cfg.outbound || rawOutbound) ? { outbound: stripUndef({ ...rawOutbound, ...cfg.outbound }) } : {}),
    ...(cfg.sessionFabric ? { sessionFabric: cfg.sessionFabric } : {}),
    ...(cfg.nextFluent ? { nextFluent: cfg.nextFluent } : {}),
    ...(cfg.taste ? { taste: cfg.taste } : {}),
    ...(cfg.webSearch ? { webSearch: cfg.webSearch } : {}),
    ...(cfg.design ? { design: cfg.design } : {}),
    ...(cfg.diagnostics?.uploadUrl ? { diagnostics: parseDiagnosticsConfig(cfg.diagnostics) } : {}),
    ...(cfg.budget ? { budget: cfg.budget } : {}),
    ...(cfg.smartDefaults ? { smartDefaults: cfg.smartDefaults } : {}),
    ...(cfg.tui?.next?.compactHeight !== undefined && Number.isInteger(cfg.tui.next.compactHeight)
      && cfg.tui.next.compactHeight >= 8 && cfg.tui.next.compactHeight <= 100
      ? { tui: { next: { compactHeight: cfg.tui.next.compactHeight } } } : {}),
    ...(cfg.grounding && cfg.grounding.sources.length > 0
      ? { grounding: { sources: cfg.grounding.sources } }
      : {}),
  };
  return out;
}
