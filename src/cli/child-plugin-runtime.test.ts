import { expect, test } from 'bun:test';
import { createChildPluginRuntimeContract } from './child-plugin-runtime.js';
import { decideGraphApproval, readGraphRun, runGraph } from '../graph-runner/runner.js';
import { APP_BUILD_OWNER_APPROVAL_WINDOW_MS } from '../core-turn/seat-turn-cap.js';
import type { ApprovalOutcome } from '../graph-runner/approval-outcome.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGcpScene5FakeProvider } from '../ux-sim/gcp-architect-expand/scene5-fake-provider.js';
import { buildCliAgentTools } from './agent-cli.js';
import { registerToolRuntime, unregisterToolRuntime } from '../tool-runtime/registry.js';
import type { GraphProgressObservation } from '../graph-runner/graph-progress-observation.js';
import { emptyGraphCapabilityRegistry } from '../graph-runner/capabilities.js';
import { createRichSourceBuildWithApprovalRegistry } from '../graph-runner/capability-providers/app-build-rich-traversal.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

test('ordinary app build refuses when the trusted approval provider is absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'child-app-build-approval-'));
  try {
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'owner-a', appSlug: 'ticketing' },
      graphDeps: { root, capabilityProviders: emptyGraphCapabilityRegistry() },
      requestConfirmation: async () => true });
    const response = await bridge.dispatchPluginTool('app_build', { ask: 'Build a private ticketing app',
      seedRequested: false, appSlug: 'ticketing', artifactMetadata: {
        runtime: { startCommand: ['bun', 'backend/entry.ts'], healthPath: '/health' } } });
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).toContain('APP_BUILD_APPROVAL_REGISTRY_REQUIRED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordinary app build refuses an unbound owner even when the model supplies a valid slug', async () => {
  const root = mkdtempSync(join(tmpdir(), 'child-app-build-unbound-'));
  try {
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'owner-a' },
      graphDeps: { root, capabilityProviders: createRichSourceBuildWithApprovalRegistry() },
      requestConfirmation: async () => true });
    const response = await bridge.dispatchPluginTool('app_build', { ask: 'Build a private app',
      seedRequested: false, appSlug: 'model-forged', artifactMetadata: {
        runtime: { startCommand: ['bun', 'backend/entry.ts'], healthPath: '/health' } } });
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).toContain('APP_BUILD_TRUSTED_ENTRY_REQUIRED');
    expect(existsSync(join(root, 'graph-runs'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordinary app build approves after a simulated 20-minute build', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'child-app-build-approved-')));
  const previousState = process.env.ELANOUS_STATE_DIR;
  const originalDateNow = Date.now;
  let buildElapsedMs = 0;
  const url = 'https://api.elanous.ai/v1/members/deployment-approvals/8f195ad4-a4e2-4b31-a7bc-155602760279';
  const actions: string[] = [];
  const prompts: string[] = [];
  let publishes = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    expect(new URL(request.url).pathname).toBe('/v1/apps/ticketing/dynamic-deployment-local');
    const body = await request.json() as { action: string };
    actions.push(body.action);
    if (body.action === 'approval-start') return Response.json({ status: 'approval-pending',
      approvalUrl: url, pendingExpiresAt: new Date(Date.now() + 20_000).toISOString() });
    if (body.action === 'approval-poll') return Response.json({ status: 'approval-approved' });
    return Response.json({ error: 'unexpected' }, { status: 400 });
  } });
  try {
    process.env.ELANOUS_STATE_DIR = root;
    setElanousConfigDir(root);
    mkdirSync(join(root, 'nexus'), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'acp-token'), 'synthetic-local-control', { mode: 0o600 });
    writeFileSync(join(root, 'nexus', 'runtime.json'), JSON.stringify({
      pid: process.pid, httpAuth: 'on', httpPort: server.port }), { mode: 0o600 });
    const base = createRichSourceBuildWithApprovalRegistry();
    const registry = { ...base, providers: base.providers.map(provider =>
      provider.id === 'app-build-owner-publish-approval' ? provider : { ...provider,
        invoke: async (context: { nodeId: string }) => {
          if (context.nodeId === 'source-items') return { ok: true, outcome: 'done' as const,
            result: { items: [{ kind: 'web', requested: false }, { kind: 'document', requested: false },
              { kind: 'aside', requested: false }] } };
          if (context.nodeId === 'materialize') buildElapsedMs = 20 * 60_000;
          if (context.nodeId === 'publish') publishes++;
          return { ok: true, outcome: 'done' as const, result: { status: 'done' } };
        } }) };
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'owner-a', appSlug: 'ticketing' },
      graphDeps: { root, capabilityProviders: registry },
      requestConfirmation: async prompt => { prompts.push(prompt); return true; } });
    Date.now = () => originalDateNow() + buildElapsedMs;
    const response = await bridge.dispatchPluginTool('app_build', { ask: 'Build a ticketing app',
      seedRequested: false, appSlug: 'model-forged', artifactMetadata: {
        runtime: { startCommand: ['bun', 'backend/entry.ts'], healthPath: '/health' } } });
    expect(response).toMatchObject({ ok: true, result: { status: 'done' } });
    expect(buildElapsedMs).toBe(20 * 60_000);
    expect(actions).toEqual(['approval-start', 'approval-poll']);
    expect(publishes).toBe(1);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('게시 승인을 진행합니까');
    expect(prompts[2]).toContain(url);
    expect(JSON.stringify(response)).not.toContain('8f195ad4');
    if (!response.ok) throw new Error(response.error);
    const state = response.result as { runId: string; path: string[] };
    expect(state.path.filter(node => node === 'review-publish')).toHaveLength(1);
    const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', 'app-build', `${state.runId}.json`), 'utf8'));
    expect(ledger.input.appSlug).toBe('ticketing');
    expect(ledger.nodes.find((node: { nodeId: string }) => node.nodeId === 'review-publish')?.output).toContain('approved');
    expect(state.path).toContain('publish-approval');
    expect(state.path.indexOf('publish-approval')).toBeLessThan(state.path.indexOf('publish'));
  } finally {
    Date.now = originalDateNow;
    server.stop();
    resetElanousConfigDir();
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
    rmSync(root, { recursive: true, force: true });
  }
});

test('the approval URL goes to the host publish screen when there is one — structured, not inside a text prompt', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'child-app-build-approved-')));
  const previousState = process.env.ELANOUS_STATE_DIR;
  const originalDateNow = Date.now;
  let buildElapsedMs = 0;
  const url = 'https://api.elanous.ai/v1/members/deployment-approvals/8f195ad4-a4e2-4b31-a7bc-155602760279';
  const actions: string[] = [];
  const prompts: string[] = [];
  const screens: Array<{ shownUrl: string; expiresAt: string; prompt: string; signal: boolean }> = [];
  let publishes = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    expect(new URL(request.url).pathname).toBe('/v1/apps/ticketing/dynamic-deployment-local');
    const body = await request.json() as { action: string };
    actions.push(body.action);
    if (body.action === 'approval-start') return Response.json({ status: 'approval-pending',
      approvalUrl: url, pendingExpiresAt: new Date(Date.now() + 20_000).toISOString() });
    if (body.action === 'approval-poll') return Response.json({ status: 'approval-approved' });
    return Response.json({ error: 'unexpected' }, { status: 400 });
  } });
  try {
    process.env.ELANOUS_STATE_DIR = root;
    setElanousConfigDir(root);
    mkdirSync(join(root, 'nexus'), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'acp-token'), 'synthetic-local-control', { mode: 0o600 });
    writeFileSync(join(root, 'nexus', 'runtime.json'), JSON.stringify({
      pid: process.pid, httpAuth: 'on', httpPort: server.port }), { mode: 0o600 });
    const base = createRichSourceBuildWithApprovalRegistry();
    const registry = { ...base, providers: base.providers.map(provider =>
      provider.id === 'app-build-owner-publish-approval' ? provider : { ...provider,
        invoke: async (context: { nodeId: string }) => {
          if (context.nodeId === 'source-items') return { ok: true, outcome: 'done' as const,
            result: { items: [{ kind: 'web', requested: false }, { kind: 'document', requested: false },
              { kind: 'aside', requested: false }] } };
          if (context.nodeId === 'materialize') buildElapsedMs = 20 * 60_000;
          if (context.nodeId === 'publish') publishes++;
          return { ok: true, outcome: 'done' as const, result: { status: 'done' } };
        } }) };
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'owner-a', appSlug: 'ticketing' },
      graphDeps: { root, capabilityProviders: registry },
      requestConfirmation: async prompt => { prompts.push(prompt); return true; },
      requestPublishApproval: async (shownUrl, expiresAt, prompt, signal) => { screens.push({ shownUrl, expiresAt, prompt, signal: signal instanceof AbortSignal }); return true; } });
    Date.now = () => originalDateNow() + buildElapsedMs;
    const response = await bridge.dispatchPluginTool('app_build', { ask: 'Build a ticketing app',
      seedRequested: false, appSlug: 'model-forged', artifactMetadata: {
        runtime: { startCommand: ['bun', 'backend/entry.ts'], healthPath: '/health' } } });
    expect(response).toMatchObject({ ok: true, result: { status: 'done' } });
    expect(buildElapsedMs).toBe(20 * 60_000);
    expect(actions).toEqual(['approval-start', 'approval-poll']);
    expect(publishes).toBe(1);
    // The URL screen took the approval link; the two ordinary confirmations still use the text prompt.
    expect(prompts).toHaveLength(2);
    expect(prompts.some(prompt => prompt.includes(url))).toBe(false);
    expect(screens).toHaveLength(1);
    expect(screens[0]).toMatchObject({ shownUrl: url, signal: true });
    expect(Number.isFinite(Date.parse(screens[0]!.expiresAt))).toBe(true);
    expect(screens[0]!.prompt).toContain(url); // the text fallback the host shows only when it has no publish screen
    expect(JSON.stringify(response)).not.toContain('8f195ad4');
    if (!response.ok) throw new Error(response.error);
    const state = response.result as { runId: string; path: string[] };
    expect(state.path.filter(node => node === 'review-publish')).toHaveLength(1);
    const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', 'app-build', `${state.runId}.json`), 'utf8'));
    expect(ledger.input.appSlug).toBe('ticketing');
    expect(ledger.nodes.find((node: { nodeId: string }) => node.nodeId === 'review-publish')?.output).toContain('approved');
    expect(state.path).toContain('publish-approval');
    expect(state.path.indexOf('publish-approval')).toBeLessThan(state.path.indexOf('publish'));
  } finally {
    Date.now = originalDateNow;
    server.stop();
    resetElanousConfigDir();
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
    rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary app build never publishes when owner approval is pending or denied', async () => {
  for (const mode of ['pending', 'denied'] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'child-app-build-refused-')));
    const previousState = process.env.ELANOUS_STATE_DIR;
    const actions: string[] = [];
    let publishes = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as { action: string };
      actions.push(body.action);
      if (body.action === 'approval-start' && mode === 'pending') return Response.json({
        status: 'approval-pending',
        approvalUrl: 'https://api.elanous.ai/v1/members/deployment-approvals/8f195ad4-a4e2-4b31-a7bc-155602760279',
        pendingExpiresAt: new Date(Date.now() + 100).toISOString() });
      return Response.json({ status: 'approval-denied' });
    } });
    try {
      process.env.ELANOUS_STATE_DIR = root;
      setElanousConfigDir(root);
      mkdirSync(join(root, 'nexus'), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, 'acp-token'), 'synthetic-local-control', { mode: 0o600 });
      writeFileSync(join(root, 'nexus', 'runtime.json'), JSON.stringify({
        pid: process.pid, httpAuth: 'on', httpPort: server.port }), { mode: 0o600 });
      const base = createRichSourceBuildWithApprovalRegistry();
      const registry = { ...base, providers: base.providers.map(provider =>
        provider.id === 'app-build-owner-publish-approval' ? provider : { ...provider,
          invoke: async (context: { nodeId: string }) => {
            if (context.nodeId === 'source-items') return { ok: true, outcome: 'done' as const,
              result: { items: [{ kind: 'web', requested: false }, { kind: 'document', requested: false },
                { kind: 'aside', requested: false }] } };
            if (context.nodeId === 'publish') publishes++;
            return { ok: true, outcome: 'done' as const, result: { status: 'done' } };
          } }) };
      const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'owner-a', appSlug: 'ticketing' },
        graphDeps: { root, capabilityProviders: registry }, requestConfirmation: async () => true });
      const response = await bridge.dispatchPluginTool('app_build', { ask: 'Build a ticketing app',
        seedRequested: false, appSlug: 'ticketing', artifactMetadata: {
          runtime: { startCommand: ['bun', 'backend/entry.ts'], healthPath: '/health' } } });
      expect(response).toMatchObject({ ok: true, result: { status: 'failed' } });
      expect(actions[0]).toBe('approval-start');
      expect(publishes).toBe(0);
      if (!response.ok) throw new Error(response.error);
      const state = response.result as { path: string[] };
      expect(state.path).toContain('publish-approval');
      expect(state.path).not.toContain('publish');
    } finally {
      server.stop();
      resetElanousConfigDir();
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('ordinary app build HITL rejection resumes the exact run to failed without server approval or publish', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'child-app-build-hitl-reject-')));
  let publishes = 0;
  let serverApprovals = 0;
  const prompts: string[] = [];
  try {
    const base = createRichSourceBuildWithApprovalRegistry();
    const registry = { ...base, providers: base.providers.map(provider => ({ ...provider,
      invoke: async (context: { nodeId: string }) => {
        if (context.nodeId === 'source-items') return { ok: true, outcome: 'done' as const,
          result: { items: [{ kind: 'web', requested: false }, { kind: 'document', requested: false },
            { kind: 'aside', requested: false }] } };
        if (context.nodeId === 'publish-approval') serverApprovals++;
        if (context.nodeId === 'publish') publishes++;
        return { ok: true, outcome: 'done' as const, result: { status: 'done' } };
      },
    })) };
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'owner-a', appSlug: 'ticketing' },
      graphDeps: { root, capabilityProviders: registry },
      requestConfirmation: async prompt => { prompts.push(prompt); return prompts.length === 1; } });
    const response = await bridge.dispatchPluginTool('app_build', { ask: 'Build a ticketing app',
      seedRequested: false, appSlug: 'ticketing', artifactMetadata: {
        runtime: { startCommand: ['bun', 'backend/entry.ts'], healthPath: '/health' } } });
    expect(response).toMatchObject({ ok: true, result: { status: 'failed' } });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('게시 승인을 진행합니까');
    expect(serverApprovals).toBe(0);
    expect(publishes).toBe(0);
    if (!response.ok) throw new Error(response.error);
    const state = response.result as { runId: string; path: string[] };
    expect(state.path).toContain('review-publish');
    expect(state.path).not.toContain('publish-approval');
    const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', 'app-build', `${state.runId}.json`), 'utf8'));
    expect(ledger.nodes.find((node: { nodeId: string }) => node.nodeId === 'review-publish')?.output).toContain('declined');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// An approval nobody answered (timeout, cancelled turn, no channel) is not an owner refusal.
async function appBuildReviewPublish(outcome: ApprovalOutcome, mode: 'both' | 'decision-only' = 'both') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'child-app-build-hold-')));
  let publishes = 0;
  const decisions: Array<{ prompt: string; timeoutMs?: number }> = [];
  try {
    const base = createRichSourceBuildWithApprovalRegistry();
    const registry = { ...base, providers: base.providers.map(provider => ({ ...provider,
      invoke: async (context: { nodeId: string }) => {
        if (context.nodeId === 'source-items') return { ok: true, outcome: 'done' as const,
          result: { items: [{ kind: 'web', requested: false }, { kind: 'document', requested: false },
            { kind: 'aside', requested: false }] } };
        if (context.nodeId === 'publish') publishes++;
        return { ok: true, outcome: 'done' as const, result: { status: 'done' } };
      },
    })) };
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'owner-a', appSlug: 'ticketing' },
      graphDeps: { root, capabilityProviders: registry },
      ...(mode === 'both' ? { requestConfirmation: async () => true } : {}),
      requestDecision: async (prompt, _signal, options) => {
        decisions.push({ prompt, ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
        // The owner-presentation prompt (first) is acknowledged; the review-publish prompt gets the outcome under test.
        return prompt.includes('게시 승인을 진행합니까') ? outcome : { approved: true };
      } });
    const response = await bridge.dispatchPluginTool('app_build', { ask: 'Build a ticketing app',
      seedRequested: false, appSlug: 'ticketing', artifactMetadata: {
        runtime: { startCommand: ['bun', 'backend/entry.ts'], healthPath: '/health' } } });
    if (!response.ok) throw new Error(response.error);
    const state = response.result as { runId: string; status: string; path: string[]; approvalHold?: { nodeId: string; reason: string; message: string; resume?: string } };
    const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', 'app-build', `${state.runId}.json`), 'utf8'));
    return { state, ledger, decisions, publishes };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('review-publish approval that times out or is cancelled holds the node: not rejected, resumable, owner window is 15 minutes', async () => {
  for (const reason of ['timeout', 'turn-cancelled', 'unavailable'] as const) {
    const { state, ledger, decisions, publishes } = await appBuildReviewPublish({ approved: false, reason });
    expect(state.status).toBe('awaiting-approval');
    expect(state.approvalHold).toMatchObject({ nodeId: 'review-publish', reason });
    expect(state.approvalHold!.message).toContain('NOT rejected');
    expect(state.approvalHold!.resume).toContain(`--resume ${state.runId}`);
    expect(state.approvalHold!.resume).toContain('app-build.yaml');
    expect(ledger.status).toBe('awaiting-approval');
    expect(ledger.pending.nodeId).toBe('review-publish');
    expect(ledger.pending.decision).toBeUndefined();
    expect(ledger.pending.decidedBy).toBeUndefined();
    expect(JSON.stringify(ledger)).not.toContain('approval rejected');
    expect(publishes).toBe(0);
    expect(decisions.at(-1)?.timeoutMs).toBe(APP_BUILD_OWNER_APPROVAL_WINDOW_MS);
  }
});

test('review-publish with only a decision channel (no requestConfirmation) works and an unavailable channel holds', async () => {
  const held = await appBuildReviewPublish({ approved: false, reason: 'unavailable' }, 'decision-only');
  expect(held.state.status).toBe('awaiting-approval');
  expect(held.state.approvalHold).toMatchObject({ nodeId: 'review-publish', reason: 'unavailable' });
  expect(held.ledger.pending.decision).toBeUndefined();
  const declined = await appBuildReviewPublish({ approved: false, reason: 'declined' }, 'decision-only');
  expect(declined.state.status).toBe('failed');
});

test('a held review-publish can be decided afterwards and the same run resumes past it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'child-app-build-hold-resume-')));
  try {
    const base = createRichSourceBuildWithApprovalRegistry();
    const registry = { ...base, providers: base.providers.map(provider => ({ ...provider,
      invoke: async (context: { nodeId: string }) => {
        if (context.nodeId === 'source-items') return { ok: true, outcome: 'done' as const,
          result: { items: [{ kind: 'web', requested: false }, { kind: 'document', requested: false },
            { kind: 'aside', requested: false }] } };
        return { ok: true, outcome: 'done' as const, result: { status: 'done' } };
      },
    })) };
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'owner-a', appSlug: 'ticketing' },
      graphDeps: { root, capabilityProviders: registry }, requestConfirmation: async () => true,
      requestDecision: async prompt => prompt.includes('게시 승인을 진행합니까') ? { approved: false, reason: 'timeout' } : { approved: true } });
    const response = await bridge.dispatchPluginTool('app_build', { ask: 'Build a ticketing app',
      seedRequested: false, appSlug: 'ticketing', artifactMetadata: {
        runtime: { startCommand: ['bun', 'backend/entry.ts'], healthPath: '/health' } } });
    if (!response.ok) throw new Error(response.error);
    const held = response.result as { graphId: string; runId: string; status: string; graphPath?: string };
    expect(held.status).toBe('awaiting-approval');
    // The owner decides later (the `graph approve` command records exactly this), then the same run continues.
    decideGraphApproval(held.graphId, held.runId, 'approved', 'owner-a', root);
    const resumed = await runGraph(held.graphPath!, { resumeRunId: held.runId, resumeGraphId: held.graphId,
      verifiedOwnerId: 'owner-a', quiet: true, deps: { root, capabilityProviders: registry } });
    const saved = readGraphRun(held.graphId, held.runId, root);
    expect(resumed.runId).toBe(held.runId);
    expect(resumed.status).toBe('done');
    expect(resumed.path.slice(resumed.path.indexOf('review-publish'))).toEqual(['review-publish', 'publish-approval', 'publish', 'done']);
    expect(saved?.status).toBe('done');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('review-publish approval the owner declines still ends failed and records the owner refusal', async () => {
  const { state, ledger } = await appBuildReviewPublish({ approved: false, reason: 'declined' });
  expect(state.status).toBe('failed');
  expect(state.approvalHold).toBeUndefined();
  expect(ledger.nodes.find((node: { nodeId: string }) => node.nodeId === 'review-publish')?.output).toContain('declined');
});

test('actual verified graph route sends the same bounded progress to display and supervisor input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'child-graph-progress-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  const displayed: GraphProgressObservation[] = [];
  try {
    process.env.ELANOUS_STATE_DIR = root;
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-p5' },
      graphDeps: { root }, observeGraphProgress: event => displayed.push(event) });
    const response = await bridge.dispatchPluginTool('scrap_add', { kind: 'text', text: 'P5 fixture' });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error);
    const result = response.result as { graphId: string; runId: string;
      graphObservation: { graphId: string; runId: string; events: GraphProgressObservation[] } };
    expect(displayed.some(item => item.kind === 'started')).toBe(true);
    expect(displayed.some(item => item.kind === 'completed')).toBe(true);
    expect(result.graphObservation.events).toEqual(displayed);
    expect(result.graphObservation).toMatchObject({ graphId: result.graphId, runId: result.runId });
    expect(JSON.stringify(result.graphObservation)).not.toContain('member-p5');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('default child route supplies the declared document provider and verified owner to the actual graph', async () => {
  const root = mkdtempSync(join(tmpdir(), 'child-graph-deps-'));
  const priorState = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-kcb' }, graphDeps: { root } });
    const response = await bridge.dispatchPluginTool('scrap_add', { kind: 'text', text: 'KCB receipt' });
    expect(response).toMatchObject({ ok: true, result: { graphId: 'absorb-ingest', status: 'done' } });
    if (!response.ok) throw new Error(response.error);
    const state = response.result as { runId: string; path: string[] };
    // The default manifest composes document parsing with the authenticated member store.
    expect(state.path).toContain('save');
    const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', 'absorb-ingest', `${state.runId}.json`), 'utf8'));
    expect(ledger.input.context.memberId).toBe('member-kcb');
  } finally {
    if (priorState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorState;
    rmSync(root, { recursive: true, force: true });
  }
});

test('default Scene 5 route consumes the actual paused Graph visit and records N before spending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scene5-route-graph-'));
  try {
    const designPath = join(root, 'ticket-design.json');
    const fixtureRoot = join(import.meta.dir, '..', '..', 'plugins', 'gcp-architect-expand', 'demo', 'fixtures');
    writeFileSync(designPath, readFileSync(join(fixtureRoot, 'ticketing-design.json')));
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const outDir = join(root, 'artifacts');
    mkdirSync(outDir);
    const attachments = ([
      ['diagram-source', 'architecture.excalidraw', 'application/json', 'diagram'],
      ['diagram', 'architecture.png', 'image/png', 'diagram'],
      ['pdf', 'architecture.pdf', 'application/pdf', 'pdf'],
      ['html', 'architecture.html', 'text/html', 'pdf'],
    ] as const).map(([kind, title, mime, producedBy]) => {
      const url = join(outDir, title);
      writeFileSync(url, `verified ${kind}`);
      return { kind, title, mime, producedBy, url, sha256: hash(url) };
    });
    const invoked: string[] = [];
    const registry = registerGcpScene5FakeProvider({
      pressure: JSON.parse(readFileSync(join(fixtureRoot, 'pressure.json'), 'utf8')),
      outDir, stateRoot: root, designNodeId: 'design', onInvoke: node => invoked.push(node),
      deliverables: async () => ({ attachments, receipt: { status: 'verified' } }) });
    const prompts: string[] = [];
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-300' },
      graphDeps: { root, capabilityProviders: registry },
      requestConfirmation: async prompt => { prompts.push(prompt); return prompts.length === 1; } });
    const response = await bridge.dispatchPluginTool('gcp_architect_expand', { ticketDesignPath: designPath });
    expect(response).toMatchObject({ ok: true, result: { graphId: 'gcp-architect-expand', status: 'failed' } });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('GCP 확장 비용 승인');
    expect(prompts[1]).toContain('검증된 첨부');
    expect(invoked).toEqual(['detect', 'design', 'deliverables']);
    const state = response.ok ? response.result as { runId: string } : null;
    const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', 'gcp-architect-expand', `${state?.runId}.json`), 'utf8'));
    expect(ledger.input.context.memberId).toBe('member-300');
    expect(ledger.nodes.find((node: { nodeId: string }) => node.nodeId === 'approve')?.output).toContain('declined');
    const approvedPrompts: string[] = [];
    const approvedBridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-300' },
      graphDeps: { root, capabilityProviders: registry },
      requestConfirmation: async prompt => { approvedPrompts.push(prompt); return true; } });
    const approved = await approvedBridge.dispatchPluginTool('gcp_architect_expand', { ticketDesignPath: designPath });
    expect(approved).toMatchObject({ ok: true, result: { graphId: 'gcp-architect-expand', status: 'done' } });
    expect(approvedPrompts).toHaveLength(2);
    expect(invoked.slice(-6)).toEqual(['detect', 'design', 'deliverables', 'provision', 'schedule', 'idle-stop']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('next child CLI exposes route metadata and dispatches a declared graph through the shared seam', async () => {
  const calls: Array<{ pluginId: string; graphId: string; graphFile: string; owner?: string }> = [];
  const prompts: string[] = [];
  const make = (approve: boolean) => createChildPluginRuntimeContract({
    verifiedOwner: { id: 'member-next' },
    requestConfirmation: async prompt => { prompts.push(prompt); return approve; },
    dispatchGraph: async (pluginId, graphId, graphFile, _args, context) => {
      calls.push({ pluginId, graphId, graphFile, owner: context?.verifiedOwner?.id });
      return { graphId, status: 'done' };
    },
  });
  const rejected = make(false);
  const route = rejected.hostTools.find(tool => tool.name === 'suggest_accept');
  expect(route).toMatchObject({ pluginId: 'absorb', route: { requiresConfirm: true, risk: 'high' } });
  await expect(rejected.dispatchPluginTool('suggest_accept', { suggestionId: 'demo' })).resolves.toMatchObject({ ok: false });
  expect(calls).toEqual([]);

  const accepted = make(true);
  await expect(accepted.dispatchPluginTool('suggest_accept', { suggestionId: 'demo' })).resolves.toEqual({
    ok: true, result: { graphId: 'absorb-build', status: 'done' },
  });
  expect(calls).toEqual([{
    pluginId: 'absorb', graphId: 'absorb-build',
    graphFile: join(import.meta.dir, '..', '..', 'plugins', 'absorb', 'graph', 'absorb-build.yaml'),
    owner: 'member-next',
  }]);
  expect(prompts).toContain('이 제안을 격리된 앱 복사본에 적용하고 시뮬레이션을 시작할까요? (y/N)');
});

test('next child CLI graph route fails closed without a verified owner', async () => {
  const bridge = createChildPluginRuntimeContract();
  const result = await bridge.dispatchPluginTool('suggest_list', {});
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('verified owner') });
});

test('next child CLI blocks an injected graph executor before confirmation without a verified owner', async () => {
  let graphCalls = 0;
  let confirmationCalls = 0;
  const bridge = createChildPluginRuntimeContract({
    dispatchGraph: async () => { graphCalls++; return { status: 'done' }; },
    requestConfirmation: async () => { confirmationCalls++; return true; },
  });
  const result = await bridge.dispatchPluginTool('suggest_accept', { suggestionId: 'demo' });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('verified owner') });
  expect(graphCalls).toBe(0);
  expect(confirmationCalls).toBe(0);
});

test('next child CLI runtime dispatch uses the registered runtime and carries its context', async () => {
  const id = 'r_hotspot_next_dispatch_probe';
  const seen: Array<{ surface: string; owner?: string; value?: unknown }> = [];
  registerToolRuntime({
    id, spec: { name: id, description: 'runtime dispatch probe', parameters: { type: 'object' } }, surfaces: ['tui'],
    run: async (args: Record<string, unknown>, context) => {
      seen.push({ surface: context.surface, owner: context.verifiedOwner?.id, value: args.value });
      return { output: 'runtime-called' };
    },
  });
  try {
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-next' } });
    expect(bridge.runtimeTools.map(tool => tool.id)).toContain(id);
    await expect(bridge.dispatchToolRuntime(id, { value: 'sent' })).resolves.toEqual({ output: 'runtime-called' });
    expect(seen).toEqual([{ surface: 'tui', owner: 'member-next', value: 'sent' }]);
  } finally {
    unregisterToolRuntime(id);
  }
});

test('next TUI child CLI catalog dispatches plugin graph and runtime calls through the production entry', async () => {
  const id = 'r_hotspot_next_cli_runtime_probe';
  const calls: string[] = [];
  registerToolRuntime({
    id, spec: { name: id, description: 'runtime dispatch probe', parameters: { type: 'object' } }, surfaces: ['tui'],
    run: async () => { calls.push('runtime'); return { output: 'runtime-called' }; },
  });
  try {
    const cli = buildCliAgentTools(undefined, undefined, process.cwd(), {
      verifiedOwner: { id: 'member-next' },
      dispatchGraph: async () => { calls.push('graph'); return { status: 'done' }; },
    });
    expect(cli.specs.find(spec => spec.name === 'suggest_list')).toMatchObject({ pluginId: 'absorb' });
    expect(cli.specs.map(spec => spec.name)).toContain(id);
    await expect(cli.dispatch('suggest_list', {})).resolves.toEqual({ status: 'done' });
    await expect(cli.dispatch(id, {})).resolves.toEqual({ output: 'runtime-called' });
    expect(calls).toEqual(['graph', 'runtime']);
  } finally {
    unregisterToolRuntime(id);
  }
});
