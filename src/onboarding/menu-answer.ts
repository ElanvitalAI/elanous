export type MenuAnswer<T> =
  | { kind: 'chosen'; provider: T }
  | { kind: 'cancel' }
  | { kind: 'miss' };

/** Parse a menu answer using the first-run chooser contract: blank cancels, only ASCII decimal indices select. */
export function parseMenuAnswer<T>(answer: string, choices: readonly T[]): MenuAnswer<T> {
  const trimmed = answer.trim();
  if (trimmed === '') return { kind: 'cancel' };
  if (!/^[0-9]+$/.test(trimmed)) return { kind: 'miss' };
  const provider = choices[Number(trimmed) - 1];
  return provider !== undefined ? { kind: 'chosen', provider } : { kind: 'miss' };
}
