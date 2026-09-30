import trackData from '../../scripts/coord-tracks.json';

export type SeatEntry = {
  id: string;
  title?: string;
  alias?: string;
};

export type SeatAddress = { seats: string[]; body: string };

const registry: readonly SeatEntry[] = trackData.tracks.filter((entry) => 'title' in entry);
const addressLine = /^@([A-Za-z][A-Za-z0-9_-]*(?:,[A-Za-z][A-Za-z0-9_-]*)*)(?:[ \t]+|\r?\n|(?![\s\S]))/gm;

/** Parse an address only when its @ begins a line; leave the instruction text intact. */
export function parseSeatAddress(text: string): SeatAddress | null {
  const match = addressLine.exec(text);
  addressLine.lastIndex = 0;
  if (!match) return null;

  const seats = match[1]!.split(',');
  const body = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`;
  return { seats, body };
}

/** Resolve against the seat registry, preferring titles to ids to legacy aliases. */
export function resolveSeat(address: string, seats: readonly SeatEntry[] = registry): SeatEntry | undefined {
  const needle = address.replace(/^@/, '').toLocaleLowerCase();
  if (!needle) return undefined;
  for (const field of ['title', 'id', 'alias'] as const) {
    const found = seats.find((seat) => seat[field]?.toLocaleLowerCase() === needle);
    if (found) return found;
  }
  return undefined;
}
