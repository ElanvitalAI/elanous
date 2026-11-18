// HERDR-C1-PICKER-FRICTION (HERDR-REPLACE-AUDIT 1117 ①): the «new PTY» picker that `/side new` opens takes one plain
// letter (s shell · e elanous · c codex · l claude). It used to swallow every other key, so a person who kept typing —
// «/side send …» — lost the «/» and the «s» spawned a shell that received the rest of the line. Now only a choice letter
// or Esc belongs to the picker; any other key closes it and goes on to the composer as typed.
export type NewPtyCharacter = 'shell' | 'elanous' | 'codex' | 'claude';

export const NEW_PTY_CHOICES: Readonly<Record<string, NewPtyCharacter>> = { s: 'shell', e: 'elanous', c: 'codex', l: 'claude' };

export type NewPtyPickerAction =
  | { readonly kind: 'spawn'; readonly character: NewPtyCharacter }
  | { readonly kind: 'close' }
  /** Not the picker's key: close the picker and let the key reach the composer. */
  | { readonly kind: 'pass' };

export function newPtyPickerKey(key: { readonly name: string; readonly ctrl?: boolean; readonly alt?: boolean; readonly meta?: boolean; readonly shift?: boolean }): NewPtyPickerAction {
  if (key.name === 'escape') return { kind: 'close' };
  const plain = !key.ctrl && !key.alt && !key.meta && !key.shift;
  const character = plain ? NEW_PTY_CHOICES[key.name] : undefined;
  return character ? { kind: 'spawn', character } : { kind: 'pass' };
}
