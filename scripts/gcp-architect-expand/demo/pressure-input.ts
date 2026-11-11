/** Accept the existing host/queue observation or an explicit synthetic demo fixture. */
import type { LocalPressure } from '../../../src/ux-sim/gcp-architect-expand/local-signals.js';

type Fixture = { cpuUsed: number; memoryUsed: number; diskUsed: number; queued: number; observedAt: string; source: string };
export type ProposalPressure = Fixture | LocalPressure;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const rate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function validateProposalPressure(raw: unknown, options: { requireShortage?: boolean } = {}):
  { signal: ProposalPressure; shortage: string[]; source: string } {
  const signal = record(raw);
  if (!signal || !validDate(signal.observedAt)) throw new Error('capacity observation time is invalid');
  const names = ['cpu', 'memory', 'disk', 'queue'] as const;
  if (names.every(name => record(signal[name]) !== null)) {
    const axes = names.map(name => ({ name, axis: record(signal[name])! }));
    for (const { name, axis } of axes) {
      if (!['shortage', 'sufficient'].includes(String(axis.status)) || !nonnegative(axis.observed) ||
          typeof axis.source !== 'string' || !axis.source.trim() || (name === 'queue' && !Number.isInteger(axis.observed)))
        throw new Error(`existing ${name} observation is unknown or invalid`);
    }
    if (typeof signal.shortage !== 'boolean') throw new Error('existing shortage flag is invalid');
    const shortage = axes.filter(({ axis }) => axis.status === 'shortage').map(({ name }) => name);
    if (signal.shortage !== (shortage.length > 0)) throw new Error('existing shortage flag disagrees with axes');
    if (!shortage.length && options.requireShortage !== false) throw new Error('no capacity shortage; no expansion proposal');
    return { signal: raw as LocalPressure, shortage, source: 'existing-self-dev-and-harness-queue' };
  }
  if (!rate(signal.cpuUsed) || !rate(signal.memoryUsed) || !rate(signal.diskUsed) ||
      typeof signal.queued !== 'number' || !Number.isInteger(signal.queued) || signal.queued < 0 ||
      typeof signal.source !== 'string' || !signal.source.trim()) throw new Error('invalid synthetic capacity observation');
  const shortage = [signal.cpuUsed >= 0.85 && 'cpu', signal.memoryUsed >= 0.85 && 'memory',
    signal.diskUsed >= 0.9 && 'disk', signal.queued >= 10 && 'queue'].filter(Boolean) as string[];
  if (!shortage.length && options.requireShortage !== false) throw new Error('no capacity shortage; no expansion proposal');
  return { signal: raw as Fixture, shortage, source: signal.source };
}
