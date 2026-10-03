import { decisionKind, type DecisionKind } from './live-signals';
import type { GraphNode } from './live-graph';
import { seatLineIsPublicSafe } from './seat-public';

/** 런 번호는 호출자가 고정된 런 목록에서 정한 순서다. 식별자는 화면에 싣지 않는다. */
export function publicRunLabel(runId: string, order: number): string {
  void runId;
  return order >= 0 ? `런 ${order + 1}` : '미등록 런';
}

export function publicUniverseLabel(name: string): string {
  void name;
  return '본부';
}

/** 공개 별칭은 원문 대신 계정별 고유 번호를 기억한다. */
const accountAliases = new Map<string, string>();
export function publicAccountLabel(name: string): string {
  const existing = accountAliases.get(name);
  if (existing) return existing;
  let ordinal = accountAliases.size + 1;
  let letters = '';
  while (ordinal > 0) {
    ordinal -= 1;
    letters = String.fromCharCode(65 + ordinal % 26) + letters;
    ordinal = Math.floor(ordinal / 26);
  }
  const alias = `계정 ${letters}`;
  accountAliases.set(name, alias);
  return alias;
}

/** 무대에서 알려진 호출 자리는 역할만 보이고, 나머지는 안정된 순번으로 가린다. */
const siteAliases = new Map<string, string>();
export function publicSiteLabel(site: string): string {
  const name = site.toLowerCase();
  if (name === 'stream-llm' || name.startsWith('stream-llm-')) return '대화';
  if (name === 'agent-turn' || name.startsWith('agent-turn-')) return '자리 턴';
  if (name === 'pod-rollup' || name.startsWith('pod-')) return '파드 작업';
  if (name.startsWith('stream-')) return '대화 작업';
  if (name.startsWith('agent-')) return '자리 작업';
  let alias = siteAliases.get(site);
  if (!alias) {
    alias = `작업 ${siteAliases.size + 1}`;
    siteAliases.set(site, alias);
  }
  return alias;
}

/** 모델은 버전이나 코드명 없이 가족 이름만 발표한다. */
const modelAliases = new Map<string, string>();
export function publicModelLabel(model: string): string {
  if (/^(?:chatgpt|gpt)(?:[-_.\s]|\d|$)/i.test(model)) return 'GPT';
  if (/^claude(?:[-_.\s]|\d|$)/i.test(model)) return 'Claude';
  if (/^grok(?:[-_.\s]|\d|$)/i.test(model)) return 'Grok';
  let alias = modelAliases.get(model);
  if (!alias) {
    alias = `모델 ${modelAliases.size + 1}`;
    modelAliases.set(model, alias);
  }
  return alias;
}

const KIND_LABEL: Record<DecisionKind, string> = {
  ROUTE: '경로 정하기', PLAN: '계획', HEAL: '스스로 수리', SHIP: '착지',
  VERIFY: '검증', ESCALATE: '사람에게 묻기',
};

export function publicKindLabel(kind: DecisionKind): string {
  return KIND_LABEL[kind];
}

/** 원 카테고리·이벤트가 아니라 결정의 종류만 발표한다. 미분류 신호는 일반명으로 접는다. */
export function publicEventLabel(category: string, event: string): string {
  const kind = decisionKind({ category, event });
  const label = kind ? publicKindLabel(kind) : '신호';
  return seatLineIsPublicSafe(label) ? label : '신호';
}

/** 무대의 캔버스 라벨도 노드 종류로만 결정한다. id 는 클릭 연결에만 남는다. */
export function publicNodeLabel(node: Pick<GraphNode, 'id' | 'kind' | 'label'>, runIds: readonly string[]): string {
  switch (node.kind) {
    case 'run': return publicRunLabel(node.id.slice(4), runIds.indexOf(node.id.slice(4)));
    case 'universe': return publicUniverseLabel(node.label);
    case 'account': return publicAccountLabel(node.id.slice(5));
    case 'pod': return publicAccountLabel(node.id.slice(4));
    case 'model': return node.label;
    case 'phase': return node.label;
    case 'pr': return 'PR';
    case 'harness': return 'ELANOUS HARNESS';
    default: return '경로';
  }
}

/** 판단 한 줄 전체를 동일한 안전 자로 확인한다. 자유 문면은 공개 모드로 보내지 않는다. */
export function publicDecisionText(kind: DecisionKind): string {
  const label = publicKindLabel(kind);
  return seatLineIsPublicSafe(label) ? label : '신호';
}
