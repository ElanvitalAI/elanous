/** Resolve whole-value Graph v2 bindings for capability-node input payloads. */
export function bindGraphV2NodeInput(
  nodeInput: unknown,
  graphInput: unknown,
  outputs: Readonly<Record<string, unknown>>,
): unknown {
  const root = graphInput && typeof graphInput === 'object' && !Array.isArray(graphInput)
    ? graphInput as Record<string, unknown> : {};
  const resolvePath = (value: unknown, path: string, reference: string): unknown => {
    let current = value;
    for (const part of path.split('.')) {
      if (['__proto__', 'prototype', 'constructor'].includes(part) || current === null
        || typeof current !== 'object' || !Object.hasOwn(current, part)) {
        throw new Error(`unbound graph input reference: ${reference}`);
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (current === undefined) throw new Error(`unbound graph input reference: ${reference}`);
    return current;
  };
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value === '$input') {
        if (graphInput === undefined) throw new Error(`unbound graph input reference: ${value}`);
        return graphInput;
      }
      const reference = /^\$(input|context|[a-z][a-z0-9-]*)(?:\.([A-Za-z_][A-Za-z0-9_.]*))?$/.exec(value);
      if (!reference) return value;
      const [, source, path] = reference;
      if (source === 'input') return path ? resolvePath(root, path, value) : graphInput;
      if (source === 'context') {
        if (!Object.hasOwn(root, 'context') || root.context === undefined || root.context === null)
          throw new Error(`unbound graph input reference: ${value}`);
        return path ? resolvePath(root.context, path, value) : root.context;
      }
      const localInput = nodeInput && typeof nodeInput === 'object' && !Array.isArray(nodeInput)
        ? nodeInput as Record<string, unknown> : {};
      if (Object.hasOwn(outputs, source!)) {
        const output = outputs[source!];
        if (output === undefined) throw new Error(`unbound graph output reference: ${value}`);
        return path ? resolvePath(output, path, value) : output;
      }
      if (Object.hasOwn(localInput, source!)) {
        const local = localInput[source!];
        if (local === undefined) throw new Error(`unbound graph input reference: ${value}`);
        return path ? resolvePath(local, path, value) : local;
      }
      throw new Error(`unbound graph output reference: ${value}`);
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, visit(item)]),
    );
    return value;
  };
  return visit(nodeInput);
}

/** Bind a declared store write and seal only its owner-scoped payload for dispatch. */
export function bindGraphV2StoreWriteInput(
  nodeInput: unknown,
  graphInput: unknown,
  outputs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const bound = bindGraphV2NodeInput(nodeInput, graphInput, outputs);
  if (!bound || typeof bound !== 'object' || Array.isArray(bound)) throw new Error('invalid graph store write input');
  const input = bound as Record<string, unknown>;
  const context = graphInput && typeof graphInput === 'object' && !Array.isArray(graphInput)
    ? (graphInput as Record<string, unknown>).context : undefined;
  const memberId = context && typeof context === 'object' && !Array.isArray(context)
    ? (context as Record<string, unknown>).memberId : undefined;
  if (typeof memberId !== 'string' || !memberId || input.owner !== memberId || input.ownerScoped !== true
    || !['create', 'upsert', 'append', 'write'].includes(String(input.op))
    || typeof input.collection !== 'string' || !input.collection || input.value === undefined
    || (input.op === 'upsert' && (typeof input.key !== 'string' || !input.key)))
    throw new Error('invalid owner-scoped graph store write');
  const fields = ['op', 'collection', 'owner', 'key', 'value', 'ownerScoped', 'status'] as const;
  const payload = Object.fromEntries(fields.filter(field => Object.hasOwn(input, field)).map(field => [field, input[field]]));
  return { ...payload, __validatedWrite: Object.hasOwn(input, '__validatedWrite')
    ? input.__validatedWrite : structuredClone(payload) };
}
