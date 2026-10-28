/**
 * GATE-ONCE-PER-HEAD (0.2.40 첫 조각 · OP 10-27 23:0x 지시) — host-regate 통과 영수증의 지속 등록부.
 *
 * S: 같은 PR head 의 자식 gate 뒤 host-regate 와 착지 게이트가 같은 시험을 다시 실행해 Pod 와 호스트 자원을 소모한다.
 * C: 통과 사실이 어디에도 남지 않아 매 호출이 전 검사를 다시 돌릴 수밖에 없다.
 * Q: 정확히 같은 통합 입력과 측정 범위에 대해 이미 통과한 게이트만 승계할 수 있는가?
 * A: 통과 영수증을 이 등록부에 원자적으로 기록하고, runHostRegate 가 재검증·통합 후보 구성 뒤 현재 key 와
 *    일치하는 통과 영수증만 승계한다. 불일치·결손·불완전·실패/측정불가 영수증은 원래 검사를 실행한다.
 *
 * 원본 영수증 없이 통과 판정 금지: 승계는 저장된 영수증 행 하나를 통해서만 일어나고, 그 행의 key 는
 * 행 스스로의 필드에서 다시 계산되어야 한다(gateReceiptSelfKey). key 가 필드와 맞지 않는 행은 저장도
 * 승계도 거절한다.
 *
 * 원자성: saveGateReceipts 는 임시 파일에 온전히 쓴 뒤 rename(2) 로 바꾼다 — 부분 쓰기는 관측될 수 없다.
 * 프로세스끼리의 동시 저장은 각자 온전한 등록부를 남긴다(늦은 쪽이 이긴다). 잃은 영수증은 다음 호출을
 * 원래 검사로 되돌릴 뿐, 잘못된 통과를 만들지 않는다 — 실패 방향으로 열린다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gateTestBaseline } from '../../scripts/lib/gate-test-env.js';

export const GATE_RECEIPT_SCHEMA = 1;
export type GateReceiptVerdict = 'passed' | 'failed' | 'unmeasured';

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

/** 한 번의 host-regate 측정을 정체 짓는 입력. 판정(verdict)은 identity 가 아니라 key 계산에 들어간다. */
export interface GateReceiptIdentity {
  /** 40자 PR head SHA */
  headCommit: string;
  /** 40자 실제 측정 base SHA — PR 에 기록된 baseRefOid 가 아니라 얹어 잰 끝 */
  baseCommit: string;
  /** 검사를 실행한 Bun 식별값(bun --version) */
  bunVersion: string;
  /** 검사가 설치·실행한 lockfile 의 SHA-256(bun.lock/bun.lockb 바이트) — 없으면 'absent' */
  lockfileHash: string;
  /** 정규화된 radius 파일 집합(병합 후보 기준 변경 파일 — 중복 제거·정렬) */
  radiusFiles: readonly string[];
  /** 이 영수증이 통과한 검사 토큰(종류 ⊕ 측정 범위 — 중복 제거·정렬) */
  checks: readonly string[];
  /** 실행 환경 지문(gateEnvFingerprint) */
  envFingerprint: string;
}

export interface GateReceipt extends GateReceiptIdentity {
  schema: typeof GATE_RECEIPT_SCHEMA;
  key: string;
  verdict: GateReceiptVerdict;
  savedAt: string;
}

export type GateReceiptRegistry = Record<string, GateReceipt>;

/**
 * 검사 종류·판정·환경까지 포함한 정준 직렬화의 SHA-256. 같은 측정·같은 판정만 같은 key 를 받는다.
 * head/base 는 40자 hex 여야 한다 — 그보다 못한 입력으로 영수증을 만들 수 없게 문을 닫는다.
 */
export function computeReceiptKey(identity: GateReceiptIdentity, verdict: GateReceiptVerdict): string {
  if (!SHA40.test(identity.headCommit)) throw new Error('gate receipt head SHA is not 40 hex characters');
  if (!SHA40.test(identity.baseCommit)) throw new Error('gate receipt base SHA is not 40 hex characters');
  const canonical = JSON.stringify({
    schema: GATE_RECEIPT_SCHEMA,
    head: identity.headCommit.toLowerCase(),
    base: identity.baseCommit.toLowerCase(),
    bun: identity.bunVersion,
    lockfile: identity.lockfileHash,
    radius: [...new Set(identity.radiusFiles)].sort(),
    checks: [...new Set(identity.checks)].sort(),
    env: identity.envFingerprint,
    verdict,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** 행의 key 를 행 스스로의 필드에서 다시 계산한다 — 위조·불일치 행은 저장된 key 와 어긋난다. */
export function gateReceiptSelfKey(receipt: GateReceipt): string {
  return computeReceiptKey(receipt, receipt.verdict);
}

function isGateReceipt(value: unknown): value is GateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<GateReceipt>;
  return row.schema === GATE_RECEIPT_SCHEMA && typeof row.key === 'string' && SHA256.test(row.key)
    && (row.verdict === 'passed' || row.verdict === 'failed' || row.verdict === 'unmeasured')
    && SHA40.test(row.headCommit ?? '') && SHA40.test(row.baseCommit ?? '')
    && typeof row.bunVersion === 'string' && typeof row.lockfileHash === 'string'
    && Array.isArray(row.radiusFiles) && row.radiusFiles.every((file) => typeof file === 'string')
    && Array.isArray(row.checks) && row.checks.every((check) => typeof check === 'string')
    && typeof row.envFingerprint === 'string' && typeof row.savedAt === 'string';
}

/**
 * 결손·손상 파일은 빈 등록부로 복구한다 — 못 읽은 영수증은 «없다» 로 취급해 원래 검사를 실행한다.
 * 모양이 어긋나거나 행의 key 가 맵 키와 다른 행은 버린다.
 */
export function loadGateReceipts(path: string): GateReceiptRegistry {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch { return {}; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const registry: GateReceiptRegistry = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isGateReceipt(value) || value.key !== key) continue;
    registry[key] = value;
  }
  return registry;
}

/** write-then-rename 원자적 기록 — 부분 쓰기 노출 금지. 임시 파일은 같은 디렉터리에 무작위 이름으로 둔다. */
export function saveGateReceipts(path: string, registry: GateReceiptRegistry): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  try { renameSync(tmp, path); }
  catch (error) {
    try { unlinkSync(tmp); } catch { /* 최선의 정리 — 원래 오류를 지운다 */ }
    throw error;
  }
}

/** 통과 영수증을 지속 등록부에 원자적으로 병합 기록한다. key 가 필드와 맞지 않는 행은 쓰기 단계에서 거절한다. */
export function saveGateReceipt(path: string, receipt: GateReceipt): void {
  if (gateReceiptSelfKey(receipt) !== receipt.key) throw new Error('gate receipt key does not match its own fields');
  const registry = loadGateReceipts(path);
  registry[receipt.key] = receipt;
  saveGateReceipts(path, registry);
}

/**
 * 승계 거절 사유. 불일치(head/base/env/Bun·lockfile/radius)·결손·불완전(현재 측정 범위 미커버)·
 * 실패/측정불가 판정을 가려 한 줄로 남긴다 — debug.log 의 decline 이유가 된다.
 */
export function describeGateReceiptDecline(probe: GateReceiptIdentity, registry: GateReceiptRegistry): string {
  const receipts = Object.values(registry);
  if (!receipts.length) return 'gate receipt registry empty';
  const sameHeadBase = receipts.filter((receipt) => receipt.headCommit.toLowerCase() === probe.headCommit.toLowerCase()
    && receipt.baseCommit.toLowerCase() === probe.baseCommit.toLowerCase());
  if (!sameHeadBase.length) return `no receipt for head ${probe.headCommit.slice(0, 12)} base ${probe.baseCommit.slice(0, 12)}`;
  for (const receipt of sameHeadBase) {
    const differs: string[] = [];
    if (receipt.verdict !== 'passed') differs.push(`verdict=${receipt.verdict}`);
    if (receipt.envFingerprint !== probe.envFingerprint) differs.push('env fingerprint differs');
    if (receipt.bunVersion !== probe.bunVersion || receipt.lockfileHash !== probe.lockfileHash) differs.push('bun/lockfile differs');
    if ([...new Set(receipt.radiusFiles)].sort().join('\n') !== [...new Set(probe.radiusFiles)].sort().join('\n')) differs.push('changed-file radius differs');
    const current = [...new Set(probe.checks)].sort();
    const stored = [...new Set(receipt.checks)].sort();
    if (stored.join('\n') !== current.join('\n')) {
      const missing = current.filter((check) => !stored.includes(check));
      differs.push(missing.length && stored.every((check) => current.includes(check))
        ? `receipt does not cover: ${missing.join(',')}`
        : `receipt checks differ (stored ${stored.join(',')})`);
    }
    if (differs.length) return `receipt ${receipt.key.slice(0, 12)} ${differs.join(' · ')}`;
  }
  return 'no stored receipt matches this measurement key';
}

/** 실행 환경 지문: 플랫폼 ⊕ 게이트 시험 baseline(TZ·locale·fake-LLM 스위치)의 정준 직렬화 SHA-256. */
export function gateEnvFingerprint(env: NodeJS.ProcessEnv): string {
  const baseline = gateTestBaseline(env);
  const canonical = JSON.stringify({
    platform: process.platform,
    env: Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b))),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** 후보 워크트리가 실제로 설치·실행한 lockfile 의 SHA-256. 둘 다 없으면 'absent'. */
export function gateLockfileHash(worktree: string): string {
  for (const name of ['bun.lock', 'bun.lockb']) {
    if (!existsSync(join(worktree, name))) continue;
    return createHash('sha256').update(readFileSync(join(worktree, name))).digest('hex');
  }
  return 'absent';
}
