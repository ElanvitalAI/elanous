import { BUDGET_SNAPSHOT_ENV } from '../../execution-loop/launch-gate.js';

// Preserve the manifest contract except for two values generated per launch.
export function stablePodManifestText(applied: Array<Record<string, any>>): string {
  const manifests = structuredClone(applied.filter((entry) => entry.kind === 'Job' || entry.kind === 'Secret'));
  let snapshots = 0;
  for (const manifest of manifests) {
    if (manifest.kind !== 'Job') continue;
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
  return JSON.stringify(manifests).replace(/run-[0-9a-f-]{36}/g, 'run-<id>');
}
