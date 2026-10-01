import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { junitFailures, parseFailures } from './gate-diff';

export function baselineFromCutLogs(dir: string, expectedCommit?: string): { failures: string[]; errors: string[]; files: number; complete: boolean } | undefined {
  if (!existsSync(dir)) return undefined;
  let names: string[];
  try { names = readdirSync(dir); }
  catch { return undefined; }
  const metadata = (name: string): { rc?: unknown; files?: unknown; shardCount?: unknown; commit?: unknown } | undefined => {
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    } catch { return undefined; }
  };
  const logs = names.filter((name) => /^pod-\d+(?:-[\w-]+)?\.log$/.test(name));
  if (!logs.length) return undefined;

  // A split parent's output is partial; only its measured leaves belong to the cut.
  const leaves = logs.filter((name) => !names.some((other) => other.startsWith(name.slice(0, -4) + '-')
    && /^pod-\d+(?:-[\w-]+)?\.json$/.test(other)));
  const failures = new Set<string>();
  const errors = new Set<string>();
  const files = new Set<string>();
  let measured = true;
  const measuredFiles = new Set<string>();
  for (const name of leaves) {
    const prefix = name.slice(0, -4);
    const junitName = `${prefix}.junit.xml`;
    let output: string;
    let xml: string;
    try {
      output = readFileSync(join(dir, name), 'utf8');
      xml = names.includes(junitName) ? readFileSync(join(dir, junitName), 'utf8') : '';
    } catch {
      measured = false;
      continue;
    }
    const named = new Set([...parseFailures(output), ...junitFailures(xml)]);
    for (const id of named) failures.add(id);
    for (const match of xml.matchAll(/<testsuite\b[^>]*\bfile="([^"]+)"/g)) files.add(match[1]!);
    const shard = names.includes(`${prefix}.json`) ? metadata(`${prefix}.json`) : undefined;
    const ran = [...output.matchAll(/Ran (\d+) tests? across (\d+) files?/g)].at(-1);
    const reported = [...output.matchAll(/(?:^|\n)\s*(\d+) fail\s*(?=\n|$)/g)].at(-1);
    const junitFiles = new Set([...xml.matchAll(/<testsuite\b[^>]*\bfile="([^"]+)"/g)].map((match) => match[1]!));
    if (!shard || (shard.rc !== 0 && shard.rc !== 1) || (expectedCommit && shard.commit !== expectedCommit)
      || !ran || Number(ran[1]) < 1 || junitFiles.size !== Number(ran[2])
      || !reported || Number(reported[1]) !== named.size || !Array.isArray(shard.files)
      || !shard.files.every((file): file is string => typeof file === 'string')) measured = false;
    else for (const file of shard.files) measuredFiles.add(file);
    let file: string | undefined;
    let attributedErrors = 0;
    for (const raw of output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
      const line = raw.trim();
      const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):(?:\s|$)/.exec(line);
      if (header) file = header[1];
      if (/^# Unhandled error between tests/.test(line)) {
        if (!file) measured = false;
        else {
          errors.add(`${file} > [error]`);
          attributedErrors++;
          file = undefined;
        }
      }
    }
    const reportedErrors = [...output.matchAll(/(?:^|\n)\s*(\d+) errors?\s*(?=\n|$)/g)].at(-1);
    if ((reportedErrors ? Number(reportedErrors[1]) : 0) !== attributedErrors
      || (shard?.rc === 1 && named.size + attributedErrors === 0)
      || (shard?.rc === 0 && named.size + attributedErrors > 0)) measured = false;
  }

  const plannedFiles = new Set<string>();
  const roots = names.filter((name) => /^pod-\d+\.json$/.test(name));
  const allMetadata = names.filter((name) => /^pod-\d+(?:-[\w-]+)?\.json$/.test(name)).map(metadata);
  if (allMetadata.some((shard) => !shard || (expectedCommit && shard.commit !== expectedCommit))) measured = false;
  const rootMetadata = roots.map(metadata);
  for (const shard of rootMetadata) {
    if (!shard || (expectedCommit && shard.commit !== expectedCommit)
      || !Array.isArray(shard.files) || !shard.files.every((file): file is string => typeof file === 'string')) measured = false;
    else for (const file of shard.files) plannedFiles.add(file);
  }
  const count = rootMetadata[0]?.shardCount;
  const complete = measured && rootMetadata.every((shard) => shard?.shardCount === count)
    && roots.length === count
    && plannedFiles.size > 0 && plannedFiles.size === measuredFiles.size
    && [...plannedFiles].every((file) => measuredFiles.has(file))
    && files.size === measuredFiles.size && [...measuredFiles].every((file) => files.has(file))
    && typeof count === 'number' && Number.isSafeInteger(count) && count > 0
    && Array.from({ length: count }, (_, index) => index).every((index) => names.includes(`pod-${index}.json`)
      && leaves.some((name) => name.startsWith(`pod-${index}.`) || name.startsWith(`pod-${index}-`)));
  return { failures: [...failures].sort(), errors: [...errors].sort(), files: files.size, complete };
}
