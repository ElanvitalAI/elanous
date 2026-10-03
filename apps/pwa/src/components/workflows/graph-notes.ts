export interface GraphNote {
  id: string;
  x: number;
  y: number;
  text: string;
}

const keyFor = (workflowName: string) => `elanous.workflow.notes.${workflowName}`;

export function loadNotes(workflowName: string): GraphNote[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(keyFor(workflowName)) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((note): note is GraphNote =>
      note !== null && typeof note === 'object'
      && typeof note.id === 'string'
      && typeof note.x === 'number' && Number.isFinite(note.x)
      && typeof note.y === 'number' && Number.isFinite(note.y)
      && typeof note.text === 'string',
    ).map(({ id, x, y, text }) => ({ id, x, y, text }));
  } catch {
    return [];
  }
}

export function saveNotes(workflowName: string, notes: GraphNote[]): void {
  try {
    localStorage.setItem(keyFor(workflowName), JSON.stringify(notes));
  } catch {
    // Storage can be unavailable (private browsing or quota exceeded).
  }
}

export function addNote(notes: GraphNote[], at: { x: number; y: number }): GraphNote[] {
  const ids = new Set(notes.map((note) => note.id));
  let index = 1;
  while (ids.has(`note-${index}`)) index++;
  return [...notes, { id: `note-${index}`, x: at.x, y: at.y, text: '' }];
}

export function updateNote(notes: GraphNote[], id: string, patch: Partial<Pick<GraphNote, 'x' | 'y' | 'text'>>): GraphNote[] {
  return notes.map((note) => note.id === id ? { ...note, ...patch } : note);
}

export function removeNote(notes: GraphNote[], id: string): GraphNote[] {
  return notes.filter((note) => note.id !== id);
}
