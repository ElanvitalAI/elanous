import { parseTimedOutFailures } from './gate-diff';

/** A timeout-shaped head failure is not attributable to the change when the same test cannot run at base. */
export function baselineUnmeasurableTimeoutIds(run: { output: string }, ids: readonly string[]): string[] {
  const unmeasurable = new Set(parseTimedOutFailures(run.output));
  let file: string | undefined;
  for (const line of run.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):(?:\s|$)/.exec(line.trim());
    if (header) { file = header[1]; continue; }
    const skipped = /^\(skip(?:ped)?\)[ \t]+(.+?)(?:[ \t]+\[[\d.]+(?:ms|s)\])?[ \t]*$/.exec(line.trim());
    if (skipped && file) unmeasurable.add(`${file} > ${skipped[1]!.trim()}`);
  }
  return ids.filter((id) => unmeasurable.has(id));
}
