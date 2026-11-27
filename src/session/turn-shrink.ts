// TURN-SHRINK (CEO 11-26 22:5x · OP «✘ Could not process the request» at 21:41 and 22:45) — a turn over the context budget
// is shrunk, never failed whole.
//
// S: twice tonight the newest OP turn alone (a 47-mail bundle · a 1 039-row commitment digest) was bigger than the
//    turn's history allowance. `trimKeepingRecentHumans` never drops the newest turn, so assembleTurnMessages threw and
//    the whole turn — every mail in it — was lost to «Could not process the request».
// C: the turn text has parts that are optional (a pulse digest, a summary) and parts that are not (the mails).
// A: shrinkSteps() gives the candidate texts in order: ① optional sections dropped (the pulse digest block · any
//    <optional-section>…</optional-section>), ② the rest cut at a line boundary to ½ · ¼ · ⅛ · 1/16 of its size with a
//    note naming what was held back (the mail ids it contained) — the caller takes the first that fits. A person's
//    own turn is never shrunk (their words are the request).
//
// 세 얼굴: 관측 = `session.shrink applied` (step · chars before/after · held ids) · 판단 근거 = the budget check after each
// step · 수복과 인계 = the note in the turn names the held-back mail ids and how to read them (`eln msg show <id>`).

/** The pulse digest block (src/op-control/pulse-digest.ts): from its head line to its closing advice line. */
const PULSE_DIGEST = /^\[Pulse digest · [^\n]*\n(?:[\s\S]*?\n)?Close an overdue commitment[^\n]*(?:\n|$)/mu;
const OPTIONAL = /<optional-section(?:\s+name="([^"]*)")?>[\s\S]*?<\/optional-section>\n?/gu;

export interface ShrinkStep { readonly step: string; readonly text: string; readonly heldIds: readonly number[] }

/** ① drop optional sections. Returns null when there is none. */
export function dropOptionalSections(text: string): { text: string; dropped: string[] } | null {
  const dropped: string[] = [];
  let out = text.replace(PULSE_DIGEST, () => { dropped.push('pulse digest'); return '[pulse digest omitted — over the turn budget · eln commitment list --seat OP]\n'; });
  out = out.replace(OPTIONAL, (_m, name: string | undefined) => { dropped.push(name ?? 'optional section'); return `[${name ?? 'optional section'} omitted — over the turn budget]\n`; });
  return dropped.length ? { text: out, dropped } : null;
}

/** The mail ids a cut-off part mentions (`#123456` · `msg 123456`), unique, in order. */
export function mailIdsIn(text: string, max = 40): number[] {
  const ids: number[] = [];
  for (const m of text.matchAll(/(?:#|msg[\s:#]*)(\d{4,7})\b/gu)) { const id = Number(m[1]); if (!ids.includes(id)) ids.push(id); if (ids.length >= max) break; }
  return ids;
}

/** ② keep the first `keep` characters (cut at a line end) and say what was held back. */
export function cutWithNote(text: string, keep: number): { text: string; heldIds: number[] } {
  if (text.length <= keep) return { text, heldIds: [] };
  const nl = text.lastIndexOf('\n', keep);
  const at = nl > keep / 2 ? nl : keep;
  const held = text.slice(at);
  const heldIds = mailIdsIn(held);
  const note = `\n[… ${held.length.toLocaleString('en-US')} chars held back — over the turn budget.${heldIds.length ? ` Mail ids in the held part: ${heldIds.map((i) => `#${i}`).join(' ')} — read each with eln msg show <id>; they stay unacked until handled.` : ''}]`;
  return { text: `${text.slice(0, at)}${note}`, heldIds };
}

// 출처: halving keeps the number of re-measures small (4) while the last step (1/16) still fits a 70k-token cap for a
// 1M-char turn; below that the turn fails as before (nothing sensible is left to send).
export const SHRINK_FRACTIONS: readonly number[] = [1 / 2, 1 / 4, 1 / 8, 1 / 16];

/** The candidate texts, in the order to try. */
export function shrinkSteps(text: string): ShrinkStep[] {
  const steps: ShrinkStep[] = [];
  const optional = dropOptionalSections(text);
  const base = optional ? optional.text : text;
  if (optional) steps.push({ step: `optional:${optional.dropped.join(',')}`, text: base, heldIds: [] });
  for (const f of SHRINK_FRACTIONS) {
    const cut = cutWithNote(base, Math.max(1, Math.floor(base.length * f)));
    steps.push({ step: `cut:${f}`, text: cut.text, heldIds: cut.heldIds });
  }
  return steps;
}
