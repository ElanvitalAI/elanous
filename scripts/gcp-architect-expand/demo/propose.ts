/** Model-agnostic Solar handoff consumer. No provider/model override or GCP connector. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { authorizeSingleGcp } from '../../../src/ux-sim/gcp-architect-expand/consumer.js';
import { ticketDesignFromArchitectureJson, type TicketDesign } from './design-result.js';
import { validateProposalPressure } from './pressure-input.js';

const option = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const inputPath = option('--ticket-design');
const pressurePath = option('--pressure');
const outputPath = option('--output');
if (!inputPath || !pressurePath || !outputPath) throw new Error('usage: bun propose.ts --ticket-design FILE --pressure FILE --output FILE');
const grant = authorizeSingleGcp({ currentTier: () => 'free' });
if (!grant.allowed) throw new Error(`single GCP entitlement denied: ${grant.reason}`);
const raw = readFileSync(inputPath);
const design: TicketDesign = ticketDesignFromArchitectureJson(JSON.parse(raw.toString('utf8')) as unknown);
const pressure = validateProposalPressure(JSON.parse(readFileSync(pressurePath, 'utf8')) as unknown);
if (design.schemaVersion !== 1 || !design.title?.trim() || !design.summary?.trim() ||
  !Array.isArray(design.requirements) || design.requirements.length < 3 ||
  !Array.isArray(design.localComponents) || design.localComponents.length === 0 ||
  !design.offloadWorkload?.trim() || !design.exportData?.trim() || !design.sourceKind?.trim())
  throw new Error('incomplete ticketing design result');
if (design.offloadKind !== 'batch' || !design.retryable || !design.checkpointable || design.containsPii)
  throw new Error('ticketing purchase or sensitive path cannot be moved by this demo');
const security = JSON.parse(readFileSync(new URL('../../../plugins/gcp-architect-expand/demo/security-defaults.json', import.meta.url), 'utf8')) as Record<string, string[]>;
if (!['public', 'internal'].includes(design.dataClass) || !security[design.dataClass])
  throw new Error('demo requires classified non-sensitive aggregate data');
const primaryRegion = design.region?.trim() || 'asia-northeast3';
if (!/^[a-z]+-[a-z]+\d$/.test(primaryRegion)) throw new Error('invalid demo region');
if (![design.usage?.vcpuHours, design.usage?.gibHours].every(value => Number.isFinite(value) && value > 0))
  throw new Error('expected usage is required');
const packPath = resolve(import.meta.dir, '../../../packs/gcp-architect-expand/content/decision-table.md');
if (!existsSync(packPath) || !readFileSync(packPath, 'utf8').includes('Cloud Billing Catalog API'))
  throw new Error('official cost decision pack is unavailable');
const inputSha256 = createHash('sha256').update(raw).digest('hex');
const proposal = {
  id: `ticket-demo-${inputSha256.slice(0, 12)}`, inputSha256, ticketDesign: design,
  assumptions: design.assumptions, assumptionStatus: design.assumptions.length ? 'unconfirmed' : 'none',
  signal: pressure.signal, shortageAxes: pressure.shortage,
  signalSource: pressure.source, architecture: 'batch-spot', region: primaryRegion,
  comparisonRegion: 'us-central1',
  regionComparison: '서울 기본안과 us-central1 비교안의 공식 SKU·이그레스·지연·데이터 위치를 각각 확인한 뒤 사용자 승인',
  estimate: {
    period: 'month',
    formula: '월 실행횟수 × (1회 예상 vCPU시간 × 해당 리전 Spot vCPU 공식 SKU 단가 + 1회 예상 GiB시간 × Spot 메모리 공식 SKU 단가) + 월 디스크 + 네트워크 + 로그',
    skuSource: 'https://cloud.google.com/compute/all-pricing', price: 'unpriced', usage: design.usage,
    status: '월 비용 미산정 — 월 실행횟수와 공식 리전 SKU 실조회 필요',
    unresolvedInputs: ['월 실행횟수', '공식 리전 Spot SKU', '디스크·네트워크·로그 사용량'],
  },
  savings: ['재시도 가능한 비식별 집계에만 Spot 검토', '유휴 TTL 종료', '리전·스토리지·이그레스 비교', '예산 경보는 지출 차단 아님'],
  security: { grade: design.dataClass, controls: security[design.dataClass], exportData: design.exportData,
    credentials: 'user-device-only' },
  alternatives: ['로컬 대기열 조절', '일반 VM', 'Cloud Run 0 scale for HTTP only', 'GKE Autopilot for durable Kubernetes need'],
  sourcePack: 'packs/gcp-architect-expand', sourceCheckedAt: '2026-11-10 UTC',
  idleTtlMs: 60_000, realGcpCalls: 0,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(proposal, null, 2) + '\n');
console.log(JSON.stringify({ output: resolve(outputPath), proposalId: proposal.id, sourceKind: design.sourceKind }));
