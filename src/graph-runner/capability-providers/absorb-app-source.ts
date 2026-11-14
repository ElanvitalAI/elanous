import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAppManifest } from '../../nexus/apps/app-contract.js';
import { nexusRootDir } from '../../nexus/paths.js';
import { registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry } from '../capabilities.js';

const CONTRACT = 'app-publish.source@1';
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/;
const MAX_SOURCE_BYTES = 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Materialize only generated source that passed the existing app manifest validator. */
export function registerAbsorbAppSourceProvider(registry: GraphCapabilityRegistry,
  artifactRoot = nexusRootDir()): GraphCapabilityRegistry {
  const withContract = registerGraphCapabilityContract(registry, {
    id: CONTRACT,
    input: { type: 'object', required: ['draft', 'suggestion', 'appId', 'memberId'], properties: {
      draft: { type: 'object' }, suggestion: { type: 'object' },
      appId: { type: 'string' }, memberId: { type: 'string' },
    } },
    output: { type: 'object', required: ['artifact'], properties: { artifact: { type: 'object' } } },
  });
  return registerGraphCapabilityProviderDeclaration(withContract, {
    id: 'absorb-generated-app-source', provides: [CONTRACT], tier: 'free',
    invoke: context => {
      const owner = context.verifiedOwnerId;
      const graphOwner = record(record(context.graphInput ?? context.input)?.context)?.memberId;
      const request = record(context.nodeInput ?? context.input);
      const draft = record(request?.draft);
      const suggestion = record(request?.suggestion);
      const appId = request?.appId;
      const runId = context.runId;
      if (!owner || graphOwner !== owner || request?.memberId !== owner || !draft
        || suggestion?.owner !== owner || suggestion.appId !== appId
        || typeof appId !== 'string' || !SLUG.test(appId) || !RUN_ID.test(runId))
        return { ok: false, outcome: 'failed', error: 'verified app source required' };
      if ((draft.ownerId !== undefined && draft.ownerId !== owner)
        || (draft.runId !== undefined && draft.runId !== runId))
        return { ok: false, outcome: 'failed', error: 'generated app identity mismatch' };
      const yaml = draft.manifestYaml;
      const html = draft.html;
      if (typeof yaml !== 'string' || typeof html !== 'string' || !html.trim()
        || !/<html(?:\s|>)/i.test(html) || !/<\/html\s*>/i.test(html)
        || Buffer.byteLength(yaml) > MAX_SOURCE_BYTES || Buffer.byteLength(html) > MAX_SOURCE_BYTES)
        return { ok: false, outcome: 'failed', error: 'generated app source missing or oversized' };
      const parsed = parseAppManifest(yaml);
      if (!parsed.ok || parsed.manifest.slug !== appId
        || record(parsed.manifest.frontend)?.kind !== 'static-export'
        || record(parsed.manifest.frontend)?.out !== 'out')
        return { ok: false, outcome: 'failed', error: 'generated app manifest rejected' };
      const ownerHash = createHash('sha256').update(owner).digest('hex');
      const base = join(artifactRoot, 'app-build-artifacts', ownerHash);
      mkdirSync(base, { recursive: true, mode: 0o700 });
      const runRoot = mkdtempSync(join(base, `${runId}-`));
      const appRoot = join(runRoot, appId);
      const staticExportDir = join(appRoot, 'out');
      mkdirSync(staticExportDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(appRoot, 'app.yaml'), yaml, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(staticExportDir, 'index.html'), html, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(runRoot, '.build-record.json'), JSON.stringify({ ownerId: owner, runId,
        slug: appId, appRoot: realpathSync(appRoot) }), { flag: 'wx', mode: 0o600 });
      const artifact = { manifest: parsed.manifest, staticExportDir, ownerId: owner, runId };
      return { ok: true, outcome: 'done', result: { artifact }, evidence: { artifact } };
    },
  });
}
