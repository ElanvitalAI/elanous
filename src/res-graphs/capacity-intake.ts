/**
 * RES-CAPACITY-LEASE natural-language intake: «128GB 머신 하나 4시간» → CapacityRequest fields.
 * Capture-time classification by the judge layer into a validated schema (no regex over the prose). A judge answer
 * missing ram or ttl is rejected as unmeasured; the caller then asks for the structured flags instead of guessing.
 */
import { judge } from '../llm/judge-layer.js';
import type { CapacityRequest } from './capacity.js';

export type IntakeCall = (args: { prompt: string; provider: string; model: string }) => Promise<{ text: string }>;
export type IntakeFields = Pick<CapacityRequest, 'ramGiB' | 'ttlMin' | 'count'> & { cpu: number | null; budgetUsd: number | null; urgency: 'normal' | 'urgent'; reason: string | null };

export function validateIntake(value: unknown): IntakeFields | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
  const ramGiB = num(v.ramGiB); const ttlMin = num(v.ttlMin);
  if (ramGiB === null || ttlMin === null || ttlMin > 24 * 60) return null;
  const count = num(v.count) ?? 1;
  if (!Number.isInteger(count) || count > 8) return null;
  return { ramGiB, ttlMin: Math.round(ttlMin), count, cpu: num(v.cpu), budgetUsd: num(v.budgetUsd),
    urgency: v.urgency === 'urgent' ? 'urgent' : 'normal', reason: typeof v.reason === 'string' && v.reason.trim() ? v.reason.trim() : null };
}

export async function classifyCapacityRequest(line: string, call?: IntakeCall): Promise<IntakeFields | null> {
  if (!line.trim()) return null;
  const r = await judge<IntakeFields>({
    site: 'res.capacity-intake',
    // An injected transport (sim/tests) skips role resolution: the caller already owns the model.
    ...(call ? { call, resolveRoleProvider: (() => ({ provider: { name: "injected" }, model: "" })) as unknown as NonNullable<Parameters<typeof judge>[0]["resolveRoleProvider"]> } : {}),
    prompt: 'Extract a machine capacity request from this operator line (Korean or English). Respond with JSON only: '
      + '{"ramGiB":<number, GiB of RAM per machine>,"cpu":<number|null>,"ttlMin":<number, minutes>,"count":<integer machines, default 1>,'
      + '"budgetUsd":<number|null>,"urgency":"normal"|"urgent","reason":<string|null>}. '
      + 'Return {"ramGiB":null} when the line does not state a RAM size or a duration. Do not invent values.\n'
      + `Line: ${JSON.stringify(line)}`,
    schema: validateIntake,
  });
  return r.ok ? r.value : null;
}
