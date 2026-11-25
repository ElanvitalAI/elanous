export type BackendTier = 'T0' | 'T1' | 'T2';
export type BackendEngine = 'Colima' | 'OrbStack' | 'Docker Desktop' | 'podman';

export interface BackendTierInput {
  memory: { totalBytes: number | null; availableBytes: number | null } | null;
  engines: readonly BackendEngine[];
}

export interface BackendTierRecommendation {
  tier: BackendTier;
  engines: BackendEngine[];
  reasons: string[];
  estimatedThresholds: true;
}

const GiB = 1024 ** 3;

/** Read-only advice. Thresholds are provisional estimates; low/unknown free RAM keeps the host on T0. */
export function recommendBackendTier(input: BackendTierInput): BackendTierRecommendation {
  const engines = [...new Set(input.engines)];
  const memory = input.memory;
  const reasons: string[] = [engines.length
    ? `Installed engines detected (${engines.join(', ')}): they may be considered for use; no new installation will be performed.`
    : 'No installed engine detected. T1/T2 require human consent to install an engine; nothing is installed automatically.'];
  if (!memory || memory.totalBytes === null || memory.availableBytes === null) {
    reasons.push('System RAM or currently available RAM could not be measured; installation-free T0 is recommended.');
    return { tier: 'T0', engines, reasons, estimatedThresholds: true };
  }
  if (memory.totalBytes < 8 * GiB || memory.availableBytes < 3 * GiB) {
    reasons.push(memory.totalBytes < 8 * GiB
      ? 'Total RAM is below the estimated T1 threshold of 8 GiB.'
      : 'Currently available RAM is below the estimated T1 threshold of 3 GiB.');
    if (engines.length) reasons.push(`Detected engines (${engines.join(', ')}) may remain installed, but additional installation is not recommended.`);
    return { tier: 'T0', engines, reasons, estimatedThresholds: true };
  }
  if (memory.totalBytes >= 16 * GiB && memory.availableBytes >= 8 * GiB) {
    reasons.push('T2 recommended: at least 16 GiB total RAM and 8 GiB available RAM (estimated thresholds).');
    return { tier: 'T2', engines, reasons, estimatedThresholds: true };
  }
  reasons.push('T1 recommended: at least 8 GiB total RAM and 3 GiB available RAM (estimated thresholds).');
  return { tier: 'T1', engines, reasons, estimatedThresholds: true };
}
