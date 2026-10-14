import { debug } from '../debug/log.js';
import type { ModelCatalog, ModelEntry } from './types.js';

const NUMERIC_COLUMNS = [
  'ctx', 'in$/1M', 'out$/1M', 'cacheRead$/1M', 'est_run$',
  'AA_intel', 'AA_coding', 'AA_agentic', 'SWE_verified', 'SWE_pro',
  'TerminalBench', 'LiveCodeBench', 'tool_use',
] as const;

export type BenchNumericColumn = typeof NUMERIC_COLUMNS[number];
export type BenchScore = 'AA_coding' | 'AA_agentic' | 'SWE_verified' | 'TerminalBench';

export type BenchRow = {
  id: string;
  provider: string;
  sources: string;
  notes: string;
  raw: Record<string, string>;
} & Record<BenchNumericColumn, number | null>;

export type ComparedBenchRow<T extends BenchRow = BenchRow> = T & {
  value: number | null;
  status: 'scored' | '미확인';
};

const UNKNOWN = new Set(['', '미확인', '미표기', '-']);
const NUMBER = /[-+]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?/g;

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (UNKNOWN.has(trimmed)) return null;
  // A label may contain a version number ("AA TB4.0 33.3"); the final
  // number is the measured value. Keep the full cell separately in raw.
  const matches = [...trimmed.matchAll(NUMBER)];
  const last = matches.at(-1)?.[0];
  if (!last) return null;
  const parsed = Number(last.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a caller-supplied, offline TSV. Column positions come only from the header. */
export function parseBenchScoresTsv(text: string): BenchRow[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headers = (lines.shift() ?? '').split('\t').map((name) => name.trim());
  if (!headers.includes('id')) throw new Error('bench scores TSV missing id header');
  const rows: BenchRow[] = [];
  let unknownCells = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const raw: Record<string, string> = {};
    headers.forEach((header, index) => { raw[header] = cells[index] ?? ''; });
    const numbers = {} as Record<BenchNumericColumn, number | null>;
    for (const column of NUMERIC_COLUMNS) {
      numbers[column] = parseNumber(raw[column] ?? '');
      if (numbers[column] === null) unknownCells++;
    }
    rows.push({ id: raw.id?.trim() ?? '', provider: raw.provider ?? '',
      sources: raw.sources ?? '', notes: raw.notes ?? '', raw, ...numbers });
  }
  debug.log('intelligence.bench-scores', 'parsed', { rows, unknownCells });
  return rows;
}

/** An OpenRouter vendor/model id matches a catalog id only under its vendor.
 * The builtin DeepSeek entries are `other`/`deepseek` but have the explicit
 * OpenRouter route `deepseek/<id>` in their notes. */
function catalogIds(model: ModelEntry): string[] {
  const ids = [model.id];
  const vendor = model.provider === 'openai-codex' ? 'openai'
    : model.provider === 'gemini' ? 'google'
    : model.provider === 'grok' ? 'x-ai'
    : model.provider === 'kimi' ? 'moonshotai'
    : model.provider === 'glm' ? 'z-ai'
    : model.provider === 'other' && model.family === 'deepseek' && model.notes?.includes(`OpenRouter deepseek/${model.id}`) ? 'deepseek'
    : model.provider;
  if (!model.local) ids.push(`${vendor}/${model.id}`, `openrouter/${vendor}/${model.id}`);
  return ids;
}

export function joinWithCatalog<T extends BenchRow>(rows: readonly T[], catalog: ModelCatalog): (T & { inCatalog: boolean })[] {
  const ids = new Set(catalog.models.flatMap(catalogIds));
  return rows.map((row) => ({ ...row, inCatalog: ids.has(row.id) }));
}

/** Sort by score per estimated run dollar. Missing scores always come last;
 * a known score without a usable denominator has an unknown value. */
export function compareRows<T extends BenchRow>(rows: readonly T[], opts: { score: BenchScore }): ComparedBenchRow<T>[] {
  return rows.map((row) => {
    const score = row[opts.score];
    return { ...row,
      value: score !== null && row.est_run$ !== null && row.est_run$ > 0
        ? score / row.est_run$ : null,
      status: score === null ? '미확인' as const : 'scored' as const,
    };
  }).sort((a, b) => {
    if (a.status !== b.status) return a.status === '미확인' ? 1 : -1;
    if (a.value === null) return b.value === null ? 0 : 1;
    if (b.value === null) return -1;
    return b.value - a.value;
  });
}
