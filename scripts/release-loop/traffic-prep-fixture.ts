// RELEASE-TRAFFIC-PREP-T1H test support: tests that drive the real cut-branch node first apply the real T-1h prep
// step against their own throwaway traffic file, exactly as the operator does before a run (no bypass).
// This module is imported only by test files.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTrafficPrep, TRAFFIC_PREP_LEAD_MS, type TrafficPrepReceipt } from './traffic-prep.js';

/** Applies the prep inside its window (cutAt = now + half the lead) under `root` and returns the receipt. */
export async function writeValidTrafficPrep(root: string, version: string, now = new Date()): Promise<TrafficPrepReceipt> {
  const trafficFile = join(root, `traffic-prep-${version}.json`);
  writeFileSync(trafficFile, `${JSON.stringify({ global: 'green', seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map((seat) => [seat, {}])) })}\n`);
  const result = await runTrafficPrep({ version, cutAt: new Date(now.getTime() + TRAFFIC_PREP_LEAD_MS / 2).toISOString() },
    { root, now: () => now, traffic: { trafficFile }, schedule: () => null, baseSha: () => null });
  if (!result.ok) throw new Error(`traffic-prep fixture failed: ${result.reason} ${result.detail}`);
  return result.receipt;
}
