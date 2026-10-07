import { isIrreversible, renderCardText } from '../../decisions/decision-cards.js';
import { DecisionLedger, type DecisionEntry } from '../../decisions/decision-ledger.js';

function ageOf(entry: DecisionEntry, now: Date): string {
  const raised = Date.parse(entry.raisedAt ?? entry.importedAt ?? '');
  if (!Number.isFinite(raised)) return '나이 미상';
  const minutes = Math.max(0, Math.floor((now.getTime() - raised) / 60_000));
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / 1440)}일 전`;
}

/** One handler per dashboard registry: number-to-id mapping refreshes on list open or a successful answer. */
export function createDecideSlashHandler(ledger: DecisionLedger = new DecisionLedger(), now: () => Date = () => new Date()) {
  let snapshot: DecisionEntry[] | undefined;
  let pendingConfirm: { id: string; key: string } | undefined;
  const openList = (): string => {
    pendingConfirm = undefined;
    snapshot = ledger.list({ status: 'open' });
    if (!snapshot.length) return '열린 결정 없음';
    return [...snapshot.map((entry, index) =>
      `${index + 1}. ${entry.title} [${entry.options.map((option) => option.key).join('/')}] · ${entry.raisedBy.track ?? entry.raisedBy.agent} · ${ageOf(entry, now())}`),
      '답하기: /decide <번호> <선택지 키>'].join('\n');
  };
  return (args: readonly string[]): string => {
    if (!args.length) return openList();

    const numbers = snapshot?.length ? `1~${snapshot.length}` : '없음 (/decide 로 목록 열기)';
    const invalidNumber = `쓸 수 있는 번호: ${numbers}`;
    const index = /^(?:[1-9]\d*)$/.test(args[0] ?? '') ? Number(args[0]) - 1 : -1;
    const selected = snapshot?.[index];
    if (!selected || !Number.isSafeInteger(index)) return invalidNumber;
    const entry = ledger.list({ status: 'open' }).find((card) => card.id === selected.id);
    if (!entry) return `이미 닫힌 결정입니다 (${args[0]}) — /decide 로 목록을 다시 여세요`;
    if (args.length === 1) {
      pendingConfirm = undefined;
      return renderCardText(entry);
    }

    const key = args[1];
    const option = entry.options.find((item) => item.key === key);
    const keys = entry.options.length ? entry.options.map((item) => item.key).join(', ') : '없음';
    if (!option || args.length > 3 || (args.length === 3 && args[2] !== '확인')) return `쓸 수 있는 선택지 키: ${keys}`;
    if (isIrreversible(entry)) {
      if (args[2] !== '확인' || pendingConfirm?.id !== entry.id || pendingConfirm.key !== key) {
        pendingConfirm = { id: entry.id, key: option.key };
        return `${renderCardText(entry, { confirm: option.key })}\n/decide ${args[0]} ${option.key} 확인`;
      }
      pendingConfirm = undefined;
    }
    let acknowledgement: string;
    try {
      const { delivery } = ledger.decideWithDelivery(entry.id, option.key, { kind: 'human' });
      acknowledgement = `✓ ${entry.title} → ${option.label}${delivery && !delivery.ok ? ` · 런 답 전달 실패: decisions retry-answer ${entry.id}` : ''}`;
    } catch {
      return `결정을 기록하지 못했습니다 (${args[0]}) — /decide 로 목록을 다시 여세요`;
    }
    return `${acknowledgement}\n${openList()}`;
  };
}
