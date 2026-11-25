/**
 * Stock research demo scene — composition only: FanoutBoard (OP + News/Sentiment/Market data) · StepList
 * (Plan → Fan-out → Collect → Panel) · ResultCard. Fed by a fixture now; live data is DEMO-1126-INVEST-ORCH.
 */
import { renderFanoutBoard, renderResultCard, renderStepList, STEP_GLYPH, type FanoutBoardProps, type ResultCardProps, type Step } from '../index.js';
import { fit } from '../text.js';

export interface InvestResearchModel {
  /** The scene headline, e.g. «Samsung Electronics (005930.KS) — 2027 outlook · Panel of 3». */
  readonly title: string;
  readonly fanout: FanoutBoardProps;
  readonly steps: readonly Step[];
  /** Absent until the panel has answered. */
  readonly result?: ResultCardProps;
}

export function renderInvestResearchScene(model: InvestResearchModel, width: number): string[] {
  return [
    fit(model.title, width),
    ...renderFanoutBoard(model.fanout, width),
    '',
    ...renderStepList({ steps: model.steps }, width),
    ...(model.result ? ['', ...renderResultCard(model.result, width)] : []),
  ];
}

/** The steps on one line («✓ Plan › ✓ Data › ▸ Panel · 9 of 15 …») for short panes. */
function inlineSteps(steps: readonly Step[], width: number): string {
  return fit(steps.map((s) => `${STEP_GLYPH[s.state]} ${s.label}${s.state === 'active' && s.note ? ` · ${s.note}` : ''}`).join(' › '), width);
}

/**
 * The scene fitted to a pane of `width` × `rows` (an els tab): never wider, never taller. When the full scene does not
 * fit it gives up, in order: the step list (one line), panel rows (head + «+n more»), card sections and evidence past
 * the first, then hard-cuts — the card's last lines (disclaimer, bottom border) are kept.
 */
export function renderInvestResearchFrame(model: InvestResearchModel, width: number, rows: number): string[] {
  const full = renderInvestResearchScene(model, width);
  if (full.length <= rows) return full;
  const board = renderFanoutBoard(model.fanout, width);
  const stepLine = inlineSteps(model.steps, width);
  const compactCard = (result: ResultCardProps): string[] => renderResultCard({ ...result,
    sections: result.sections.map((s) => ({ ...s, lines: s.lines.slice(0, 1) })), ...(result.evidence ? { evidence: result.evidence.slice(0, 1) } : {}) }, width);
  const cards = model.result ? [renderResultCard(model.result, width), compactCard(model.result)] : [[]];
  const roomFor = (card: readonly string[]): number => rows - 1 /* title */ - 1 /* board head */ - 2 /* blank + steps */ - (card.length ? card.length + 1 : 0);
  // Prefer a card that leaves a few panel rows visible; otherwise any card that fits.
  const want = Math.min(3, board.length - 1);
  for (const card of [...cards.filter((c) => roomFor(c) >= want), ...cards.filter((c) => roomFor(c) >= 0)].slice(0, 1)) {
    const tailLines = card.length ? ['', ...card] : [];
    const room = roomFor(card);
    const children = board.slice(1);
    const shown = children.length <= room ? children : room >= 2 ? [...children.slice(0, room - 1), fit(`   … +${children.length - (room - 1)} more`, width)] : [];
    return [fit(model.title, width), board[0]!, ...shown, '', stepLine, ...tailLines];
  }
  // Even the compact card does not fit: title, steps, then the card's head and its last lines.
  const card = model.result ? compactCard(model.result) : [];
  const keep = Math.max(0, rows - 2);
  // The card's last block (the disclaimer) and its bottom border are kept whole: they follow the last blank row.
  let lastBlank = -1;
  for (let i = card.length - 2; i > 0 && lastBlank < 0; i--) if (/^│\s*│$/u.test(card[i]!)) lastBlank = i;
  const tail = lastBlank > 0 ? card.slice(lastBlank + 1) : card.slice(-2);
  const cardLines = card.length <= keep ? card : keep > tail.length ? [...card.slice(0, keep - tail.length), ...tail] : card.slice(-keep);
  return [fit(model.title, width), stepLine, ...cardLines].slice(0, rows);
}
