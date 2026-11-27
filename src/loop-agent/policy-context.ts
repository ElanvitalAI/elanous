// LOOP-AGENT v3 — the policy values of the agent that is ticking now (YAML-SUPERVISORS-DEF · 대표 11-27 12:0x «감독자들도 다
// 로직·정책 등을 yaml 로 정의 — 기능을 추출»). A body reads every threshold / window / cap through `pv(name, default)`; the
// runtime sets the compiled agent.yaml `policies:` for the duration of one tick or voice turn (`withPolicies`). No agent.yaml
// (or a refused one) → the defaults written in the body — the v2 behaviour, unchanged.
let current: Readonly<Record<string, number>> = {};

/** The policy `name` of the agent ticking now, else `dflt`. */
export const pv = (name: string, dflt: number): number => {
  const v = current[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
};

/** Run `fn` with `policies` in force (restored afterwards, also on throw). One tick at a time per process. */
export async function withPolicies<T>(policies: Readonly<Record<string, number>> | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = current; current = policies ?? {};
  try { return await fn(); } finally { current = prev; }
}
