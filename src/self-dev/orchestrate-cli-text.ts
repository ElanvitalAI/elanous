/** Shared, dependency-free text rules for both orchestrate CLI entrances. */
export function splitOrchestrateGoalTexts(parts: readonly string[]): string[] {
  const joined = parts.join(' ');
  return (joined.includes(';;') ? joined.split(';;') : parts).map((goal) => goal.trim()).filter(Boolean);
}

export function normalizeOrchestrateRequest(input: readonly string[] | string): string {
  const joined = typeof input === 'string' ? input : input.join(' ');
  return joined.replace(/;;/g, ' ').trim();
}
