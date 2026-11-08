export interface PairedIsolatedBatch<T> {
  cut: Map<string, T>;
  baseline: Map<string, T>;
  failures: unknown[];
}

export interface PairedIsolatedBatches<T> extends PairedIsolatedBatch<T> {
  batches: number;
}

function checkedResults<T>(files: readonly string[], result: PromiseSettledResult<Map<string, T>>, side: string,
  failures: unknown[]): Map<string, T> {
  if (result.status === 'rejected') {
    failures.push(result.reason);
    return new Map();
  }
  for (const file of files) if (!result.value.has(file) ) failures.push(new Error(`paired isolated ${side} batch missing result: ${file}`));
  const allowed = new Set(files);
  for (const file of result.value.keys()) if (!allowed.has(file)) failures.push(new Error(`paired isolated ${side} batch returned unexpected result: ${file}`));
  return result.value;
}

/** Run the cut and baseline isolated batches concurrently, retaining a successful side if its peer rejects. */
export async function runPairedIsolatedBatch<T>(input: {
  cutFiles: readonly string[];
  baselineFiles: readonly string[];
  cutCommit: string;
  baselineCommit: string;
  runBatch(files: readonly string[], commit: string): Promise<Map<string, T>>;
}): Promise<PairedIsolatedBatch<T>> {
  const cutFiles = [...new Set(input.cutFiles)];
  const cutSet = new Set(cutFiles);
  const baselineFiles = [...new Set(input.baselineFiles)];
  if (!cutFiles.length || cutFiles.length !== input.cutFiles.length || baselineFiles.length !== input.baselineFiles.length
    || baselineFiles.some((file) => !cutSet.has(file))) throw new Error('invalid paired isolated batch files');

  const run = (files: readonly string[], commit: string): Promise<Map<string, T>> =>
    Promise.resolve().then(() => input.runBatch(files, commit));
  const cutJob = run(cutFiles, input.cutCommit);
  const baselineJob = baselineFiles.length
    ? run(baselineFiles, input.baselineCommit)
    : Promise.resolve(new Map<string, T>());
  const [cutResult, baselineResult] = await Promise.allSettled([cutJob, baselineJob]);
  const failures: unknown[] = [];
  const cut = checkedResults(cutFiles, cutResult, 'cut', failures);
  const baseline = checkedResults(baselineFiles, baselineResult, 'baseline', failures);
  return { cut, baseline, failures };
}

/** Split cut-failure files into bounded batches, reuse measured baseline rows, and pair only baseline-present misses. */
export async function runPairedIsolatedBatches<T>(input: {
  cutFiles: readonly string[];
  baselineFiles: readonly string[];
  cachedBaseline?: ReadonlyMap<string, T>;
  maxBatchFiles: number;
  cutCommit: string;
  baselineCommit: string;
  runBatch(files: readonly string[], commit: string): Promise<Map<string, T>>;
}): Promise<PairedIsolatedBatches<T>> {
  const cutFiles = [...input.cutFiles];
  const cutSet = new Set(cutFiles);
  const baselineSet = new Set(input.baselineFiles);
  if (!Number.isSafeInteger(input.maxBatchFiles) || input.maxBatchFiles < 1
    || cutSet.size !== cutFiles.length || baselineSet.size !== input.baselineFiles.length
    || [...baselineSet].some((file) => !cutSet.has(file))) throw new Error('invalid paired isolated batches');
  const baseline = new Map(input.cachedBaseline ?? []);
  if ([...baseline.keys()].some((file) => !baselineSet.has(file))) throw new Error('invalid cached paired baseline file');
  const cut = new Map<string, T>();
  const failures: unknown[] = [];
  const groups = Array.from({ length: Math.ceil(cutFiles.length / input.maxBatchFiles) }, (_, index) =>
    cutFiles.slice(index * input.maxBatchFiles, (index + 1) * input.maxBatchFiles));
  for (const files of groups) {
    const baselineFiles = files.filter((file) => baselineSet.has(file) && !baseline.has(file));
    const batch = await runPairedIsolatedBatch({ ...input, cutFiles: files, baselineFiles });
    for (const [file, value] of batch.cut) cut.set(file, value);
    for (const [file, value] of batch.baseline) baseline.set(file, value);
    failures.push(...batch.failures);
  }
  return { cut, baseline, failures, batches: groups.length };
}
