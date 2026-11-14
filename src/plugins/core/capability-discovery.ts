/** Manifest-only discovery metadata. It documents prerequisites; it grants no authority. */
export interface CapabilityRequirementMetadata {
  memberConnection?: boolean;
  appKinds?: Array<'static-export' | 'local-service'>;
  confirmation?: boolean;
}
export interface CapabilityDiscoveryMetadata {
  whenToUse: string;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  examples: string[];
}
// OP49105 requests 1–2 examples; bounded metadata keeps discovery from expanding the prompt without limit.
const MAX_EXAMPLES = 2;
const MAX_FIELDS = 16;
const MAX_TEXT_CHARS = 1024;
const MAX_METADATA_CHARS = 4096;

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_CHARS)
    throw new Error('capability discovery text must be nonempty and bounded');
  return value.trim();
}
function fields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('capability discovery inputs/outputs must be field descriptions');
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_FIELDS) throw new Error('capability discovery fields must be nonempty and bounded');
  return Object.fromEntries(entries.map(([key, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key))
      throw new Error('invalid capability discovery field name');
    return [key, text(value)];
  }));
}
export function parseCapabilityDiscovery(raw: Record<string, unknown>): CapabilityDiscoveryMetadata | undefined {
  // whenToUse opts in; unrelated legacy top-level inputs/examples stay backward compatible.
  if (raw.whenToUse === undefined) return undefined;
  text(raw.description);
  if (!Array.isArray(raw.examples) || raw.examples.length < 1 || raw.examples.length > MAX_EXAMPLES)
    throw new Error('capability discovery requires one or two examples');
  const result = { whenToUse: text(raw.whenToUse), inputs: fields(raw.inputs), outputs: fields(raw.outputs),
    examples: raw.examples.map(text) };
  if (!raw.requires || typeof raw.requires !== 'object' || Array.isArray(raw.requires))
    throw new Error('capability discovery requires an explicit prerequisites object');
  parseCapabilityRequirements(raw.requires as Record<string, unknown>, true);
  if (JSON.stringify({ description: raw.description, ...result, requires: raw.requires }).length > MAX_METADATA_CHARS)
    throw new Error('capability discovery metadata exceeds budget');
  return result;
}
export function parseCapabilityRequirements(raw: Record<string, unknown>, strict = false): CapabilityRequirementMetadata {
  if (strict) {
    const known = new Set(['elanous', 'tools', 'optionalTools', 'optionalPython', 'knowledgePacks',
      'memberConnection', 'appKinds', 'confirmation']);
    if (Object.keys(raw).some(key => !known.has(key))) throw new Error('unknown capability prerequisite field');
    if (raw.elanous !== undefined) text(raw.elanous);
    for (const key of ['tools', 'optionalTools', 'optionalPython', 'knowledgePacks']) {
      if (raw[key] === undefined) continue;
      const values = raw[key];
      if (!Array.isArray(values) || values.length > MAX_FIELDS)
        throw new Error('capability prerequisite lists must be bounded string arrays');
      values.forEach(text);
    }
  }
  for (const key of ['memberConnection', 'confirmation']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
      throw new Error('capability prerequisite flags must be boolean');
  }
  const kinds = raw.appKinds;
  if (kinds !== undefined && (!Array.isArray(kinds) || kinds.length === 0
    || kinds.some(kind => kind !== 'static-export' && kind !== 'local-service')))
    throw new Error('unsupported capability app kind');
  return {
    ...(raw.memberConnection === undefined ? {} : { memberConnection: raw.memberConnection as boolean }),
    ...(raw.confirmation === undefined ? {} : { confirmation: raw.confirmation as boolean }),
    ...(kinds === undefined ? {} : { appKinds: [...new Set(kinds as CapabilityRequirementMetadata['appKinds'])] }),
  };
}
/** Reuse ordinary tool discovery/hydration instead of building an independent authority-bearing index. */
export function withCapabilityDiscoveryDescription(description: string, manifest: Partial<CapabilityDiscoveryMetadata> & {
  requires?: CapabilityRequirementMetadata;
}): string {
  if (!manifest.whenToUse || !manifest.inputs || !manifest.outputs || !manifest.examples) return description;
  return description + '\n\nCapability discovery:\n' + JSON.stringify({
    whenToUse: manifest.whenToUse, inputs: manifest.inputs, outputs: manifest.outputs,
    requires: manifest.requires ?? {}, examples: manifest.examples,
  });
}
