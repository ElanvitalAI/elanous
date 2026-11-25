/** StepList — ordered steps: ✓ done · ▸ active · ○ todo, with an optional note. */
import { clean, fit } from './text.js';

export type StepState = 'done' | 'active' | 'todo';
export interface Step { readonly label: string; readonly state: StepState; readonly note?: string }
export interface StepListProps { readonly steps: readonly Step[] }

export const STEP_GLYPH: Readonly<Record<StepState, string>> = { done: '✓', active: '▸', todo: '○' };

export function renderStepList(props: StepListProps, width: number): string[] {
  return props.steps.map((step) => fit(`${STEP_GLYPH[step.state]} ${clean(step.label)}${step.note ? ` · ${clean(step.note)}` : ''}`, width));
}
