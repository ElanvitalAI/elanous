type Row = Record<string, unknown>;

const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const strings = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export function resolveAbsorbDesignReference(reference: unknown, outputs: Readonly<Row>): unknown {
  if (typeof reference !== 'string') return undefined;
  const match = /^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/.exec(reference);
  if (!match) return undefined;
  let value: unknown = outputs[match[1]!];
  for (const key of match[2]!.split('.')) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || !Object.hasOwn(row(value), key)) return undefined;
    value = row(value)[key];
  }
  return value;
}

function validateDesignPayload(input: unknown, keyReference: unknown, valueReference: unknown, outputs: Readonly<Row>): string | null {
  const context = row(row(input).context);
  const memberId = context.memberId;
  if (typeof memberId !== 'string' || !memberId) return 'design member owner missing';

  const briefing = row(row(row(outputs.brief).evidence).briefing);
  const requirements = row(row(outputs.requirements).result);
  const requirementEvidence = row(row(outputs.requirements).evidence);
  const designNode = row(outputs.design);
  const design = row(resolveAbsorbDesignReference(valueReference, outputs));
  const key = resolveAbsorbDesignReference(keyReference, outputs);
  const lines = strings(requirements.lines);
  const sourceIds = strings(requirements.scrapIds);
  const collected = strings(briefing.scrapIds);
  // Source: absorb-brief.yaml and the three-line design-input contract require exactly three ordered requirements.
  if (lines.length !== 3 || lines.some(line => !line.trim()) || !same(lines, requirementEvidence.requirements)
    || !same(lines, row(designNode.result).requirementLines) || !same(lines, design.requirementLines))
    return 'design requirements differ from the three source lines';
  if (typeof key !== 'string' || !key || key !== briefing.id || requirements.briefingId !== key
    || requirementEvidence.briefingId !== key || design.briefingId !== key) return 'design briefing reference mismatch';
  if (!sourceIds.length || !same(sourceIds, collected) || !same(sourceIds, requirementEvidence.scrapIds)
    || !same(sourceIds, design.scrapIds) || !same(sourceIds, row(designNode.result).scrapIds))
    return 'design source references differ from briefing';
  if (lines.some(line => {
    const citations = [...line.matchAll(/\[([^\]]+)\]/g)].flatMap(match => match[1]!.split(/[\s,]+/).filter(Boolean));
    return citations.length === 0 || citations.some(id => !sourceIds.includes(id));
  })) return 'design requirement lacks a verified source citation';
  const scraps = row(row(outputs.collect).result).items;
  if (!Array.isArray(scraps) || !sourceIds.every(id => scraps.some(scrap => row(scrap).id === id && row(scrap).owner === memberId)))
    return 'design source is not a collected member scrap';

  const slotRead = row(outputs['load-app-slots']);
  if (row(slotRead.evidence).owner !== memberId) return 'member app slots were not owner-verified';
  const slots = row(slotRead.result).items;
  const slot = Array.isArray(slots) ? slots.map(row).find(candidate => candidate.id === design.appId
    && (candidate.owner === undefined || candidate.owner === memberId)) : undefined;
  if (!slot) return 'design app slot is unavailable for this member';
  const targets = new Set([...strings(slot.screens), ...strings(slot.rpc)]);
  const changes = design.changes;
  if (!Array.isArray(changes) || changes.length !== lines.length
    || !changes.every((change, index) => row(change).requirement === lines[index]
      && targets.has(String(row(change).target))
      && typeof row(change).action === 'string' && (row(change).action as string).trim().length > 0))
    return 'design change does not target the verified app slot and ordered requirement';
  return null;
}

/** Validate model output before suggest consumes its source IDs. */
export function validateAbsorbDesignProposal(input: unknown, outputs: Readonly<Row>): string | null {
  return validateDesignPayload(input, '$brief.evidence.briefing.id', '$design.evidence.design', outputs);
}

/** Fail before dispatching the real store provider for absorb's design-pack write. */
export function validateAbsorbDesignWrite(input: unknown, nodeInput: unknown, outputs: Readonly<Row>): string | null {
  const query = row(nodeInput);
  const memberId = row(row(input).context).memberId;
  if (query.op !== 'upsert' || query.collection !== 'design-packs'
    || query.owner !== memberId || query.ownerScoped !== true)
    return 'owner-scoped design write declaration missing';
  const keyReference = '$brief.evidence.briefing.id';
  const valueReference = '$design.evidence.design';
  if (!same(query.key, resolveAbsorbDesignReference(keyReference, outputs))
    || !same(query.value, resolveAbsorbDesignReference(valueReference, outputs)))
    return 'design write does not match the briefing and design outputs';
  return validateDesignPayload(input, keyReference, valueReference, outputs);
}

/** Validate the persisted design and every suggestion before any suggestion store write. */
export function validateAbsorbSuggestionWrites(input: unknown, nodeInput: unknown, outputs: Readonly<Row>): string | null {
  const query = row(nodeInput);
  const memberId = row(row(input).context).memberId;
  const briefing = row(row(row(outputs.brief).evidence).briefing);
  const persisted = row(row(outputs['load-design']).result);
  const design = row(row(row(outputs.design).evidence).design);
  const requirements = row(row(outputs.requirements).result);
  const lines = strings(requirements.lines);
  const sourceIds = strings(requirements.scrapIds);
  const slots = row(row(outputs['load-app-slots']).result).items;
  const slot = Array.isArray(slots) ? slots.map(row).find(candidate => candidate.id === persisted.appId
    && (candidate.owner === memberId || candidate.owner === undefined)) : undefined;
  if (typeof memberId !== 'string' || !memberId || query.owner !== memberId
    || row(row(outputs['load-design']).evidence).owner !== memberId
    || query.briefingId !== briefing.id || persisted.briefingId !== briefing.id
    || !same(query.design, persisted) || !same(persisted, { ...design, owner: memberId })
    || !same(lines, persisted.requirementLines) || lines.length !== 3
    || !same(sourceIds, persisted.scrapIds) || !same(sourceIds, briefing.scrapIds)
    || !slot || persisted.appId !== slot.id)
    return 'suggestion source design, owner, briefing, requirements, or app slot mismatch';
  const suggestions = query.suggestions;
  if (!Array.isArray(suggestions) || suggestions.length < 1 || suggestions.length > 3) return 'suggestion count invalid';
  const existingRead = row(outputs['load-existing-suggestions']);
  const existingItems = row(existingRead.result).items;
  if (row(existingRead.evidence).owner !== memberId || !Array.isArray(existingItems)
    || existingItems.some(item => row(item).owner !== memberId))
    return 'existing suggestions were not owner-verified';
  const existingById = new Map<string, Row>();
  for (const item of existingItems) {
    const existing = row(item);
    if (typeof existing.id !== 'string' || existingById.has(existing.id)) return 'existing suggestion IDs are invalid';
    existingById.set(existing.id, existing);
  }
  const ids = new Set<string>();
  for (const value of suggestions) {
    const suggestion = row(value);
    const id = suggestion.id;
    if (typeof id !== 'string' || !id.trim() || ids.has(id)
      || suggestion.owner !== memberId || suggestion.briefingId !== briefing.id
      || suggestion.designPackId !== briefing.id || suggestion.appId !== slot.id
      || !same(suggestion.requirementLines, lines) || !same(suggestion.evidenceScrapIds, sourceIds)
      || typeof suggestion.ask !== 'string' || !suggestion.ask.trim()
      || typeof suggestion.change !== 'string' || !suggestion.change.trim())
      return 'suggestion does not bind to the stored owner design and sources';
    const citations = [...(suggestion.change as string).matchAll(/\[([^\]]+)\]/g)]
      .flatMap(match => match[1]!.split(/[\s,]+/).filter(Boolean));
    if (citations.length === 0 || citations.some(id => !sourceIds.includes(id)))
      return 'suggestion cites a source outside the stored briefing';
    const previous = existingById.get(id);
    if (previous && (previous.briefingId !== briefing.id || previous.designPackId !== briefing.id
      || previous.appId !== slot.id || !same(previous.evidenceScrapIds, sourceIds)
      || !same(previous.requirementLines, lines)))
      return 'suggestion ID collides with another stored briefing or design';
    ids.add(id);
  }
  return null;
}
