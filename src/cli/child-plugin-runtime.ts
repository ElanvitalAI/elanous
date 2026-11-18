import type { LLMToolDef } from '../plugins/core/types.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { BUILTIN_DIR, PluginHost } from '../plugins/core/host.js';
import { createPluginRouteAdapter } from '../plugins/core/route-adapter.js';
import { buildCoreTools } from '../domains/core-tools.js';
import { dispatchToolByName, getToolRuntime, listToolRuntimes, registerAllDefaultToolRuntimes } from '../tool-runtime/index.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import type { GraphRunOptions } from '../graph-runner/runner.js';
import type { GraphCapabilityRegistry } from '../graph-runner/capabilities.js';
import { randomUUID } from 'node:crypto';
import { createGraphProgressCollector, type GraphProgressObservation } from '../graph-runner/graph-progress-observation.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withS2SupervisorProvider } from '../graph-runner/plugin-graph-providers.js';
import { APP_BUILD_OWNER_APPROVAL_WINDOW_MS, isSeatTurnCapAbort } from '../core-turn/seat-turn-cap.js';
import { approvalHold, isApprovalHold, normalizeApproval, type ApprovalOutcome } from '../graph-runner/approval-outcome.js';

/** Resolve only a declared graph route, using the graph CLI's trusted runner boundary. */
async function graphRouteForFile(graphFile: string, injected?: GraphRunOptions['deps']): Promise<{
  deps: GraphRunOptions['deps']; defaultAsk?: string;
}> {
  const graphPath = realpathSync(graphFile);
  const graphDir = dirname(graphPath);
  const pluginRoot = existsSync(join(graphDir, 'plugin.json')) ? graphDir : resolve(graphDir, '..');
  const manifestPath = join(pluginRoot, 'plugin.json');
  if (!existsSync(manifestPath)) return { deps: injected };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id?: string; extensions?: { 'ai.elanous'?: {
    graphs?: string[]; graphProviders?: Record<string, { module: string; factory: string; withPluginRoot?: boolean;
      withGraphRoot?: boolean;
      defaultAsk?: string }> } } };
  const extension = manifest.extensions?.['ai.elanous'];
  const relativeGraph = relative(pluginRoot, graphPath).split(sep).join('/');
  if (!extension?.graphs?.some(graph => graph.replace(/^\.\//, '') === relativeGraph)) return { deps: injected };
  const declaration = extension.graphProviders?.[relativeGraph] ?? extension.graphProviders?.[`./${relativeGraph}`];
  if (!declaration) return { deps: injected };
  const defaultAsk = typeof declaration.defaultAsk === 'string' && declaration.defaultAsk.trim()
    ? declaration.defaultAsk : undefined;
  if (injected?.capabilityProviders) return { deps: injected, defaultAsk };
  const runnerRoot = realpathSync(resolve(import.meta.dir, '../graph-runner'));
  const modulePath = realpathSync(resolve(import.meta.dir, '../..', declaration.module));
  if (!modulePath.startsWith(`${runnerRoot}${sep}`)) throw new Error('plugin graph provider must use the shared graph runner');
  const module = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
  const factory = module[declaration.factory];
  if (typeof factory !== 'function') throw new Error(`plugin graph provider factory missing: ${declaration.factory}`);
  const baseRegistry = declaration.withGraphRoot ? factory(injected?.root)
    : declaration.withPluginRoot ? factory(pluginRoot) : factory();
  const providerRegistry = withS2SupervisorProvider(manifest.id, relativeGraph,
    baseRegistry as import('../graph-runner/capabilities.js').GraphCapabilityRegistry);
  return { deps: { ...injected, capabilityProviders: providerRegistry },
    defaultAsk };
}

/** The same catalog and dispatch seams used by the classic PluginHost route bridge. */
export interface ChildPluginRuntimeContract {
  hostTools: readonly LLMToolDef[];
  runtimeTools: ReturnType<typeof listToolRuntimes>;
  getToolRuntime: typeof getToolRuntime;
  dispatchToolRuntime(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  dispatchPluginTool(name: string, args: Record<string, unknown>): Promise<
    { ok: true; result: unknown } | { ok: false; error: string }
  >;
}

export interface ChildPluginRuntimeOptions {
  pluginRoot?: string;
  verifiedOwner?: ToolRuntimeContext['verifiedOwner'];
  resolveVerifiedOwner?: () => Promise<ToolRuntimeContext['verifiedOwner'] | undefined>;
  /** The hosting turn's abort signal for this dispatch (daemon chat turn). A cancelled turn then stops the
   *  graph run and ends an approval wait as `turn-cancelled`. Hosts without one keep the old behaviour. */
  resolveSignal?: () => AbortSignal | undefined;
  requestConfirmation?: (prompt: string) => Promise<boolean>;
  /** Like requestConfirmation but says WHY it is not approved; only `declined` is a refusal, the rest leave the node waiting. */
  requestDecision?: (prompt: string, signal?: AbortSignal, options?: { readonly timeoutMs?: number }) => Promise<ApprovalOutcome>;
  /** The host's owner publish-approval screen (the URL travels as a structured field; `prompt` is the plain-text fallback). */
  requestPublishApproval?: (url: string, expiresAt: string, prompt: string, signal?: AbortSignal) => Promise<boolean>;
  dispatchGraph?: (pluginId: string, graphId: string, graphFile: string, args: Record<string, unknown>, context?: ToolRuntimeContext) => Promise<unknown>;
  /** Isolated graph provider/root for an actual-runner test world. */
  graphDeps?: GraphRunOptions['deps'];
  /** Fake model for the isolated default graph route; production uses the CLI model provider. */
  graphPrompt?: (prompt: string) => Promise<string>;
  /** Safe run-scoped progress for the owning Next TUI; raw runner diagnostics stay private. */
  observeGraphProgress?: (event: GraphProgressObservation) => void;
}

/** APP-BUILD-TOOL-WALL-CAP — the pending approval expiry to retry through the trusted resume path, only when
 *  the hosting seat turn was actually closed by its cap (SeatTurnCapAbort) after this visit presented an
 *  unexpired approval. A refusal while the turn is alive, a person's cancel or an expired approval returns undefined. */
export function seatCapInterruptedApprovalExpiry(turnSignal: AbortSignal | undefined, presentedExpiresAt: string | undefined,
  nowMs: number): string | undefined {
  if (!turnSignal?.aborted || !isSeatTurnCapAbort(turnSignal.reason) || presentedExpiresAt === undefined) return undefined;
  const expiresAtMs = Date.parse(presentedExpiresAt);
  return Number.isFinite(expiresAtMs) && nowMs < expiresAtMs ? presentedExpiresAt : undefined;
}

/** Plugin route catalog and dispatch only: the route adapter's merged host tools and its approval/authority path.
 *  It registers no tool runtimes, so a host with its own runtime surface (the daemon chat turn) can reuse the
 *  exact catalog and gate the TUI and agent CLI use, without joining the TUI runtime registry. */
export interface ChildPluginRoutes {
  hostTools: readonly LLMToolDef[];
  dispatchPluginTool: ChildPluginRuntimeContract['dispatchPluginTool'];
}

/** The route-tool specs a turn adds from the merged host tools: only routed tools whose name the turn does not
 *  already expose. One helper for every turn that merges plugin routes (Next TUI REPL, daemon chat). */
export function routeOnlyHostToolSpecs(hostTools: readonly LLMToolDef[], exposedNames: Set<string>): LLMToolSpec[] {
  const added: LLMToolSpec[] = [];
  for (const tool of hostTools) {
    if (!tool.route || exposedNames.has(tool.name)) continue;
    added.push({ name: tool.name, description: tool.description, parameters: tool.parameters,
      pluginId: tool.pluginId, route: tool.route });
    exposedNames.add(tool.name);
  }
  return added;
}

export function createChildPluginRuntimeContract(options: ChildPluginRuntimeOptions = {}): ChildPluginRuntimeContract {
  registerAllDefaultToolRuntimes({ mcpLazyBoot: true });
  const context: ToolRuntimeContext = { surface: 'tui', ...(options.verifiedOwner ? { verifiedOwner: options.verifiedOwner } : {}) };
  const routes = createChildPluginRoutes(options);
  return {
    hostTools: routes.hostTools,
    runtimeTools: listToolRuntimes('tui'),
    getToolRuntime,
    dispatchToolRuntime: (name, args, signal) => dispatchToolByName(name, args, { ...context, signal }),
    dispatchPluginTool: routes.dispatchPluginTool,
  };
}

export function createChildPluginRoutes(options: ChildPluginRuntimeOptions = {}): ChildPluginRoutes {
  const host = new PluginHost({
    log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {},
  });
  const core = buildCoreTools();
  for (const spec of core.specs) {
    host.registerHostTool({
      name: spec.name, description: spec.description, parameters: spec.parameters,
      handler: (args) => core.dispatch(spec.name, args as Record<string, unknown>),
    });
  }
  const context: ToolRuntimeContext = { surface: 'tui', ...(options.verifiedOwner ? { verifiedOwner: options.verifiedOwner } : {}) };
  const dispatchContext = async (): Promise<ToolRuntimeContext> => {
    const signal = options.resolveSignal?.();
    return { ...context,
      ...(options.resolveVerifiedOwner ? { verifiedOwner: await options.resolveVerifiedOwner() } : {}),
      ...(signal ? { signal } : {}),
    };
  };
  const routes = createPluginRouteAdapter({
    pluginRoot: options.pluginRoot ?? BUILTIN_DIR,
    dispatchCore: (name, args) => core.dispatch(name, args),
    dispatchGraph: options.dispatchGraph ?? (async (_pluginId, graphId, graphFile, args, dispatchContext) => {
      const owner = dispatchContext?.verifiedOwner;
      if (!owner?.id) throw new Error('graph route requires a verified owner context');
      const { decideGraphApproval, runGraph } = await import('../graph-runner/runner.js');
      const inputContext = args.context && typeof args.context === 'object' && !Array.isArray(args.context)
        ? args.context as Record<string, unknown> : {};
      const route = await graphRouteForFile(graphFile, options.graphDeps);
      const turnSignal = dispatchContext?.signal;
      const ordinaryAppBuildFile = join(BUILTIN_DIR, 'elanous-app-build', 'graph', 'app-build.yaml');
      let approvalRegistry: GraphCapabilityRegistry | undefined;
      if (graphId === basename(ordinaryAppBuildFile, '.yaml')) {
        if (realpathSync(graphFile) !== realpathSync(ordinaryAppBuildFile) || !(options.requestConfirmation || options.requestDecision)
          || typeof owner.appSlug !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(owner.appSlug))
          throw new Error('APP_BUILD_TRUSTED_ENTRY_REQUIRED');
        const registry = route.deps?.capabilityProviders;
        if (!registry || !('providers' in registry) || !Array.isArray(registry.providers))
          throw new Error('APP_BUILD_APPROVAL_REGISTRY_REQUIRED');
        const base = registry as GraphCapabilityRegistry;
        if (base.providers.filter(provider => provider.id === 'app-build-owner-publish-approval'
          && provider.provides.includes('app-build.publish-approval@1')).length !== 1)
          throw new Error('APP_BUILD_APPROVAL_REGISTRY_REQUIRED');
        const { createAppBuildPublishApprovalProvider, createAppBuildPublishApprovalTransport } = await import('../graph-runner/capability-providers/app-build-publish-approval.js');
        const productTransport = createAppBuildPublishApprovalTransport();
        approvalRegistry = { ...base, providers: base.providers.map(provider =>
          provider.id === 'app-build-owner-publish-approval' ? { ...provider,
            invoke: async context => {
              // The owner approval window begins at this node, after build and materialize.
              const deadlineAtMs = Date.now() + APP_BUILD_OWNER_APPROVAL_WINDOW_MS;
              const timeout = AbortSignal.timeout(APP_BUILD_OWNER_APPROVAL_WINDOW_MS);
              const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
              // APP-BUILD-TOOL-WALL-CAP — the pending approval this visit presented, for a cap-interrupted retry.
              let presentedExpiresAt: string | undefined;
              const invokeApproval = createAppBuildPublishApprovalProvider({
                transport: productTransport,
                trustedWindow: () => ({ signal, deadlineAtMs }),
                presentApprovalUrl: async (ownerId, url, expiresAt, pendingSignal) => {
                  if (ownerId !== owner.id || signal.aborted || pendingSignal?.aborted)
                    throw new Error('APP_BUILD_OWNER_PRESENTATION_REFUSED');
                  presentedExpiresAt = expiresAt;
                  const prompt = `회원 게시 승인 링크를 본인 브라우저에서 열고 승인한 뒤 계속하세요. ${url} (만료 ${expiresAt})`;
                  const acknowledged = options.requestPublishApproval
                    ? await options.requestPublishApproval(url, expiresAt, prompt, signal)
                    : (await decideWith(prompt, signal)).approved;
                  if (!acknowledged || signal.aborted || pendingSignal?.aborted)
                    throw new Error('APP_BUILD_OWNER_PRESENTATION_REFUSED');
                },
              });
              // A presented approval cut only by the seat turn cap stays resumable through the trusted
              // path; an owner refusal while the turn is alive, or any other cancel, keeps its failure.
              const retryable = (): string | undefined =>
                seatCapInterruptedApprovalExpiry(turnSignal, presentedExpiresAt, Date.now());
              let result: Awaited<ReturnType<typeof invokeApproval>>;
              try { result = await invokeApproval({ ...context, signal }); }
              catch (error) {
                const expiry = retryable();
                if (expiry === undefined) throw error;
                return { ok: false, outcome: 'failed' as const, error: `APP_BUILD_APPROVAL_PRESENTATION_RETRYABLE:${expiry}` };
              }
              const expiry = result.ok === false ? retryable() : undefined;
              return expiry === undefined ? result
                : { ...result, error: `APP_BUILD_APPROVAL_PRESENTATION_RETRYABLE:${expiry}` };
            } } : provider) };
      }
      // requestDecision tells «declined» from «nobody answered»; a plain requestConfirmation can only say yes/no.
      // A cancelled turn or a missing channel never approves and never records a refusal: the node is held.
      const decideWith = async (prompt: string, signal?: AbortSignal, windowMs?: number): Promise<ApprovalOutcome> => {
        if (signal?.aborted) return { approved: false, reason: 'turn-cancelled' };
        if (options.requestDecision)
          return await options.requestDecision(prompt, signal, windowMs === undefined ? undefined : { timeoutMs: windowMs });
        if (options.requestConfirmation) return normalizeApproval(await options.requestConfirmation(prompt));
        return { approved: false, reason: 'unavailable' };
      };
      const runId = randomUUID();
      const progress = createGraphProgressCollector({ graphId, runId }, options.observeGraphProgress);
      const input = { ...args,
        ...(approvalRegistry ? { appSlug: owner.appSlug } : {}),
        ...(args.ask === undefined && route.defaultAsk ? { ask: route.defaultAsk } : {}),
        context: { ...inputContext, memberId: owner.id } };
      const priorNodeLifecycle = route.deps?.nodeLifecycle;
      const deps = { ...route.deps, ...(approvalRegistry ? { capabilityProviders: approvalRegistry } : {}),
        nodeLifecycle: async (event: import('../graph-runner/runner.js').GraphNodeLifecycleEvent) => {
        try { await priorNodeLifecycle?.(event); }
        finally { progress.observe(event); }
      }, callLLM: route.deps?.callLLM ?? options.graphPrompt ?? (async (prompt: string) => {
        const { buildCliWorkflowDeps } = await import('./workflow.js');
        return buildCliWorkflowDeps().callLLM({ prompt });
      }) };
      const state = await runGraph(graphFile, { runId, input, verifiedOwnerId: owner.id, quiet: true,
        ...(dispatchContext?.signal ? { signal: dispatchContext.signal } : {}), deps });
      const ordinaryPending = state.status === 'awaiting-approval'
        && realpathSync(graphFile) === realpathSync(ordinaryAppBuildFile);
      if (ordinaryPending) {
        const { APP_BUILD_REVIEW_PUBLISH_NODE } = await import('../graph-runner/capability-providers/app-build-rich-traversal.js');
        if (state.pending?.nodeId !== APP_BUILD_REVIEW_PUBLISH_NODE)
          return { ...state, graphObservation: progress.snapshot() };
        // The owner gets the full publish-approval window here (not the short shell window); running out of
        // it, or a cancelled turn, leaves the node waiting and resumable instead of recording a refusal.
        const decision = await decideWith(state.pending.message, turnSignal, APP_BUILD_OWNER_APPROVAL_WINDOW_MS);
        if (dispatchContext?.signal?.aborted && !isApprovalHold(decision)) throw new Error('APP_BUILD_OWNER_PRESENTATION_REFUSED');
        if (isApprovalHold(decision)) {
          return { ...state, graphObservation: progress.snapshot(),
            approvalHold: approvalHold(state, APP_BUILD_REVIEW_PUBLISH_NODE, decision.reason) };
        }
        decideGraphApproval(state.graphId, state.runId, decision.approved ? 'approved' : 'rejected', owner.id,
          deps.root, { nodeId: APP_BUILD_REVIEW_PUBLISH_NODE,
            visit: state.path.filter(node => node === APP_BUILD_REVIEW_PUBLISH_NODE).length });
        const resumed = await runGraph(graphFile, { resumeRunId: state.runId, resumeGraphId: state.graphId,
          verifiedOwnerId: owner.id, quiet: true,
          ...(dispatchContext?.signal ? { signal: dispatchContext.signal } : {}), deps });
        return { ...resumed, graphObservation: progress.snapshot() };
      }
      if (state.status !== 'awaiting-approval' || !Object.hasOwn(args, 'ticketDesignPath'))
        return { ...state, graphObservation: progress.snapshot() };
      // A connection-needed card must remain visible and cannot authorize spending.
      if (state.pending?.message.includes('클라우드 연결 필요'))
        return { ...state, graphObservation: progress.snapshot() };
      const { scene5DecisionPromptFromGraph } = await import('../tui-client/scene5-decision-consumer.js');
      const prompt = scene5DecisionPromptFromGraph(state, graphId, args.ticketDesignPath);
      const decision = await decideWith(prompt, turnSignal);
      const pendingNodeId = state.pending!.nodeId;
      if (isApprovalHold(decision)) {
        return { ...state, graphObservation: progress.snapshot(), approvalHold: approvalHold(state, pendingNodeId, decision.reason) };
      }
      decideGraphApproval(state.graphId, state.runId, decision.approved ? 'approved' : 'rejected', owner.id,
        deps?.root, { nodeId: pendingNodeId, visit: state.path.filter(node => node === pendingNodeId).length });
      const resumed = await runGraph(graphFile, { resumeRunId: state.runId, resumeGraphId: state.graphId, verifiedOwnerId: owner.id,
        quiet: true, ...(deps ? { deps } : {}) });
      return { ...resumed, graphObservation: progress.snapshot() };
    }),
    // A decision-only host still answers the tool-level yes/no (undecided counts as no there).
    requestConfirmation: options.requestConfirmation
      ?? (options.requestDecision ? async (prompt: string) => (await options.requestDecision!(prompt)).approved : undefined),
    getDispatchContext: dispatchContext,
  });
  const hostTools = routes.hostTools(host.hostLLMTools());
  return {
    hostTools,
    dispatchPluginTool: async (name, args) => await routes.dispatch(name, args, false, await dispatchContext()) ?? host.dispatchTool(name, args),
  };
}
