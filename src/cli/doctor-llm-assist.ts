import { redactSecretText } from '../debug/log.js';
import type { ReadinessReport } from './doctor-readiness.js';
import type { DoctorFixItem, DoctorFixPlan } from './doctor-fix.js';

// Only tool/runtime installs are model-selectable; startup files, service units, installed code and credential stores are not.
export const ADVISABLE_DOCTOR_FIX_IDS: ReadonlySet<DoctorFixItem['id']> = new Set([
  'python-env', 'static-tools', 'python-managed',
]);

export interface DoctorAdvice {
  ok: boolean;
  reason?: string;
  summary: string;
  order: Array<{ readinessId: string; fixId?: DoctorFixItem['id'] | 'git-install'; why: string }>;
  manual: string[];
  dropped: number;
}

/** The model ranks known repairs; it never supplies a command or an executable action. */
export async function adviseDoctorFixes({ report, plan, llm, locale = 'en', timeoutMs = 60_000 }: {
  report: ReadinessReport;
  plan: DoctorFixPlan;
  llm?: (prompt: string) => Promise<string>;
  locale?: 'en' | 'ko' | 'ja' | 'zh';
  timeoutMs?: number;
}): Promise<DoctorAdvice> {
  const empty = (reason: string): DoctorAdvice => ({ ok: false, reason, summary: '', order: [], manual: [], dropped: 0 });
  if (!llm) return empty('LLM unavailable');
  const language = { en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' }[locale];
  const prompt = JSON.stringify({
    instruction: `Read-only diagnosis. Return only JSON: {"summary":"...","order":[{"readinessId":"...","fixId":"optional catalog id or git-install","why":"..."}],"manual":["..."]}. Choose fixId only from the supplied repair plan or git-install. Never return shell commands. Do not execute anything. Write summary, why and manual in ${language}. Keep JSON keys and repair ids in English.`,
    readiness: report.items.map(({ id, status, evidence, remedy }) => ({ id: redactSecretText(id), status, evidence: redactSecretText(evidence), ...(remedy === undefined ? {} : { remedy: redactSecretText(remedy) }) })),
    plan: plan.items.map(({ id, action, status }) => ({ id, action: redactSecretText(action), status })),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => llm(prompt)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return empty('invalid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty('invalid JSON shape');
    const value = parsed as Record<string, unknown>;
    if (typeof value.summary !== 'string' || !Array.isArray(value.order) || !Array.isArray(value.manual) || !value.manual.every((line: unknown) => typeof line === 'string')) return empty('invalid JSON shape');
    const ids: ReadonlySet<string> = new Set(plan.items.filter((item) => item.status === 'fixable' && ADVISABLE_DOCTOR_FIX_IDS.has(item.id)).map((item) => item.id));
    const readinessIds = new Set(report.items.map((item) => item.id));
    const seenReadiness = new Set<string>();
    const seenFix = new Set<string>();
    let dropped = 0;
    const order: DoctorAdvice['order'] = [];
    for (const candidate of value.order as unknown[]) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { dropped++; continue; }
      const { readinessId, fixId, why } = candidate as Record<string, unknown>;
      if (typeof readinessId !== 'string' || !readinessIds.has(readinessId) || typeof why !== 'string'
        || (fixId !== undefined && (typeof fixId !== 'string' || (fixId !== 'git-install' && !ids.has(fixId))))
        || seenReadiness.has(readinessId) || (typeof fixId === 'string' && seenFix.has(fixId))) {
        dropped++;
        continue;
      }
      seenReadiness.add(readinessId);
      if (typeof fixId === 'string') seenFix.add(fixId);
      order.push({ readinessId, ...(fixId === undefined ? {} : { fixId: fixId as DoctorFixItem['id'] | 'git-install' }), why: redactSecretText(why) });
    }
    return { ok: true, summary: redactSecretText(value.summary), order, manual: value.manual.map((line: string) => redactSecretText(line)), dropped };
  } catch {
    return empty('LLM failed or timed out');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
