// Implementation-discipline phase types.
//
// The detector maps a user turn to one of four phases; the
// system-prompt builder emits different guidance per phase. State is
// derived per-turn (stateless) so a wrong classification self-heals
// on the next turn.

export type ImplPhase = 'idle' | 'plan-loaded' | 'design-first' | 'implementation-ready';

export interface DetectInput {
  /** Raw user text for the current turn. */
  text: string;
}
