import { contextNow, type ContextFact, type ContextNowAnswer, type ContextNowDeps } from './context-now.js';

export function readSlashContextNow(args: string[], deps?: ContextNowDeps): ContextNowAnswer {
  return contextNow({ topic: args.join(' ').trim() }, deps);
}

export function seatsNowLine(answer: ContextNowAnswer, now: number): string | null {
  const seats = [ ['OP', 'COO'], ['MK', 'CMO'], ['TC', 'CTO'], ['UX', 'CXO'] ] as const;
  const facts = answer.facts.filter(fact => fact.kind === 'seat');
  const lines = seats.flatMap(([seat, label]) => {
    const latest = facts.filter(fact => fact.seat === seat)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!latest) return [];
    const minutes = Math.max(0, Math.floor((now - Date.parse(latest.at)) / 60_000));
    const age = minutes >= 24 * 60 ? '하루 넘음'
      : minutes >= 60 ? `${Math.floor(minutes / 60)}시간 전`
      : minutes > 0 ? `${minutes}분 전` : '방금';
    const title = latest.title?.split(/\r?\n/, 1)[0]?.trim();
    return [`${label} ${title ? title.slice(0, 20) : latest.status} · ${age}`];
  });
  return lines.length ? `지금 자리들: ${lines.join(' | ')}` : null;
}

function factText(fact: ContextFact): string {
  switch (fact.kind) {
    case 'version': return fact.version;
    case 'cell': return `${fact.id} ${fact.title} (${fact.status})`;
    case 'decision': return `${fact.id} ${fact.title} (${fact.status})`;
    case 'seat': return `${fact.seat} ${fact.id ?? ''} ${fact.title ?? ''} (${fact.status})`.trim();
  }
}

export function renderTelegramNow(answer: ContextNowAnswer): string {
  const rows = [
    ['판', answer.facts.filter(f => f.kind === 'version')],
    ['칸', answer.facts.filter(f => f.kind === 'cell')],
    ['결정', answer.facts.filter(f => f.kind === 'decision')],
    ['자리', answer.facts.filter(f => f.kind === 'seat')],
  ] as const;
  const lines = rows.map(([label, facts]) => `${label}: ${facts.length ? facts.map(f => `${factText(f)} — ${f.source}`).join(' · ') : '없음'}`);
  lines.push(`최근: ${answer.events.length ? answer.events.map(e => `${e.summary} — ${e.source}`).join(' · ') : '없음'}${answer.guide.length ? ` · 안내 ${answer.guide.join(' · ')}` : ''}`);
  return lines.map(line => line.replace(/\s+/g, ' ').trim()).join('\n');
}

export function renderTuiNow(answer: ContextNowAnswer): string[] {
  const shortText = (text: string) => {
    const characters = Array.from(text);
    return characters.length > 100 ? `${characters.slice(0, 100).join('')}…` : text;
  };
  const shortSource = (source: string) => {
    if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+#issuecomment-/.test(source)) return '채널';
    if (source.startsWith('elanous://release/')) return '원장';
    return Array.from(source).slice(0, 40).join('');
  };
  const factLabels = { version: '판', cell: '칸', decision: '결정', seat: '자리' } as const;
  const eventLabels: Record<string, string> = { report: '보고', dispatch: '발사', decision: '결정' };
  const events = answer.events.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const rows = [
    ...answer.facts.map(f => [factLabels[f.kind], shortText(factText(f)), shortSource(f.source)]),
    ...events.slice(0, 8).map(e => [eventLabels[e.kind] ?? '소식', shortText(e.summary), shortSource(e.source)]),
    ...answer.guide.map(guide => ['안내', guide, '']),
    ...(events.length > 8 ? [['안내', `… 사건 ${events.length - 8}개 더(/now <주제> 로 좁히기)`, '']] : []),
  ];
  return [
    `지금${answer.topic ? ` · ${answer.topic}` : ''} (${answer.at})`,
    '| 종류 | 사실 | 출처 |',
    '| --- | --- | --- |',
    ...rows.map(row => `| ${row.map(cell => cell.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ')).join(' | ')} |`),
  ];
}

export function telegramNowSlash(args: string[], deps?: ContextNowDeps): string {
  return renderTelegramNow(readSlashContextNow(args, deps));
}

export function tuiNowSlash(args: string[], deps?: ContextNowDeps): string[] {
  return renderTuiNow(readSlashContextNow(args, deps));
}
