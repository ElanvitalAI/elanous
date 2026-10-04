export type SceneObservation = {
  scene: number;
  title: string;
  hiddenByDemo: boolean;
  secs: number;
  frames: number;
  exceptions: string[];
  failedRequests: string[];
  textLength: number;
  leaks: string[];
  sectionsInDom: number;
  visibleScene: number | null;
  /** Empty-state phrases observed in the visible scene. */
  emptyStates?: string[];
  /** Number of captured JPEG frames with no discernible scene content. */
  blankFrames?: number;
};

export type SceneState = Pick<SceneObservation, 'textLength' | 'sectionsInDom' | 'visibleScene'>;

/** A recovered frame must not erase a blank or mismatched frame from the recording. */
export function worstSceneState(scene: number, states: SceneState[]): SceneState {
  return {
    textLength: states.length ? Math.min(...states.map((state) => state.textLength)) : 0,
    sectionsInDom: states.length ? Math.min(...states.map((state) => state.sectionsInDom)) : 0,
    visibleScene: states.length && states.every((state) => state.visibleScene === scene) ? scene : null,
  };
}

/** Keep the API path (so a broken scene says *which* call failed) and status, never the query string;
 *  id-like segments (uuid · long hex · digits · run-…) collapse to `:id`. */
export function failedApiResponse(url: string, status: number): string | null {
  try {
    const path = new URL(url).pathname;
    if (!(status >= 400 && status <= 599 && /(?:^|\/)v1\//.test(path))) return null;
    const shape = path.split('/').map((part) => (/^(?:run-)?[0-9a-f]{8,}(?:-[0-9a-f]{4,})*$/i.test(part) || /^\d+$/.test(part) ? ':id' : part)).join('/');
    return `${shape} ${status}`;
  } catch { return null; }
}

export type SceneResult = SceneObservation & { verdict: 'ok' | 'broken' | 'unverified' | 'no-data'; reasons: string[] };

/** A scene the demo hides is not a pass — it was not seen. OP 10-03: ⑤ (wizard → market) is the 10-08 highlight. */
export const UNVERIFIED_REASON = '시연 모드에서 숨긴 장면 — WIZ1 착지 뒤 실물 필요';
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

export function judgeScene(obs: SceneObservation): SceneResult {
  if (obs.hiddenByDemo) return { ...obs, verdict: 'unverified', reasons: [UNVERIFIED_REASON] };
  const reasons: string[] = [];
  if (obs.exceptions.length) reasons.push(`실행 예외 ${obs.exceptions.length}건`);
  const failed = obs.failedRequests.filter((request) => {
    try {
      const path = new URL(request, 'http://localhost').pathname;
      return /(?:^|\/)v1\//.test(path) && !path.includes('/_next/static/') && !path.includes('favicon');
    } catch { return false; }
  });
  if (failed.length) reasons.push(`API 요청 실패 ${failed.length}건`);
  if (obs.textLength < 40) reasons.push(`빈 화면 (글자 ${obs.textLength}자)`);
  if (obs.blankFrames) reasons.push(`녹화 프레임 빈 화면 ${obs.blankFrames}장`);
  if (obs.sectionsInDom < 6) reasons.push(`장면 언마운트 (${obs.sectionsInDom}/6)`);
  if (obs.visibleScene !== obs.scene) reasons.push(`보이는 장면 불일치 (기대 ${obs.scene}, 실제 ${obs.visibleScene ?? '없음'})`);
  if (obs.leaks.length) reasons.push(`공개 화면 누설 ${obs.leaks.length}건`);
  if (reasons.length) return { ...obs, verdict: 'broken', reasons };
  if (obs.emptyStates?.length) return { ...obs, verdict: 'no-data', reasons: obs.emptyStates.map((phrase) => `실데이터 없음 — ${phrase}`) };
  return { ...obs, verdict: 'ok', reasons };
}

export function judgeRun(scenes: SceneResult[]) {
  const ok = scenes.filter((scene) => scene.verdict === 'ok').length;
  const broken = scenes.filter((scene) => scene.verdict === 'broken').length;
  const unverified = scenes.filter((scene) => scene.verdict === 'unverified').length;
  const noData = scenes.filter((scene) => scene.verdict === 'no-data').length;
  // Broken wins, then unseen scenes, then scenes without real data; none is a pass.
  const verdict = broken ? 'broken' as const : unverified ? 'unverified' as const : noData ? 'no-data' as const : 'ok' as const;
  const banner = scenes.filter((scene) => scene.verdict === 'unverified')
    .map((scene) => `${CIRCLED[scene.scene - 1] ?? scene.scene} 미검증 — WIZ1 착지 뒤 실물 필요`);
  const noDataScenes = scenes.filter((scene) => scene.verdict === 'no-data').map((scene) => CIRCLED[scene.scene - 1] ?? String(scene.scene));
  if (noDataScenes.length) banner.push(`${noDataScenes.join('')} 실데이터 없음 — 런·PTY·마법사가 도는 판에서 다시`);
  return { verdict, ok, broken, unverified, noData, banner, scenes };
}
