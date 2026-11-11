import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BoardApiDeps, BoardCardEvent } from '../../../src/nexus/api/board-api.js';
import { listGraphRuns, runGraph, type GraphRunOptions } from '../../../src/graph-runner/runner.js';
import { dispatchToolRoute, type ToolRouteMatch } from '../../../src/tool-router/index.js';

export interface BoardApprovalHandlerDeps {
  appsRoot: string;
  /** The same Graph v2 runner used by the classic suggest_accept route. */
  runGraph?: typeof runGraph;
  graphOptions?: Pick<GraphRunOptions, 'deps'>;
  createRunId?: () => string;
  now?: () => Date;
}

function verifiedAppTarget(appsRoot: string, appSlug: string | undefined): string {
  if (!appSlug || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(appSlug)) throw new Error('verified app slug required');
  const root = realpathSync(resolve(appsRoot));
  const target = realpathSync(join(root, appSlug));
  const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || pathFromRoot.includes(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error('app target escapes verified root');
  }
  return target;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Resolve only the manifest-declared suggest_accept graph, within its plugin package. */
function declaredAcceptGraph(): { file: string; match: ToolRouteMatch; allowed: ReadonlySet<string> } {
  const pluginRoot = realpathSync(resolve(dirname(import.meta.dir)));
  const manifest = record(parseYaml(readFileSync(join(pluginRoot, 'plugin.yaml'), 'utf8')));
  const contributes = record(manifest?.contributes);
  const tools = Array.isArray(contributes?.aiTools) ? contributes.aiTools.map(record) : [];
  const tool = tools.find(item => item?.name === 'suggest_accept');
  const handler = tool?.handler;
  const route = record(tool?.route);
  if (typeof handler !== 'string' || !/^(?:\.\/)?graph:[a-z0-9-]+$/.test(handler) || !route?.requiresConfirm) {
    throw new Error('suggest_accept graph route is not declared');
  }
  const graphId = handler.replace(/^(?:\.\/)?graph:/, '');
  const assets = Array.isArray(manifest?.graphs) ? manifest.graphs : [];
  const allowed = new Set<string>();
  let file: string | undefined;
  for (const asset of assets) {
    if (typeof asset !== 'string' || isAbsolute(asset) || asset.split(/[\\/]/).includes('..')) continue;
    const candidate = realpathSync(join(pluginRoot, asset));
    const inside = relative(pluginRoot, candidate);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    const graph = record(parseYaml(readFileSync(candidate, 'utf8')));
    const id = record(graph?.graph)?.id;
    if (typeof id !== 'string') continue;
    allowed.add(id);
    if (id === graphId) file = candidate;
  }
  if (!file) throw new Error('suggest_accept graph asset is not allowlisted');
  return { file, allowed, match: {
    pluginId: String(manifest?.id), name: 'suggest_accept', handler,
    route: route as unknown as ToolRouteMatch['route'], bm25: 0, ontology: 0, ontologyTerms: [], score: 0,
  } };
}

/** The member's explicit OK is the route confirmation; graph nodes own all progress cards. */
export function createBoardApprovalDispatch(deps: BoardApprovalHandlerDeps): NonNullable<BoardApiDeps['dispatchApproved']> {
  return async (approved: BoardCardEvent, owner, existingRunId) => {
    const target = verifiedAppTarget(deps.appsRoot, owner.appSlug);
    const declaration = declaredAcceptGraph();
    const authorized = dispatchToolRoute(declaration.match, true, () => declaration.file, { allowedGraphIds: declaration.allowed });
    if (authorized.status !== 'dispatched') throw new Error('suggest_accept graph route denied');
    if (!deps.runGraph) {
      const providers = deps.graphOptions?.deps?.capabilityProviders;
      if (!providers || !('contracts' in providers)
        || !providers.contracts['store.read@1'] || !providers.contracts['app-publish.action@1']
        || !providers.contracts['store.events@1']
        || !providers.providers.some(item => item.provides.includes('store.read@1'))
        || !providers.providers.some(item => item.provides.includes('app-publish.action@1'))
        || !providers.providers.some(item => item.provides.includes('store.events@1'))) {
        throw new Error('absorb graph capability providers are unavailable');
      }
    }
    const runId = existingRunId ?? (deps.createRunId ?? (() => crypto.randomUUID()))();
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(runId)) throw new Error('invalid graph run id');
    const startedAt = (deps.now ?? (() => new Date()))().toISOString();
    const options: GraphRunOptions = {
      runId, quiet: true,
      input: { suggestionId: approved.cardId, startedAt, context: { memberId: owner.memberId, appRef: owner.appSlug, target, runId } },
      ...(deps.graphOptions?.deps ? { deps: deps.graphOptions.deps } : {}),
    };
    return { acceptanceId: runId, start: async () => {
      const prior = deps.runGraph ? undefined : listGraphRuns().runs.find(row => row.graphId === 'absorb-build' && row.runId === runId);
      if (prior?.status === 'done') return;
      if (prior && !['running', 'paused', 'awaiting-approval'].includes(prior.status)) throw new Error('existing absorb graph run is terminal');
      const runOptions = prior ? { ...options, runId: undefined, resumeRunId: runId, resumeGraphId: 'absorb-build' } : options;
      const state = await (deps.runGraph ?? runGraph)(authorized.result, runOptions);
      if (state.status !== 'done' && state.status !== 'awaiting-approval') throw new Error('absorb graph did not complete');
    } };
  };
}
