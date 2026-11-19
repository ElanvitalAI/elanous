/** Update the legacy seat-pane index without treating a pane ID as permission to wake it.
 * Callers must separately verify the live pane and explicitly register its wake consent.
 */
export function updateSeatPaneDirectory(contents: string, seat: string, pane: string): string {
  if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(seat)) throw new Error('invalid seat');
  if (!/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(pane)) throw new Error('invalid pane');
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const next: string[] = [];
  let written = false;
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields[0] !== seat) { next.push(line); continue; }
    if (!written) {
      const extra = fields.slice(2);
      if (extra.length && /^w[A-Za-z0-9]+$/.test(extra[0]!)) extra[0] = pane.split(':')[0]!;
      next.push([seat, pane, ...extra].join('\t'));
      written = true;
    }
  }
  if (!written) next.push(`${seat}\t${pane}`);
  return next.join('\n') + '\n';
}

/** Remote targets cannot be represented safely by the local-only two-column index. */
export function removeSeatPaneDirectoryEntry(contents: string, seat: string): string {
  if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(seat)) throw new Error('invalid seat');
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const next = lines.filter(line => line.split('\t')[0] !== seat);
  return next.length ? next.join('\n') + '\n' : '';
}
