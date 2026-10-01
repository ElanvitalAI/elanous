import { readFileSync } from 'node:fs';

export interface VflowPromptRow {
  url: string;
  model: string;
  category: string;
  name: string;
  description: string;
  prompt: string;
  keywords: string[];
  author: string | null;
  authorUrl: string | null;
  spec?: {
    duration?: string;
    camera?: string[];
    lighting?: string[];
    mood?: string[];
    difficulty?: string;
    promptLanguage?: string;
    includes?: string[];
  } | null;
  video?: {
    url?: string;
    isoDuration?: string;
    resolution?: string;
    aspect?: string;
  } | null;
}

export interface VflowQuery {
  model?: string;
  category?: string;
  terms?: readonly string[];
  techniques?: readonly string[];
  camera?: string | readonly string[];
  lighting?: string;
  mood?: string;
  maxSeconds?: number;
  limit?: number;
}

export type VflowSearchResult =
  | { available: true; rows: VflowPromptRow[]; read: number; skipped: number; matches: number }
  | { available: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
// ⚠️ 원천은 «모르는 칸»을 null 로 낸다(10-01 전수: spec.duration·video.isoDuration 이 53% null) — null 을 거부하면 줄째로 버려진다.
const optionalString = (value: unknown): boolean => value == null || typeof value === 'string';
const optionalStrings = (value: unknown): boolean =>
  value == null || (Array.isArray(value) && value.every((item) => typeof item === 'string'));

function isPromptRow(value: unknown): value is VflowPromptRow {
  if (!isRecord(value)) return false;
  if (!['url', 'model', 'category', 'name', 'description', 'prompt'].every((field) => typeof value[field] === 'string')
    || !Array.isArray(value.keywords) || !value.keywords.every((item: unknown) => typeof item === 'string')
    || !(typeof value.author === 'string' || value.author === null)
    || !(typeof value.authorUrl === 'string' || value.authorUrl === null)) return false;
  const spec = value.spec;
  if (spec != null && (!isRecord(spec)
    || !['duration', 'difficulty', 'promptLanguage'].every((field) => optionalString(spec[field]))
    || !['camera', 'lighting', 'mood', 'includes'].every((field) => optionalStrings(spec[field])))) return false;
  const video = value.video;
  if (video != null && (!isRecord(video)
    || !['url', 'isoDuration', 'resolution', 'aspect'].every((field) => optionalString(video[field])))) return false;
  return true;
}

/** Local-only search. Missing/unreadable data is distinct from a readable DB with zero matches. */
export function searchVflowReferences(file: string, query: VflowQuery): VflowSearchResult {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    return { available: false, reason: (error as Error).message };
  }
  let read = 0;
  let skipped = 0;
  const matches: VflowPromptRow[] = [];
  const contains = (values: readonly string[] | undefined, needle: string | undefined) =>
    !needle || !!values?.some((value) => value.toLowerCase().includes(needle.toLowerCase()));
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    read++;
    let value: unknown;
    try { value = JSON.parse(line); } catch { skipped++; continue; }
    if (!isPromptRow(value)) { skipped++; continue; }
    const row = value;
    const prompt = row.prompt.toLowerCase();
    const keywords = row.keywords.map((word) => word.toLowerCase());
    const fields = [prompt, row.name.toLowerCase(), row.description.toLowerCase(), ...keywords];
    const techniqueFields = [prompt, ...keywords];
    if (query.model && !row.model.toLowerCase().startsWith(query.model.toLowerCase())) continue;
    if (query.category && row.category.toLowerCase() !== query.category.toLowerCase()) continue;
    if (query.terms && !query.terms.every((term) => fields.some((field) => field.includes(term.toLowerCase())))) continue;
    if (query.techniques && !query.techniques.every((term) => techniqueFields.some((field) => field.includes(term.toLowerCase())))) continue;
    const cameras = typeof query.camera === 'string' ? [query.camera] : query.camera;
    if (cameras?.length && !cameras.some((camera) => contains(row.spec?.camera, camera))) continue;
    if (!contains(row.spec?.lighting, query.lighting)
      || !contains(row.spec?.mood, query.mood)) continue;
    if (query.maxSeconds !== undefined) {
      const seconds = row.spec?.duration?.match(/^\s*(\d+(?:\.\d+)?)s\s*$/i);
      if (!seconds || Number(seconds[1]) > query.maxSeconds) continue;
    }
    matches.push(row);
  }
  matches.sort((a, b) => a.prompt.length - b.prompt.length);
  return { available: true, rows: matches.slice(0, query.limit ?? 5), matches: matches.length, read, skipped };
}
