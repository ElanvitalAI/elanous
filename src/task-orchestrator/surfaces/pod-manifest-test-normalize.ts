import { BUDGET_SNAPSHOT_ENV } from '../../execution-loop/launch-gate.js';

/** The Pod push fence embeds a different six-hex run key in each independent launch. */
export function stablePodRunGuard(text: string): string {
  return text.replace(/pr-create-r[0-9a-f]{6}-/g, 'pr-create-r<run>-')
    .replace(/-r[0-9a-f]{6}(?=[-|*])/g, '-r<run>');
}

// Preserve the manifest contract except for the budget timestamp and run identities generated per launch.
export function stablePodManifestText(applied: Array<Record<string, any>>): string {
  const manifests = structuredClone(applied.filter((entry) => entry.kind === 'Job' || entry.kind === 'Secret'));
  let snapshots = 0;
  for (const manifest of manifests) {
    if (manifest.kind !== 'Job') continue;
    // POD-LAUNCH-PROVENANCE — the request time and the 8-char run/parent labels are per launch like the run id.
    for (const meta of [manifest.metadata, manifest.spec?.template?.metadata]) {
      for (const bag of [meta?.labels, meta?.annotations]) {
        if (!bag) continue;
        if (bag['elanous.ai/requested-at'] !== undefined) bag['elanous.ai/requested-at'] = '<requested-at>';
        if (meta?.labels === bag) for (const key of ['elanous.ai/run', 'elanous.ai/parent']) if (bag[key] !== undefined) bag[key] = '<run-label>';
      }
    }
    for (const container of manifest.spec?.template?.spec?.containers ?? []) {
      for (const entry of container.env ?? []) if (entry.name === 'ELANOUS_POD_REQUESTED_AT') entry.value = '<requested-at>';
    }
    for (const container of manifest.spec?.template?.spec?.containers ?? []) {
      for (const entry of container.env ?? []) {
        if (entry.name !== BUDGET_SNAPSHOT_ENV) continue;
        snapshots++;
        // Keep every original byte except this one volatile numeric value.
        const measuredAt = /("measuredAt"\s*:\s*)\d+/g;
        const matches = [...entry.value.matchAll(measuredAt)];
        if (matches.length !== 1) throw new Error('budget snapshot must have exactly one numeric measuredAt');
        entry.value = entry.value.replace(measuredAt, (_match: string, prefix: string) => `${prefix}0`);
      }
    }
  }
  if (snapshots === 0) throw new Error('manifest comparison requires a budget snapshot');
  return stablePodRunGuard(JSON.stringify(manifests).replace(/run-[0-9a-f-]{36}/g, 'run-<id>'));
}
