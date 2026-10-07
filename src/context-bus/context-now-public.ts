import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBrand } from '../../scripts/brand/check.js';
import { debug } from '../debug/log.js';
import type { ContextFact, ContextNowAnswer } from './context-now.js';

const internalItem = (count: number) => `내부 항목 ${count}개`;
const seatNames: Record<string, string> = { OP: '운영', TC: '기술', MK: '마케팅', UX: '사용자 경험' };

/** Public copy only: no raw ledger identifiers or private sources in the rendered answer. */
export function filterPublicDemoContext(answer: ContextNowAnswer, brandCheck: typeof checkBrand = checkBrand): ContextNowAnswer {
  const dir = mkdtempSync(join(tmpdir(), 'context-now-public-'));
  const file = join(dir, 'text.txt');
  try {
    let rulesMissing = brandCheck('public-docs', []).missing;
    const logMissing = () => debug.log('context.now', 'brand-rules-missing', { audience: 'public-demo' });
    if (rulesMissing) logMissing();
    const flagged = (texts: string[]): Set<number> => {
      if (rulesMissing) return new Set(texts.map((_, index) => index));
      if (!texts.length) return new Set();
      writeFileSync(file, texts.map(text => text.replace(/[\r\n]+/g, ' ')).join('\n') + '\n');
      const result = brandCheck('public-docs', [file]);
      if (result.missing) {
        rulesMissing = true;
        logMissing();
        return new Set(texts.map((_, index) => index));
      }
      return new Set(result.findings.map(finding => finding.line - 1));
    };
    const publicText = (value: string): string => value
      .replace(/\bhttps?:\/\/[^\s)\]}>]+/gi, '공개 주소')
      .replace(/\b(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s)\]}>]*)?/gi, '공개 주소')
      .replace(/(?:\/Users\/|\/home\/|\/root(?=[\/\s)\]}>]|$)|~(?=\/)|\$HOME(?=\/)|\$\{HOME\}(?=\/))[^\s)\]}>]*/g, '공개 경로')
      .replace(/\b[\w.-]+@(?!공개)[a-z][\w-]*(?=\b|:\d)/gi, '공개 호스트')
      .replace(/\b(?:run[-_][a-z0-9-]{8,}|[a-f0-9]{8}-[a-f0-9-]{16,})\b/gi, '공개 실행')
      .replace(/\bPR[\s-]*#?\d+\b|#\d+\b/gi, '공개 변경')
      .replace(/\b(?:OP|TC|MK|UX)\b/g, seat => seatNames[seat]!)
      .replace(/\b(host(?:name)?|machine|server)\s*([:=])\s*([a-z][\w-]*)\b/gi, '$1$2 공개 호스트')
      .replace(/\b(host(?:name)?|machine|server|ssh|scp|rsync|ping|mosh)\s+((?:to|from|into|on|at)\s+)?(?!공개)([a-z][\w-]*)(?=\b|:\d)/gi, '$1 $2공개 호스트')
      .replace(/\b((?:deploy(?:ed|ing)?|connect(?:ed|ing)?)\s+(?:at|on|to|from))\s+[a-z][\w-]*(?=\b|:\d)/gi, '$1 공개 호스트')
      .replace(/\b(at|on|to|from)\s+(?:msb\d+|localhost|[a-z][\w-]*\d+)(?=\b|:\d)/gi, '$1 공개 호스트')
      .replace(/\b(?:msb\d+|node-c|cloud-vm|localhost)\b/gi, '공개 호스트');
    const safe = (value: string, fallback: string): string => {
      const text = publicText(value);
      return flagged([text]).size ? fallback : text;
    };
    const source = (value: string) => value.startsWith('elanous://') ? '내부 원장' : safe(value, '공개 출처');
    const titleFacts = answer.facts.filter((fact): fact is Extract<ContextFact, { kind: 'cell' | 'decision' }> =>
      fact.kind === 'cell' || fact.kind === 'decision');
    const privateTitles = flagged(titleFacts.map(fact => fact.title));
    const privateFacts = new Set(titleFacts.filter((_, index) => privateTitles.has(index)));
    const privateIds = new Set(titleFacts.filter(fact => privateFacts.has(fact)).map(fact => fact.id));
    const hasOpenPrivateDecision = titleFacts.some(fact => fact.kind === 'decision' && privateFacts.has(fact) && fact.status === 'open');
    const publicField = (value: string, fallback: string) => safe(value.replace(/\b(?:K|D)\d+\b/g, id =>
      privateIds.has(id) ? '내부 항목' : id), fallback);
    const collapsed = { cell: 0, decision: 0 };
    const facts: ContextFact[] = [];
    for (const fact of answer.facts) {
      if (fact.kind === 'cell' || fact.kind === 'decision') {
        if (privateFacts.has(fact)) {
          collapsed[fact.kind]++;
          continue;
        }
        facts.push(fact.kind === 'cell'
          ? { ...fact, version: safe(fact.version, '공개 판'), id: safe(fact.id, '공개 항목'), title: safe(fact.title, '공개 항목'),
            status: safe(fact.status, '진행 중'), owner: fact.owner ? safe(fact.owner, '공개 담당') : null, source: source(fact.source) }
          : { ...fact, id: safe(fact.id, '공개 항목'), title: safe(fact.title, '공개 항목'),
            status: safe(fact.status, '진행 중'), source: source(fact.source) });
      } else if (fact.kind === 'seat') {
        facts.push({ ...fact, seat: safe(fact.seat, '공개 담당'), status: safe(fact.status, '진행 중'),
          id: fact.id ? (rulesMissing || privateIds.has(fact.id) ? '내부 항목' : safe(fact.id, '공개 항목')) : null,
          title: fact.title === null ? null : rulesMissing ? internalItem(1) : privateIds.has(fact.id ?? '') ? '내부 항목' : safe(fact.title, '공개 항목'),
          source: source(fact.source) });
      } else if (fact.kind === 'version') facts.push({ ...fact, version: safe(fact.version, '공개 판'), source: source(fact.source) });
    }
    for (const kind of ['cell', 'decision'] as const) {
      if (!collapsed[kind]) continue;
      const title = internalItem(collapsed[kind]);
      facts.push(kind === 'cell'
        ? { kind, version: '공개 판', id: '내부 항목', title, status: '진행 중', owner: null, source: '내부 원장' }
        : { kind, id: '내부 항목', title, status: hasOpenPrivateDecision ? 'open' : '진행 중', dueAt: null, source: '내부 원장' });
    }
    return {
      at: answer.at,
      topic: answer.topic === null ? null : publicField(answer.topic, '공개 주제'),
      facts,
      events: answer.events.map(event => ({ ...event, kind: safe(event.kind, '소식'),
        summary: publicField(event.summary, '공개 소식'), source: source(event.source) })),
      guide: answer.guide.map(text => publicField(text, '공개 안내')),
      hiddenCount: collapsed.cell + collapsed.decision + (rulesMissing ? answer.facts.filter(fact => fact.kind === 'seat' && fact.title !== null).length : 0),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
