import type { AppManifest } from './app-contract.js';

type JsonMap = Record<string, unknown>;

function isMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaForType(type: unknown): JsonMap {
  switch (type) {
    case 'int': return { type: 'integer' };
    case 'number': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'json': return {};
    case 'object-ref': return { type: 'string', format: 'uri-reference', description: '앱 범위 객체 참조' };
    case 'timestamp': return { type: 'string', format: 'date-time' };
    case 'text':
    default: return { type: 'string' };
  }
}

function fieldSchema(definition: unknown): JsonMap {
  if (typeof definition === 'string') return schemaForType(definition);
  const def = isMap(definition) ? definition : {};
  const schema = schemaForType(def.type);
  for (const key of ['minimum', 'maximum', 'min', 'max', 'format', 'description'] as const) {
    const value = def[key];
    if (typeof value === 'string' || typeof value === 'number') {
      schema[key === 'min' ? 'minimum' : key === 'max' ? 'maximum' : key] = value;
    }
  }
  return schema;
}

function objectSchema(fields: unknown): JsonMap {
  const properties: JsonMap = {};
  const required: string[] = [];
  if (isMap(fields)) {
    for (const name of Object.keys(fields).sort()) {
      const definition = fields[name];
      properties[name] = fieldSchema(definition);
      if (!(isMap(definition) && Object.hasOwn(definition, 'default'))) required.push(name);
    }
  }
  return { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) };
}

function securityFor(roles: unknown): unknown[] | undefined {
  if (!Array.isArray(roles) || roles.length === 0) return undefined;
  return roles.filter((role): role is string => typeof role === 'string').sort()
    .map(role => ({ [role]: [] }));
}

function safeName(name: string): string {
  return encodeURIComponent(name).replace(/%/g, '_');
}

/** Build deterministic OpenAPI 3.1 from a validated app contract. It has no filesystem or state access. */
export function appManifestToOpenApi(manifest: AppManifest): JsonMap {
  const paths: JsonMap = {};
  const schemas: JsonMap = {};
  const securitySchemes: JsonMap = {};
  const roles = isMap(manifest.roles) ? manifest.roles : {};

  for (const role of Object.keys(roles).sort()) {
    securitySchemes[role] = {
      type: 'apiKey', in: 'cookie', name: '__Host-app-session',
      description: `앱 역할: ${role}`,
      'x-elanous-role': role,
    };
  }

  const rpc = isMap(manifest.rpc) ? manifest.rpc : {};
  for (const name of Object.keys(rpc).sort()) {
    const declaration = isMap(rpc[name]) ? rpc[name] as JsonMap : {};
    const path = `/rpc/${encodeURIComponent(name)}`;
    const params = objectSchema(declaration.params);
    schemas[`Rpc_${safeName(name)}Request`] = params;
    const operation: JsonMap = {
      operationId: `rpc_${safeName(name)}`,
      summary: `RPC ${name}`,
      'x-elanous-kind': 'rpc',
      'x-elanous-allow': Array.isArray(declaration.allow) ? [...declaration.allow].sort() : [],
      responses: {
        '200': { description: 'RPC 결과', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: '잘못된 입력' }, '403': { description: '허용되지 않은 역할' },
      },
    };
    const security = securityFor(declaration.allow);
    if (security) operation.security = security;
    if (Object.keys(params.properties as JsonMap).length > 0) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/Rpc_${safeName(name)}Request` } } },
      };
    }
    paths[path] = { post: operation };
  }

  const actions = isMap(manifest.actions) ? manifest.actions : {};
  for (const name of Object.keys(actions).sort()) {
    const declaration = isMap(actions[name]) ? actions[name] as JsonMap : {};
    const path = `/actions/${encodeURIComponent(name)}`;
    const input = objectSchema(declaration.input);
    schemas[`Action_${safeName(name)}Request`] = input;
    paths[path] = { post: {
      operationId: `action_${safeName(name)}`,
      summary: `Action ${name}`,
      'x-elanous-kind': 'action',
      'x-elanous-builtin': declaration.builtin,
      'x-elanous-optional': declaration.optional === true,
      'x-elanous-allow': ['owner'],
      security: [{ owner: [] }],
      requestBody: { required: true, content: { 'application/json': {
        schema: { $ref: `#/components/schemas/Action_${safeName(name)}Request` },
      } } },
      responses: {
        '200': { description: '동작 결과', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: '잘못된 입력' }, '403': { description: '소유자 역할 필요' },
      },
    } };
  }

  return {
    openapi: '3.1.0',
    info: { title: manifest.title, version: '0.0.0', description: `Elanous app API contract for ${manifest.slug}` },
    servers: [{ url: `https://${manifest.slug}.app.localhost` }],
    paths,
    components: { schemas, securitySchemes },
  };
}

/** Serialize using a stable, recursive key order for byte-identical output. */
export function serializeOpenApi(spec: unknown): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (!isMap(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  };
  return `${JSON.stringify(stable(spec), null, 2)}\n`;
}
