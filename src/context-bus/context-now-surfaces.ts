import { contextNow, type ContextFact, type ContextNowAnswer, type ContextNowDeps } from './context-now.js';
import { filterPublicDemoContext } from './context-now-public.js';

export type ContextNowAudience = 'operator' | 'user' | 'public-demo';
const publicSeatNames: Record<string, string> = { OP: '운영', MK: '마케팅', TC: '기술', UX: '사용자 경험' };
const seatOrder = ['OP', 'MK', 'TC', 'UX'] as const;
const forAudience = (answer: ContextNowAnswer, audience: ContextNowAudience): ContextNowAnswer =>
  audience === 'public-demo' ? filterPublicDemoContext(answer) : answer;

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
    case 'run': return fact.unreadable ? `못 읽음 · ${fact.unreadable}` : `${fact.goal} · ${fact.phase} · ${fact.elapsed}`;
    case 'release': return fact.unreadable ? `못 읽음 · ${fact.unreadable}` : `${fact.version} · ${fact.node} · ${fact.status}`;
    case 'schedule-late': return fact.unreadable ? `못 읽음 · ${fact.unreadable}` : `${fact.count}개 · ${fact.names.join(', ') || '없음'}`;
  }
}

export function renderTelegramNow(input: ContextNowAnswer, audience: ContextNowAudience = 'operator'): string {
  const answer = forAudience(input, audience);
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

export function renderTuiNow(input: ContextNowAnswer, audience: ContextNowAudience = 'operator'): string[] {
  const answer = forAudience(input, audience);
  const shortText = (text: string) => {
    const characters = Array.from(text);
    return characters.length > 100 ? `${characters.slice(0, 100).join('')}…` : text;
  };
  const shortSource = (source: string) => {
    if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+#issuecomment-/.test(source)) return '채널';
    if (source.startsWith('elanous://release/')) return '원장';
    return Array.from(source).slice(0, 40).join('');
  };
  const factLabels = { run: '도는 런', release: '발행 런', 'schedule-late': '지연 스케줄', version: '판', cell: '칸', decision: '결정', seat: '자리' } as const;
  const eventLabels: Record<string, string> = { report: '보고', dispatch: '발사', decision: '결정' };
  const events = answer.events.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const rows = [
    ...answer.facts.slice().sort((a, b) => {
      const priority = (kind: ContextFact['kind']) => ({ run: 0, release: 1, 'schedule-late': 2 } as Partial<Record<ContextFact['kind'], number>>)[kind] ?? 3;
      return priority(a.kind) - priority(b.kind);
    }).map(f => [factLabels[f.kind], shortText(factText(f)), shortSource(f.source)]),
    ...events.slice(0, 8).map(e => [eventLabels[e.kind] ?? '소식', shortText(e.summary), shortSource(e.source)]),
    ...answer.guide.map(guide => ['안내', guide, '']),
    ...(events.length > 8 ? [['안내', `… 사건 ${events.length - 8}개 더(/now <주제> 로 좁히기)`, '']] : []),
  ];
  const clean = (text: string) => text.replaceAll('|', ' ').replaceAll(/\r?\n/g, ' ');
  const width = (text: string) => Array.from(text).reduce((total, char) => total + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1), 0);
  const data = [['종류', '사실', '출처'], ...rows].map(row => row.map(clean));
  const widths = [0, 1].map(i => Math.max(...data.map(row => width(row[i] ?? ''))));
  const format = (row: string[]) => `${row[0]}${' '.repeat(widths[0]! - width(row[0]!) + 2)}${row[1]}${' '.repeat(widths[1]! - width(row[1]!) + 2)}${row[2]}`;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(answer.at));
  return [
    `지금${answer.topic ? ` · ${answer.topic}` : ''} (${time} KST)`,
    ...data.map(format),
  ];
}

/** Voice keeps the source-labelled ledger view out of the spoken transcript. */
export function renderVoiceNow(input: ContextNowAnswer, audience: ContextNowAudience = 'operator'): string {
  const answer = forAudience(input, audience);
  const spoken = (text: string) => text.replace(/\s+/g, ' ').replace(/[.!?。！？]+/g, ' ').trim();
  const sentence = (text: string) => `${Array.from(spoken(text)).slice(0, 119).join('').trimEnd()}。`;
  const seats = seatOrder.flatMap(seat => {
    const label = audience === 'public-demo' ? publicSeatNames[seat]! : seat;
    const latest = answer.facts.filter((fact): fact is Extract<ContextFact, { kind: 'seat' }> => fact.kind === 'seat' && (fact.seat === label || (audience === 'public-demo' && fact.seat === seat)))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (!latest) return [];
    return [`${label} ${Array.from(spoken(latest.title ?? latest.status)).slice(0, 18).join('')}`];
  });
  const first = sentence(seats.length ? `지금 ${seats.join(', ')} 중입니다` : '지금 자리 현황은 확인되지 않았습니다');
  const decision = answer.facts.find(fact => fact.kind === 'decision' && fact.status === 'open');
  const cell = answer.facts.find(fact => fact.kind === 'cell' && fact.status !== 'done');
  const shortTitle = (text: string) => Array.from(spoken(text)).slice(0, 75).join('').trimEnd();
  const next = decision?.kind === 'decision' ? `다음은 ${shortTitle(decision.title)} 결정이 필요합니다`
    : cell?.kind === 'cell' ? `다음은 ${shortTitle(cell.title)} 칸을 확인해야 합니다`
      : '다음에 필요한 결정이나 미완료 칸은 확인되지 않았습니다';
  return `${first} ${sentence(next)}`;
}

/** A compact card retains the same source-labelled public facts as the other /now surfaces. */
export function renderCardNow(input: ContextNowAnswer, audience: ContextNowAudience = 'operator'): {
  title: string;
  sections: Array<{ label: string; items: Array<{ text: string; source: string }> }>;
} {
  const answer = forAudience(input, audience);
  const kinds = [
    ['판', 'version'], ['칸', 'cell'], ['결정', 'decision'], ['자리', 'seat'],
  ] as const;
  return {
    title: `지금${answer.topic ? ` · ${answer.topic}` : ''} (${answer.at})`,
    sections: [
      ...kinds.map(([label, kind]) => ({
        label,
        items: answer.facts.filter(fact => fact.kind === kind).map(fact => ({ text: factText(fact), source: fact.source })),
      })),
      { label: '최근', items: answer.events.map(event => ({ text: event.summary, source: event.source })) },
      { label: '안내', items: answer.guide.map(text => ({ text, source: '' })) },
    ],
  };
}

export function telegramNowSlash(args: string[], deps?: ContextNowDeps): string {
  return renderTelegramNow(readSlashContextNow(args, deps));
}

export function tuiNowSlash(args: string[], deps?: ContextNowDeps): string[] {
  return renderTuiNow(readSlashContextNow(args, deps));
}
