import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { lastJsonObject, runGraph as defaultRunGraph, type GraphRunState } from '../graph-runner/runner.js';

const GRAPH = resolve(import.meta.dir, '../../plugins/card-followup/graphs/card-followup.yaml');
export type CardDetectDecision = 'card' | 'skip' | 'ambiguous';

export function cardShape(width?: number, height?: number): { decision: 'skip' | 'pass'; signal: string } {
  if (!width || !height) return { decision: 'pass', signal: 'ratio:unknown' };
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio < 1.15) return { decision: 'skip', signal: 'ratio:square' };
  if (ratio > 2.0) return { decision: 'skip', signal: 'ratio:screenshot' };
  return { decision: 'pass', signal: `ratio:${ratio.toFixed(2)}` };
}
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}/;
const WEB = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|co\.kr|kr|io|ai|net|org)\b/i;
const TITLE = /대표|이사|팀장|부장|과장|실장|매니저|주식회사|\(주\)|\b(?:CEO|CTO|COO|CFO|Director|Manager|Founder|Inc|Ltd|Corp)\b/i;
export function cardText(ocr: string | null): { decision: CardDetectDecision; signal: string } {
  if (ocr === null) return { decision: 'ambiguous', signal: 'ocr:unavailable' };
  const chars = ocr.replace(/\s+/g, '').length;
  if (chars < 15) return { decision: 'ambiguous', signal: 'ocr:chars<15' };
  if (chars > 700) return { decision: 'skip', signal: 'ocr:document' };
  const hits = ([['email', EMAIL], ['phone', PHONE], ['web', WEB], ['title', TITLE]] as const).filter(([, re]) => re.test(ocr)).map(([name]) => name);
  const signal = `ocr:${hits.join(',') || 'none'}`;
  if (hits.length >= 2) return { decision: 'card', signal };
  return { decision: hits.length === 0 ? 'skip' : 'ambiguous', signal };
}
export function detectCard({ width, height, ocrText }: { width?: number; height?: number; ocrText: string | null }): { decision: CardDetectDecision; signal: string } {
  const shape = cardShape(width, height);
  return shape.decision === 'skip' ? { decision: 'skip', signal: shape.signal } : cardText(ocrText);
}

const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const line = (value: unknown): string => (typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value)).replace(/[\r\n]+/g, ' ') || '—';

export class NotACardError extends Error {}
function isNotACard(state: GraphRunState): boolean {
  if (state.status !== 'failed') return false;
  const read = state.nodes.find((node) => node.nodeId === 'read-card');
  if (!read || !read.ok) return false;
  const output = lastJsonObject(read.output);
  if (output?.outcome === 'ok' && output.card && typeof output.card === 'object') {
    const card = obj(output.card);
    return !['name', 'company', 'title', 'email', 'phone', 'url', 'linkedin'].some((field) => text(card[field]));
  }
  return output?.outcome === 'fail' && typeof output.reason === 'string'
    && /\bnot a (?:business )?card\b|명함이?\s*아님|명함이?\s*아닙니다/i.test(output.reason);
}
function validateReport(report: Record<string, unknown>): void {
  const card = obj(report.card), fit = obj(report.fit), approach = obj(report.approach);
  const next = obj(report.nextAction), draft = obj(report.draft);
  const score = fit.score;
  if (report.sent !== false || !text(card.name) || !text(card.company)
    || !(score === null || (typeof score === 'number' && Number.isFinite(score)))
    || !text(fit.label) || !text(approach.problem) || !text(approach.proposal)
    || !text(approach.channel) || !text(next.what) || !text(next.due)
    || !text(draft.subject) || !text(draft.body)) {
    throw new Error('incomplete or sent card report');
  }
}

export async function runCardFollowup({ imagePath, ocrText, runGraph = defaultRunGraph, rootDir = effectiveInstanceRoot(), outDir, runId = randomUUID(), context }: {
  imagePath: string;
  ocrText: string | null;
  runGraph?: typeof defaultRunGraph;
  rootDir?: string;
  outDir?: string;
  runId?: string;
  context?: string;
}): Promise<{ replies: [string, string, string]; followupPath?: string }> {
  if (ocrText !== null && cardText(ocrText).decision !== 'card') throw new NotACardError('not a card');
  const base = join(rootDir, 'graph-runs', 'card-followup');
  const dir = outDir ?? join(base, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  chmodSync(dir, 0o700);
  const statePath = join(base, `${runId}.json`);
  const sealState = () => {
    try { chmodSync(statePath, 0o600); } catch { /* runner may not have written state */ }
    const contexts = `${statePath}.contexts`;
    try {
      chmodSync(contexts, 0o700);
      for (const file of readdirSync(contexts)) chmodSync(join(contexts, file), 0o600);
    } catch { /* no contexts yet */ }
  };
  try {
    const state = await runGraph(GRAPH, { runId, deps: { root: rootDir }, input: {
      image: imagePath, outDir: dir, ...(context ? { context } : {}),
    } });
    if (isNotACard(state)) throw new NotACardError('not a card');
    if (state.status !== 'done') throw new Error('graph did not finish');
    const report = obj(JSON.parse(readFileSync(join(dir, 'followup.json'), 'utf8')));
    validateReport(report);
    const card = obj(report.card), fit = obj(report.fit), approach = obj(report.approach);
    const next = obj(report.nextAction), draft = obj(report.draft);
    const summary = `① 요약\n${line(card.name)} · ${line(card.company)} · ${line(card.title)}\n타겟 판정: ${line(fit.score)} · ${line(fit.label)}`;
    const strategy = `② 전략\n${[approach.problem, approach.proposal, approach.channel].map(line).join('\n')}\n다음 행동: ${line(next.what)} · ${line(next.due)}`;
    const mail = `③ 팔로업 초안 (보내지 않았습니다)\n제목: ${line(draft.subject)}\n${text(draft.body)}`;
    const followupPath = join(dir, 'followup.md');
    readFileSync(followupPath);
    return { replies: [summary, strategy, mail], followupPath };
  } finally {
    if (runGraph === defaultRunGraph) sealState();
  }
}
