import { debug } from '../debug/log.js';
import {
  appendRunLedgerEntry,
  listRunLedgers,
  loadRunLedger,
  lookupRunLedger,
  type RunLedgerLookupOptions,
} from './run-ledger.js';

/** DOCTOR-VISIT 증상 닫힌 목록 — 이 밖의 값은 기록·조회 모두 거부한다. */
export const DOCTOR_SYMPTOMS = [
  'admit-starved',
  'image-loop',
  'no-progress',
  'child-dead-no-result',
  'stale-install',
  'oom',
  'slow-tool',
  'host-overload',
  'not-grounded',
  'scope-drift',
  'review-loop',
  'knowledge-gap',
  'too-big',
] as const;

export type DoctorSymptom = (typeof DOCTOR_SYMPTOMS)[number];

/** 진료 요청을 보낸 쪽 닫힌 목록. */
export const DOCTOR_VISIT_SOURCES = ['supervisor', 'parent', 'child', 'judge', 'seat'] as const;

export type DoctorVisitSource = (typeof DOCTOR_VISIT_SOURCES)[number];

const DOCTOR_SYMPTOM_SET: ReadonlySet<string> = new Set(DOCTOR_SYMPTOMS);
const DOCTOR_VISIT_SOURCE_SET: ReadonlySet<string> = new Set(DOCTOR_VISIT_SOURCES);

export function isDoctorSymptom(value: string): value is DoctorSymptom {
  return DOCTOR_SYMPTOM_SET.has(value);
}

export function isDoctorVisitSource(value: string): value is DoctorVisitSource {
  return DOCTOR_VISIT_SOURCE_SET.has(value);
}

export interface RecordDoctorVisitInput {
  runId: string;
  from: string;
  symptom: string;
  evidence?: string;
  /** 원장 디렉터리(시험 seam) — 기본 = `runLedgerDir()`. */
  dir?: string;
}

export interface DoctorVisit {
  runId: string;
  from: DoctorVisitSource;
  symptom: DoctorSymptom;
  evidence?: string;
  timestamp?: string;
}

/**
 * 런 원장에 진료 요청 한 줄(`event: 'doctor-visit'`)을 남긴다.
 * 원장이 없는 runId 는 «없음»으로 거부한다 — 조용히 새 원장을 만들지 않는다.
 */
export function recordDoctorVisit(visit: RecordDoctorVisitInput): DoctorVisit {
  if (!isDoctorSymptom(visit.symptom)) {
    throw new Error(`unknown symptom: ${visit.symptom} — closed list: ${DOCTOR_SYMPTOMS.join(', ')}`);
  }
  if (!isDoctorVisitSource(visit.from)) {
    throw new Error(`unknown from: ${visit.from} — closed list: ${DOCTOR_VISIT_SOURCES.join(', ')}`);
  }
  if (loadRunLedger(visit.runId, visit.dir) === null) {
    throw new Error(`없음: 런 원장이 없습니다 (runId=${visit.runId}) — 새 원장을 만들지 않습니다`);
  }
  const timestamp = new Date().toISOString();
  const data: Record<string, unknown> = { from: visit.from, symptom: visit.symptom };
  if (typeof visit.evidence === 'string' && visit.evidence.length > 0) data.evidence = visit.evidence;
  appendRunLedgerEntry({ timestamp, runId: visit.runId, event: 'doctor-visit', data }, visit.dir);
  debug.log('run-doctor', 'visit', { runId: visit.runId, from: visit.from, symptom: visit.symptom });
  return {
    runId: visit.runId,
    from: visit.from,
    symptom: visit.symptom,
    ...(typeof visit.evidence === 'string' && visit.evidence.length > 0 ? { evidence: visit.evidence } : {}),
    timestamp,
  };
}

export type ReadDoctorVisitsOptions = RunLedgerLookupOptions;

/** `runId` 원장이 조회 범위 안에 있는가 — `doctor status --run` 이 없는 런을 «0건»으로 삼키지 않게 한다. */
export function doctorVisitRunExists(runId: string, options: ReadDoctorVisitsOptions = {}): boolean {
  return lookupRunLedger(runId, options).matches.length > 0;
}

/** 원장의 `doctor-visit` 사건을 읽는다. `runId` 를 주면 그 런만, 없으면 전체 원장을 훑는다. */
export function readDoctorVisits(runId?: string, options: ReadDoctorVisitsOptions = {}): DoctorVisit[] {
  const matches = runId === undefined ? listRunLedgers(options).matches : lookupRunLedger(runId, options).matches;
  const visits: DoctorVisit[] = [];
  for (const match of matches) {
    for (const entry of match.entries) {
      if (entry.event !== 'doctor-visit') continue;
      const from = typeof entry.data.from === 'string' && isDoctorVisitSource(entry.data.from) ? entry.data.from : null;
      const symptom = typeof entry.data.symptom === 'string' && isDoctorSymptom(entry.data.symptom) ? entry.data.symptom : null;
      if (from === null || symptom === null) continue;
      visits.push({
        runId: entry.runId,
        from,
        symptom,
        ...(typeof entry.data.evidence === 'string' && entry.data.evidence.length > 0 ? { evidence: entry.data.evidence } : {}),
        ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
      });
    }
  }
  return visits.sort((left, right) =>
    (left.timestamp ?? '').localeCompare(right.timestamp ?? '') || left.runId.localeCompare(right.runId));
}
