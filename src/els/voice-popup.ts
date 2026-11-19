// ELS-VOICE-CONTROL-POPUP — the one-line popup at the bottom of the attach screen (ctrl+b :). Pure state machine: keys
// in, one status line out; the plan and the door are handed in (voice-control.ts). The attach app only routes keys here
// while it is open and draws `line()` where the status line goes.
//   typing  — printable keys append, backspace deletes, Enter plans, Esc closes
//   planning — waiting for the plan (keys are ignored)
//   preview — Enter runs a plan without closes; a plan with closes runs only on y; Esc or any other key cancels
// After a run (or a refusal) the popup closes and its last message stays for the status line.

import { runVoicePlan, type VoiceDoor, type VoicePlan } from './voice-control.js';

type Mode = 'closed' | 'typing' | 'planning' | 'preview';

export interface VoicePopupDeps {
  readonly plan: (text: string) => Promise<VoicePlan>;
  readonly door: VoiceDoor;
  /** Repaint: the line changed. */
  readonly changed: () => void;
}

export function createVoicePopup(deps: VoicePopupDeps) {
  let mode: Mode = 'closed';
  let text = '';
  let plan: VoicePlan | undefined;
  let last = '';
  const close = (message: string): void => { mode = 'closed'; text = ''; plan = undefined; last = message; deps.changed(); };
  const run = async (confirmed: boolean): Promise<void> => {
    if (!plan) return;
    const current = plan;
    mode = 'planning';
    deps.changed();
    const done = await runVoicePlan(current, deps.door, confirmed);
    close(done.message);
  };
  const submit = async (): Promise<void> => {
    if (!text.trim()) { close(''); return; }
    mode = 'planning';
    deps.changed();
    plan = await deps.plan(text);
    if (mode !== 'planning') return;            // closed meanwhile
    if (!plan.ok) { close(plan.reason); return; }
    mode = 'preview';
    deps.changed();
  };
  return {
    open(): void { mode = 'typing'; text = ''; plan = undefined; last = ''; deps.changed(); },
    isOpen: (): boolean => mode !== 'closed',
    /** The last outcome after the popup closed ('' = none). */
    lastMessage: (): string => last,
    /** Keys while open. Returns a promise that settles when any plan/run it started is done (tests await it). */
    async feed(bytes: string): Promise<void> {
      for (const char of bytes) {
        if (mode === 'typing') {
          if (char === '\u001b') { close('취소'); return; }
          if (char === '\r' || char === '\n') { await submit(); return; }
          if (char === '\u007f' || char === '\b') { text = [...text].slice(0, -1).join(''); deps.changed(); continue; }
          if (char >= ' ') { text += char; deps.changed(); }
          continue;
        }
        if (mode === 'preview' && plan?.ok) {
          if (char === '\u001b') { close('취소'); return; }
          if (plan.confirm) { if (char === 'y' || char === 'Y') await run(true); else close('취소 (y 가 아님)'); return; }
          if (char === '\r' || char === '\n') { await run(false); return; }
          close('취소');
          return;
        }
        return;                                    // planning / closed: keys are not for the popup
      }
    },
    /** The status line while open. */
    line(): string {
      if (mode === 'typing') return ` : ${text}▏ · Enter 계획 · Esc 취소 `;
      if (mode === 'planning') return ` : ${text} · …`;
      if (mode === 'preview' && plan?.ok) return ` ${plan.preview}${plan.confirm ? ' · 다른 키 취소' : ' · Enter 실행 · Esc 취소'} `;
      return '';
    },
  };
}
