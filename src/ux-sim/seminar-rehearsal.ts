/**
 * Simulate the 40-minute, seven-scene seminar rehearsal protocol.
 *
 * This checks timing, evidence completeness, fallback, and disclosure guards
 * with injected records. It never claims that a real rehearsal or device run
 * took place.
 */
// Targets mirror RUNBOOK-1027-seminar-smart-wizard-demo-2026-10-24.md; the test
// parses that table so edits to the runbook cannot silently drift from this rig.
export const SEMINAR_SCENES = [
  { id: 1, name: 'hook', targetMinutes: 3 },
  { id: 2, name: 'problem', targetMinutes: 5 },
  { id: 3, name: 'AI executive', targetMinutes: 8 },
  { id: 4, name: 'development demo', targetMinutes: 8 },
  { id: 5, name: 'two phones', targetMinutes: 8 },
  { id: 6, name: 'transit demo', targetMinutes: 4 },
  { id: 7, name: 'close', targetMinutes: 4 },
] as const;

export type SeminarSceneId = (typeof SEMINAR_SCENES)[number]['id'];
export type SeminarOutcome = 'pass' | 'fail' | 'unknown';

export interface SeminarSceneRecord {
  readonly scene: SeminarSceneId;
  readonly elapsedMinutes: number | null;
  readonly medium: string | null;
  readonly evidenceId: string | null;
  readonly outcome: SeminarOutcome;
  readonly publicSafe: boolean | null;
  readonly fallbackUsed: boolean | null;
  readonly offlineFallbackPlayed: boolean | null;
}

export interface SeminarRehearsalResult {
  readonly simulated: true;
  readonly totalTargetMinutes: number;
  readonly scenes: ReadonlyArray<{
    scene: SeminarSceneId;
    name: string;
    targetMinutes: number;
    observedMinutes: number | null;
    verdict: 'pass' | 'fail' | 'unknown';
    reason: string;
  }>;
  readonly verdict: 'pass' | 'fail' | 'unknown';
}

export function simSeminarRehearsal(records: readonly SeminarSceneRecord[]): SeminarRehearsalResult {
  const byScene = new Map<SeminarSceneId, SeminarSceneRecord>();
  for (const record of records) {
    if (!SEMINAR_SCENES.some((scene) => scene.id === record.scene)) throw new Error(`unknown scene record: ${String(record.scene)}`);
    if (byScene.has(record.scene)) throw new Error(`duplicate scene record: ${record.scene}`);
    byScene.set(record.scene, record);
  }

  const scenes = SEMINAR_SCENES.map((scene) => {
    const record = byScene.get(scene.id);
    if (!record || record.elapsedMinutes === null || !record.medium || !record.evidenceId || record.outcome === 'unknown' || record.publicSafe === null || record.fallbackUsed === null || (record.fallbackUsed && record.offlineFallbackPlayed === null)) {
      return { scene: scene.id, name: scene.name, targetMinutes: scene.targetMinutes, observedMinutes: record?.elapsedMinutes ?? null, verdict: 'unknown' as const, reason: '실행 기록의 시간·매체·증거·결과·공개 안전 중 미확인 값이 있음' };
    }
    if (record.outcome === 'fail') {
      return { scene: scene.id, name: scene.name, targetMinutes: scene.targetMinutes, observedMinutes: record.elapsedMinutes, verdict: 'fail' as const, reason: '주입된 장면 결과가 fail' };
    }
    if (Math.abs(record.elapsedMinutes - scene.targetMinutes) > 1) {
      return { scene: scene.id, name: scene.name, targetMinutes: scene.targetMinutes, observedMinutes: record.elapsedMinutes, verdict: 'fail' as const, reason: `목표 ${scene.targetMinutes}분에서 ±1분 초과` };
    }
    if (!record.publicSafe) {
      return { scene: scene.id, name: scene.name, targetMinutes: scene.targetMinutes, observedMinutes: record.elapsedMinutes, verdict: 'fail' as const, reason: '공개 안전 확인 실패' };
    }
    if (record.fallbackUsed && !record.offlineFallbackPlayed) {
      return { scene: scene.id, name: scene.name, targetMinutes: scene.targetMinutes, observedMinutes: record.elapsedMinutes, verdict: 'fail' as const, reason: '대체 경로를 선택했으나 오프라인 매체 재생을 확인하지 못함' };
    }
    return { scene: scene.id, name: scene.name, targetMinutes: scene.targetMinutes, observedMinutes: record.elapsedMinutes, verdict: 'pass' as const, reason: record.fallbackUsed ? '오프라인 대체 매체 재생 확인' : '주입된 시나리오 통과' };
  });

  const verdict = scenes.some((scene) => scene.verdict === 'unknown')
    ? 'unknown'
    : scenes.some((scene) => scene.verdict === 'fail')
      ? 'fail'
      : 'pass';

  return {
    simulated: true,
    totalTargetMinutes: SEMINAR_SCENES.reduce((sum, scene) => sum + scene.targetMinutes, 0),
    scenes,
    verdict,
  };
}

export function seminarRehearsalSweep(): SeminarRehearsalResult {
  const records: SeminarSceneRecord[] = SEMINAR_SCENES.map((scene) => ({
    scene: scene.id,
    elapsedMinutes: scene.targetMinutes,
    medium: scene.id === 5 ? 'simulated iPhone + Fold8' : scene.id === 4 ? 'simulated offline video' : 'simulated stage screen',
    evidenceId: `sim-scene-${scene.id}`,
    outcome: 'pass',
    publicSafe: true,
    fallbackUsed: scene.id === 5,
    offlineFallbackPlayed: scene.id === 5 ? true : null,
  }));
  return simSeminarRehearsal(records);
}

export function renderSeminarRehearsal(result: SeminarRehearsalResult): string[] {
  return [
    `세미나 리허설 · ${result.totalTargetMinutes}분 · ${result.verdict} · sim only (실제 행사 실행 증거 아님)`,
    ...result.scenes.map((scene) => `  S${scene.scene} ${scene.name.padEnd(18)} ${scene.observedMinutes === null ? '미확인' : `${scene.observedMinutes}분`.padEnd(5)} / 목표 ${scene.targetMinutes}분 · ${scene.verdict} · ${scene.reason}`),
  ];
}
