const GATE_LABELS = {
  budget: '예산',
  placement: '장소',
  relation: '관계',
  memory: '기억',
} as const;

type Gate = keyof typeof GATE_LABELS;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;

// Provider identifiers are a closed set; only machine-style pool labels may be shown.
const providerName = (value: unknown): string | null =>
  typeof value === 'string' && /^(openai-codex|grok|anthropic|openai|google|local|openrouter)$/.test(value) ? value : null;
const poolName = (value: unknown): string | null =>
  typeof value === 'string' && /^(?:fast-\d{1,2}|pool-msb\d{1,2}(?:@msb\d{1,2}:\d{1,2})?)$/.test(value) ? value : null;
const memoryLimit = (value: unknown): string | null =>
  typeof value === 'string' && /^\d+(?:\.\d+)?\s*(?:[KMGT]i?B?|bytes?)$/i.test(value) ? value.replace(/\s+/g, ' ') : null;

// Reasons and errors are free-form (and may include account IDs even in Korean).
// Only these complete, known diagnostic phrases can be quoted on a card.
const SAFE_DETAILS = new Set(['한도 도달', '후보 없음', '측정 불가: 시간 초과']);
function safeDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return SAFE_DETAILS.has(text) ? text.slice(0, 80) : null;
}

function unavailable(explanation: unknown): string {
  const detail = safeDetail(explanation);
  return `확인 못 함${detail ? ` · ${detail}` : ''}`;
}

/** Since #22024 the launcher logs a short `key=value · key=value` summary instead of the JSON result
 * (`src/execution-loop/gate-decision-summary.ts`). Rebuild the same decision shape from it. */
function summaryResult(gate: Gate, raw: string): ObjectValue | null {
  if (!raw || raw.startsWith('{')) return null;
  if (raw.startsWith('unavailable')) return { decision: 'unavailable' };
  const fields = new Map<string, string>();
  for (const part of raw.split(' · ')) {
    const eq = part.indexOf('=');
    if (eq > 0 && !fields.has(part.slice(0, eq))) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  if (!fields.size) return null;
  switch (gate) {
    case 'budget': {
      if (!fields.has('action')) return null;
      return { decision: { action: fields.get('action'), ...(fields.get('provider') ? { provider: fields.get('provider') } : {}), reasons: fields.get('reason') ? [fields.get('reason')] : [] } };
    }
    case 'placement': {
      if (!fields.has('substrate')) return null;
      const pool = fields.get('pool');
      return { decision: { substrate: fields.get('substrate'), pool: !pool || pool === 'none' ? null : pool, ...(fields.get('memory') ? { memory: { limit: fields.get('memory') } } : {}) } };
    }
    case 'relation': {
      const overlap = Number(fields.get('overlap'));
      if (!Number.isInteger(overlap) || overlap < 0) return null;
      return { decision: { action: 'record', overlappingCards: Array.from({ length: overlap }, (_, i) => `card-${i + 1}`) } };
    }
    case 'memory': {
      const context = fields.get('context');
      if (context !== 'recalled' && context !== 'none') return null;
      return { decision: { action: 'record', context: context === 'recalled' ? 'recalled' : null } };
    }
  }
}

/** The log store cuts long strings (≈250 chars, `«+Nc»`), so most gate reasons arrive as broken JSON.
 * Recover only the known leading fields from the raw prefix; anything not found stays absent. */
function truncatedResult(raw: string): ObjectValue | null {
  if (!raw.startsWith('{"decision":{')) return null;
  const decision: ObjectValue = {};
  const str = (key: string) => new RegExp(`"${key}":"([^"\\\\]*)"`).exec(raw)?.[1];
  const action = str('action'); if (action) decision.action = action;
  const provider = str('provider'); if (provider) decision.provider = provider;
  const substrate = str('substrate'); if (substrate) decision.substrate = substrate;
  const pool = /"pool":(null|"([^"\\]*)")/.exec(raw); if (pool) decision.pool = pool[1] === 'null' ? null : pool[2];
  const limit = /"memory":\{[^}]*"limit":"([^"\\]*)"/.exec(raw); if (limit) decision.memory = { limit: limit[1] };
  const cards = /"overlappingCards":\[([^\]]*)\]/.exec(raw);
  if (cards) decision.overlappingCards = cards[1]!.trim() ? cards[1]!.split(',').map((id) => id.trim().replace(/^"|"$/g, '')) : [];
  const context = /"context":(null|")/.exec(raw); if (context) decision.context = context[1] === 'null' ? null : 'recalled';
  if (/"reasons":\[/.test(raw)) {
    const reasons = /"reasons":\[((?:"[^"\\]*",?)*)\]/.exec(raw);
    decision.reasons = reasons ? [...reasons[1]!.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]) : [];
  }
  return Object.keys(decision).length ? { decision } : null;
}

/** Turn the four observed launch gates into short, safe Live-card copy. Other decisions are untouched. */
export function gateDecisionText(what: string, reason: string | undefined): { what: string; why: string } | null {
  const match = /^execution-loop (budget|placement|relation|memory) gate$/.exec(what);
  if (!match) return null;
  const gate = match[1] as Gate;
  const heading = `관문 · ${GATE_LABELS[gate]}`;
  let result: ObjectValue | null = null;
  try { result = object(JSON.parse(reason ?? '')); } catch { result = summaryResult(gate, reason ?? '') ?? truncatedResult(reason ?? ''); }
  const decision = object(result?.decision);
  const explanation = result?.explanation;
  if (!decision) return { what: heading, why: unavailable(explanation) };

  let why: string;
  switch (gate) {
    case 'budget': {
      const action = decision.action;
      const nextProvider = providerName(decision.provider);
      const label = action === 'proceed' ? '그대로 진행'
        : action === 'next-provider' ? `다른 제공자로${nextProvider ? `(${nextProvider})` : ''}`
        : action === 'wait-reset' ? '한도 회복까지 대기'
        : action === 'stop' ? '멈춤' : null;
      if (!label || !Array.isArray(decision.reasons)) return { what: heading, why: unavailable(explanation) };
      const firstReason = safeDetail(decision.reasons[0]);
      why = `${label}${firstReason ? ` · ${firstReason}` : ''}`;
      break;
    }
    case 'placement': {
      const substrate = decision.substrate;
      if (substrate !== 'pod' && substrate !== 'local' && substrate !== 'unknown') return { what: heading, why: unavailable(explanation) };
      const pool = poolName(decision.pool);
      const place = substrate === 'pod' ? `Pod${pool ? ` ${pool}` : ''}`
        : substrate === 'local' ? '이 기기' : '모름';
      const limit = memoryLimit(object(decision.memory)?.limit);
      why = `${place}${limit ? ` · 메모리 한도 ${limit}` : ''}`;
      break;
    }
    case 'relation': {
      if (decision.action !== 'record' || !Array.isArray(decision.overlappingCards) || !decision.overlappingCards.every((id) => typeof id === 'string')) return { what: heading, why: unavailable(explanation) };
      why = decision.overlappingCards.length ? `겹치는 카드 ${decision.overlappingCards.length}개` : '겹치는 일 없음';
      break;
    }
    case 'memory': {
      if (decision.action !== 'record' || (typeof decision.context !== 'string' && decision.context !== null)) return { what: heading, why: unavailable(explanation) };
      why = decision.context ? '지난 기록 있음' : '지난 기록 없음';
      break;
    }
  }
  return { what: heading, why };
}
