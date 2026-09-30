import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read per-file seconds from previous cut Pod reports; missing or damaged reports are not estimates. */
export function readFileDurations(dir: string): Map<string, number> {
  const durations = new Map<string, number>();
  let names: string[];
  const entities: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  try { names = readdirSync(dir).filter((name) => name.endsWith('.junit.xml')).sort(); }
  catch { return durations; }
  for (const name of names) {
    try {
      const xml = readFileSync(join(dir, name), 'utf8');
      for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
        const attrs = match[1]!;
        const file = /\bfile="([^"]+)"/.exec(attrs)?.[1];
        const rawTime = /\btime="([^"]+)"/.exec(attrs)?.[1];
        if (!file || rawTime === undefined) continue;
        const seconds = Number(rawTime);
        if (!Number.isFinite(seconds) || seconds < 0) continue;
        const path = file.replace(/&(?:amp|quot|apos|lt|gt);/g, (entity) => entities[entity]!);
        durations.set(path, Math.max(durations.get(path) ?? 0, seconds));
      }
    } catch { /* One unreadable report must not discard the others. */ }
  }
  return durations;
}

/** Longest processing time first; tie-breaks use lexical paths, then the least populated lightest shard. */
export function planShards(files: string[], durations: Map<string, number>, count: number): Array<{ files: string[]; plannedSeconds: number }> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('invalid shard count');
  const known = files.map((file) => durations.get(file)).filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const median = known.length ? (known[Math.floor((known.length - 1) / 2)]! + known[Math.floor(known.length / 2)]!) / 2 : 1;
  const weight = (file: string) => {
    const value = durations.get(file);
    return value !== undefined && Number.isFinite(value) && value >= 0 ? value : median;
  };
  const shards = Array.from({ length: Math.min(count, files.length) }, () => ({ files: [] as string[], plannedSeconds: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    let lightest = shards[0]!;
    for (const shard of shards) if (shard.plannedSeconds < lightest.plannedSeconds
      || (shard.plannedSeconds === lightest.plannedSeconds && shard.files.length < lightest.files.length)) lightest = shard;
    lightest.files.push(file);
    lightest.plannedSeconds += weight(file);
  }
  return shards.filter((shard) => shard.files.length > 0);
}
