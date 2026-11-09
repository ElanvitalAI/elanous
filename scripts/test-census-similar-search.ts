#!/usr/bin/env bun
/**
 * Compare the three existing test-census indexes for every selected test case.
 * Input is scripts/test-census.ts --format json output plus a newline-delimited
 * `file > test name` selection list. Embeddings use the normal knowledge embedder.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultEmbed, type EmbedFn } from '../src/domains/knowledge.js';
import { createCensusSearchAdapter, type CensusCase } from './test-census/similar-search.js';
import type { NumericCandidateProvenance } from './test-census.js';

type CensusRow = { file: string; name: string; suitePath?: string[]; contract?: string; owner?: string; numericCandidateProvenance?: NumericCandidateProvenance[] | null };
type CensusDocument = { rows?: CensusRow[] };

export const TEST_CENSUS_AUDIT_QUESTIONS = {
  expectedValueJustification: [
    'Which numeric literal is the assertion expecting, and is it a contract value rather than an incidental number in the test body?',
    'Which git blame commit introduced the literal, and what reason does that commit record?',
    'Does the recorded reason cite a design budget, external limit, or defect case that still applies? If evidence is absent, mark the value unsubstantiated.',
  ],
} as const;

function censusIdentity(row: CensusRow): string {
  return `${row.file} > ${[...(row.suitePath ?? []), row.name].join(' > ')}`;
}

export function caseRowsFromSelection(census: CensusDocument, identities: string[]): CensusCase[] {
  if (!Array.isArray(census.rows)) throw new Error('census JSON must contain a rows array');
  const selected = new Set(identities);
  if (selected.size !== identities.length) throw new Error('selection list contains duplicate cases');
  const rows = census.rows.filter((row) => selected.has(censusIdentity(row)));
  const found = new Set(rows.map(censusIdentity));
  const missing = identities.filter((identity) => !found.has(identity));
  if (missing.length) throw new Error(`selection cases absent from census (${missing.length}): ${missing.slice(0, 5).join(' | ')}`);
  if (!rows.length) throw new Error('selection list is empty');
  return rows.map((row) => ({
    id: `${row.file}#${[...(row.suitePath ?? []), row.name].join(' > ')}`,
    file: row.file,
    name: row.name,
    assertions: row.contract ?? '',
    targetSummary: row.contract ?? row.name,
    module: dirname(row.file).replaceAll('\\', '/'),
    owner: row.owner,
    ...(Object.hasOwn(row, 'numericCandidateProvenance') ? { numericCandidateProvenance: row.numericCandidateProvenance } : {}),
  }));
}

export function parseArgs(args: string[]): { censusPath: string; selectionPath: string; outputPath?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag !== '--census' && flag !== '--selection' && flag !== '--out') {
      throw new Error(`unknown argument: ${flag}`);
    }
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a path`);
    values.set(flag, value);
    index += 1;
  }
  const censusPath = values.get('--census');
  const selectionPath = values.get('--selection');
  if (!censusPath) throw new Error('--census <path> is required');
  if (!selectionPath) throw new Error('--selection <path> is required');
  const outputPath = values.get('--out');
  return { censusPath, selectionPath, ...(outputPath ? { outputPath } : {}) };
}

function selectedCases(censusPath: string, selectionPath: string): CensusCase[] {
  const census = JSON.parse(readFileSync(censusPath, 'utf8')) as CensusDocument;
  const identities = readFileSync(selectionPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return caseRowsFromSelection(census, identities);
}

async function main(): Promise<void> {
  await runSimilarSearchCli(process.argv.slice(2));
}

export async function runSimilarSearchCli(args: string[], embed: EmbedFn = defaultEmbed): Promise<void> {
  const options = parseArgs(args);
  const censusPath = resolve(options.censusPath);
  const selectionPath = resolve(options.selectionPath);
  const outputPath = options.outputPath ? resolve(options.outputPath) : undefined;
  const rows = selectedCases(censusPath, selectionPath);
  const report = await buildSimilarSearchReport(rows, embed, {
    census: censusPath,
    selection: selectionPath,
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, output);
  else process.stdout.write(output);
}

export async function buildSimilarSearchReport(
  rows: CensusCase[],
  embed: EmbedFn,
  source: { census: string; selection: string },
) {
  const byId = new Map(rows.map((row) => [row.id ?? `${row.file}#${row.name}`, row]));
  const candidateLimit = 3;
  const adapter = await createCensusSearchAdapter(rows, embed);
  try {
    const comparisons = [];
    for (const id of adapter.caseIds) comparisons.push(await adapter.compare(id, candidateLimit));
    const disagreements = comparisons.filter((row) =>
      new Set([JSON.stringify(row.bm25.slice(0, candidateLimit)), JSON.stringify(row.vector.slice(0, candidateLimit)), JSON.stringify(row.ontology.slice(0, candidateLimit))]).size > 1,
    );
    return {
      generatedAt: new Date().toISOString(),
      source,
      casesIndexed: rows.length,
      candidateLimit,
      interpretation: 'Rankings are retrieval observations, not adjudicated same-contract labels. KGS ontology candidates are the union of explicit contract-edge neighbors and shared-module-edge neighbors.',
      auditQuestions: TEST_CENSUS_AUDIT_QUESTIONS,
      cases: comparisons.map((comparison) => ({
        caseId: comparison.queryId,
        numericCandidateProvenance: byId.get(comparison.queryId)?.numericCandidateProvenance ?? null,
        top3: {
          bm25: comparison.bm25.slice(0, candidateLimit),
          vector: comparison.vector.slice(0, candidateLimit),
          ontology: comparison.ontology.slice(0, candidateLimit),
        },
        rrf: comparison.rrf.slice(0, candidateLimit),
        differences: comparison.disagreements,
      })),
      disagreementCount: disagreements.length,
      disagreementCaseIds: disagreements.map((row) => row.queryId),
    };
  } finally {
    adapter.close();
  }
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
