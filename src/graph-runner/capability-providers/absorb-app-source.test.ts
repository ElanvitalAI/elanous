import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyGraphCapabilityRegistry } from '../capabilities.js';
import { registerAbsorbAppSourceProvider } from './absorb-app-source.js';
import { createAbsorbBuildGraphRootRegistry } from './absorb-member-registry.js';

const manifestYaml = 'apiVersion: elanous.app/v0\nslug: ticket-app\ntitle: Ticket app\nfrontend:\n  kind: static-export\n  out: out\n';
const html = '<!doctype html><html><body><h1>Ticket queue</h1></body></html>';

test('generated source becomes an owner-bound real app bundle; empty and foreign drafts leave no files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'absorb-app-source-'));
  try {
    const registry = registerAbsorbAppSourceProvider(emptyGraphCapabilityRegistry(), root);
    const provider = registry.providers.at(-1)!;
    const context = {
      graphId: 'absorb-build', runId: 'run-123', nodeId: 'build', verifiedOwnerId: 'member-a',
      input: { context: { memberId: 'member-a' } }, graphInput: { context: { memberId: 'member-a' } },
      nodeInput: { memberId: 'member-a', appId: 'ticket-app',
        suggestion: { owner: 'member-a', appId: 'ticket-app' },
        draft: { manifestYaml, html } }, outputs: {},
    };
    const empty = await provider.invoke({ ...context, nodeInput: {
      memberId: 'member-a', appId: 'ticket-app',
      suggestion: { owner: 'member-a', appId: 'ticket-app' }, draft: {},
    } });
    expect(empty).toMatchObject({ ok: false });
    expect(existsSync(join(root, 'app-build-artifacts'))).toBe(false);
    const foreign = await provider.invoke({ ...context, verifiedOwnerId: 'member-b' });
    expect(foreign).toMatchObject({ ok: false });
    const forgedSuggestion = await provider.invoke({ ...context, nodeInput: {
      ...context.nodeInput, suggestion: { owner: 'member-b', appId: 'ticket-app' },
    } });
    expect(forgedSuggestion).toMatchObject({ ok: false });
    for (const identity of [{ ownerId: 'member-b' }, { runId: 'forged' }]) {
      const forgedDraft = await provider.invoke({ ...context, nodeInput: {
        ...context.nodeInput, draft: { manifestYaml, html, ...identity },
      } });
      expect(forgedDraft).toMatchObject({ ok: false });
    }
    const invalidManifest = await provider.invoke({ ...context, nodeInput: {
      ...context.nodeInput, draft: { manifestYaml: manifestYaml.replace('ticket-app', 'other-app'), html },
    } });
    expect(invalidManifest).toMatchObject({ ok: false });
    const missingHtml = await provider.invoke({ ...context, nodeInput: {
      ...context.nodeInput, draft: { manifestYaml },
    } });
    expect(missingHtml).toMatchObject({ ok: false });
    expect(existsSync(join(root, 'app-build-artifacts'))).toBe(false);
    const built = await provider.invoke(context);
    expect(built).toMatchObject({ ok: true, outcome: 'done',
      result: { artifact: { ownerId: 'member-a', runId: 'run-123', manifest: { slug: 'ticket-app' } } } });
    const artifact = (built.result as { artifact: { staticExportDir: string } }).artifact;
    expect(readFileSync(join(artifact.staticExportDir, '..', 'app.yaml'), 'utf8')).toBe(manifestYaml);
    expect(readFileSync(join(artifact.staticExportDir, 'index.html'), 'utf8')).toBe(html);
    const graphRootProvider = createAbsorbBuildGraphRootRegistry(root).providers
      .find(item => item.id === 'absorb-generated-app-source')!;
    const graphRootBuild = await graphRootProvider.invoke(context);
    expect((graphRootBuild.result as { artifact: { staticExportDir: string } }).artifact.staticExportDir
      .startsWith(join(root, 'nexus', 'app-build-artifacts'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
