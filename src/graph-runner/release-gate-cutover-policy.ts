/** Select the gate route from a run's pinned input, including dry-run previews. */
export function releaseGateCutoverPath(input: unknown): 'legacy' | 'audit' {
  const value = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const mode = value.graphCutover ?? 'legacy';
  if (mode !== 'legacy' && mode !== 'audit') throw new Error('release graph cutover policy must be legacy or audit');
  if (mode === 'audit' && (typeof value.graphCutoverEvidenceId !== 'string' || !value.graphCutoverEvidenceId.trim()))
    throw new Error('audit route requires OP decision evidence');
  return mode;
}
