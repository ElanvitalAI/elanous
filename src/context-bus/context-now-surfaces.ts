import { contextNow, type ContextFact, type ContextNowAnswer, type ContextNowDeps } from './context-now.js';

export function readSlashContextNow(args: string[], deps?: ContextNowDeps): ContextNowAnswer {
  return contextNow({ topic: args.join(' ').trim() }, deps);
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
  const rows = [
    ...answer.facts.map(f => [f.kind, factText(f), f.source]),
    ...answer.events.map(e => [e.kind, e.summary, e.source]),
    ...answer.guide.map(guide => ['안내', guide, '']),
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
