import { DEFAULT_MODEL_TIER, isModelTier, type ModelTier } from '../model-tier/types.js';

export interface DoctorMode {
  id: 'model-tier' | 'auto-route' | 'fast-mode';
  value: ModelTier | boolean | 'none';
  source: 'config' | 'default' | 'none';
  usedByChat: boolean;
  note: string;
}

/** Report configured switches without changing them or implying they affect chat turns. */
export function describeModes(cfg: { modelTier?: { llm?: unknown }; llm?: { autoRoute?: { enabled?: unknown } } }): DoctorMode[] {
  const tier = cfg.modelTier?.llm;
  const autoRoute = cfg.llm?.autoRoute?.enabled;
  return [
    {
      id: 'model-tier',
      value: isModelTier(tier) ? tier : DEFAULT_MODEL_TIER,
      source: isModelTier(tier) ? 'config' : 'default',
      usedByChat: false,
      note: '대화 턴 모델 선택에 쓰이지 않는다(표시·전환 계획만)',
    },
    {
      id: 'auto-route',
      value: typeof autoRoute === 'boolean' ? autoRoute : false,
      source: typeof autoRoute === 'boolean' ? 'config' : 'default',
      usedByChat: false,
      note: '오토파일럿 턴만 읽는다 · 켜기 = elanous config set llm.autoRoute.enabled true',
    },
    {
      id: 'fast-mode',
      value: 'none',
      source: 'none',
      usedByChat: false,
      note: '스위치 없음(분류기 호출부 0)',
    },
  ];
}

export function formatModeLine(row: DoctorMode): string {
  const label = {
    'model-tier': 'smart·등급',
    'auto-route': 'smart·자동 라우팅',
    'fast-mode': '빠른 모드',
  }[row.id];
  const source = { config: '설정', default: '기본', none: '없음' }[row.source];
  return `${label}: ${String(row.value)}(${source}) · 대화에 ${row.usedByChat ? '쓰임' : '안 쓰임'} — ${row.note}`;
}
