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
    ? `기존 엔진 설치 감지(${engines.join(', ')}): 권고 단에서 사용할 수 있으며 새 설치는 하지 않습니다.`
    : '기존 엔진을 찾지 못했습니다. T1/T2 실행에는 사람의 설치 동의가 필요하며 자동 설치는 없습니다.'];
  if (!memory || memory.totalBytes === null || memory.availableBytes === null) {
    reasons.push('시스템 RAM 또는 현재 가용 RAM을 측정하지 못해 설치 없는 T0를 권합니다.');
    return { tier: 'T0', engines, reasons, estimatedThresholds: true };
  }
  if (memory.totalBytes < 8 * GiB || memory.availableBytes < 3 * GiB) {
    reasons.push(memory.totalBytes < 8 * GiB
      ? 'T1 추정 문턱인 총 RAM 8 GiB 미만입니다.'
      : '현재 가용 RAM이 T1 추정 여유 3 GiB 미만입니다.');
    if (engines.length) reasons.push(`이미 감지한 엔진(${engines.join(', ')})은 그대로 둘 수 있지만 추가 설치를 권하지 않습니다.`);
    return { tier: 'T0', engines, reasons, estimatedThresholds: true };
  }
  if (memory.totalBytes >= 16 * GiB && memory.availableBytes >= 8 * GiB) {
    reasons.push('총 RAM 16 GiB 및 가용 RAM 8 GiB 이상으로 T2를 권합니다(추정 문턱).');
    return { tier: 'T2', engines, reasons, estimatedThresholds: true };
  }
  reasons.push('총 RAM 8 GiB 및 가용 RAM 3 GiB 이상으로 T1을 권합니다(추정 문턱).');
  return { tier: 'T1', engines, reasons, estimatedThresholds: true };
}
