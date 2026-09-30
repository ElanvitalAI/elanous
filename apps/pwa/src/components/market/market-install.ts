type InstallStep = '받는 중' | '서명 확인' | '권한 동의' | '자격 필요' | '등록' | '완료' | '실패';

export interface InstallProgress { step: InstallStep; reason?: string; credentialsRequired?: boolean }

const steps: Record<string, InstallStep> = {
  resolve: '받는 중', verify: '서명 확인', consent: '권한 동의',
  credentials: '자격 필요', registered: '등록', done: '완료', failed: '실패',
};
const reasons: Record<string, string> = {
  signature: '서명을 확인하지 못했습니다.', scan: '플러그인 파일을 확인하지 못했습니다.',
  'consent-denied': '필요한 권한에 동의하지 않았습니다.', credentials: '연결 정보가 필요합니다.',
  conflict: '이미 설치된 플러그인입니다.', io: '설치 중 오류가 발생했습니다.',
};

export function installProgressFromLine(line: string): InstallProgress | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const event = (value as Record<string, unknown>).event;
  if (typeof event !== 'string' || !Object.hasOwn(steps, event)) return null;
  if (event === 'failed') {
    const reason = (value as Record<string, unknown>).reason;
    const detail = (value as Record<string, unknown>).detail;
    const base = typeof reason === 'string' ? reasons[reason] ?? reasons.io : reasons.io;
    return { step: '실패', reason: typeof detail === 'string' && detail.trim() ? `${base} — ${detail.trim()}` : base };
  }
  if (event === 'credentials') return (value as Record<string, unknown>).required === true
    ? { step: '자격 필요', credentialsRequired: true } : null;
  return { step: steps[event]! };
}
