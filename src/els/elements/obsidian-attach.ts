// ELS-ATTACH (대표 11-26 «eln 에 첨부») — `a` in the Obsidian viewer hands the selected note (the open note, or the note under
// the cursor) to an open agent pane as an attachment (src/els/eln-attach.ts: «@<path>» in its input line, never Enter).
// The key reducer only marks the request (`attach` = the vault-relative path); the server's hydrate fires it once and
// drops the field, and the result comes back as a toast («Attached to …» · «No open eln»).

type Nav = { readonly dir: string; readonly cursor: number; readonly scroll: number; readonly note?: string; readonly entries?: ReadonlyArray<{ readonly name: string; readonly dir: boolean }> };

/** `a` → the attach request (undefined = not this key; 'pass' = nothing attachable under the cursor). */
export function attachKey(props: Nav, key: string): (Nav & { attach: string }) | 'pass' | undefined {
  if (key !== 'a') return undefined;
  const nav = { dir: props.dir, cursor: props.cursor, scroll: props.scroll, ...(props.note ? { note: props.note } : {}) };
  if (props.note) return { ...nav, attach: props.note };
  const entry = props.entries?.[props.cursor];
  if (!entry || entry.dir) return 'pass';
  return { ...nav, attach: props.dir ? `${props.dir}/${entry.name}` : entry.name };
}

/** Untrusted → a vault-relative path to attach (no «..», no absolute path), else undefined. */
export function attachOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || raw.startsWith('/') || /[\u0000-\u001f]/.test(raw)) return undefined;
  return raw.split('/').some((part) => part === '..' || part === '.' || part === '') ? undefined : raw;
}
