// Pure, deliberately bounded JSON Schema subset for workflow node configuration.
export type SchemaFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export interface SchemaField {
  /** Dot-separated object keys; [] marks an array item schema. */
  path: string;
  type: SchemaFieldType;
  label: string;
  description?: string;
  required: boolean;
  default?: unknown;
  enum?: unknown[];
  multiline: boolean;
  secret: boolean;
}

export interface FlattenedSchema {
  fields: SchemaField[];
  /** Keyword locations (e.g. `credentials.oneOf`); not silently enforced. */
  unsupported: string[];
}

export interface SchemaValidationError {
  path: string;
  message: string;
}

/** A string field renders as a multi-line box when the schema says so (`format: textarea|multiline|markdown`,
 *  `x-multiline: true`) or when its key/title names a body of text (markdown · 본문 · body · text) —
 *  a one-line `<input>` silently drops the line breaks of a Markdown body (K3 실물 2026-09-30). */
function isMultilineString(kind: SchemaFieldType | null, node: Record<string, unknown>, path: string): boolean {
  if (node.format === 'textarea' || node.format === 'multiline' || node.format === 'markdown' || node['x-multiline'] === true) return true;
  if (kind !== 'string' || Array.isArray(node.enum) || node.format === 'password' || node.format === 'secret' || node.writeOnly === true) return false;
  const key = path.split('.').at(-1) ?? '';
  const title = typeof node.title === 'string' ? node.title : '';
  return /markdown|body|text/i.test(key) || /markdown|본문/i.test(title);
}

const MAX_DEPTH = 6;
const KEYWORDS = new Set([
  'type', 'title', 'description', 'default', 'enum', 'format', 'writeOnly', 'x-multiline',
  'properties', 'required', 'items', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'minItems', 'maxItems',
]);
const TYPES = new Set<SchemaFieldType>(['string', 'number', 'integer', 'boolean', 'object', 'array']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function fieldType(schema: Record<string, unknown>): SchemaFieldType | null {
  const type = schema.type;
  return typeof type === 'string' && TYPES.has(type as SchemaFieldType)
    ? type as SchemaFieldType
    : null;
}

function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function equalJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => equalJsonValue(entry, right[index]));
  }
  const leftObject = record(left);
  const rightObject = record(right);
  if (!leftObject || !rightObject) return false;
  const keys = Object.keys(leftObject);
  return keys.length === Object.keys(rightObject).length
    && keys.every((key) => Object.hasOwn(rightObject, key)
      && equalJsonValue(leftObject[key], rightObject[key]));
}

/** Root is depth 0; nodes at depth 6 are inspected but their children are not visited. */
export function flattenSchema(schema: unknown): FlattenedSchema {
  const fields: SchemaField[] = [];
  const unsupported: string[] = [];
  const ancestors = new Set<object>();

  function visit(raw: unknown, path: string, depth: number, required: boolean): void {
    const node = record(raw);
    if (!node) {
      unsupported.push(path || '(root)');
      return;
    }
    if (ancestors.has(node)) {
      unsupported.push(path || '(root)');
      return;
    }
    ancestors.add(node);
    for (const keyword of Object.keys(node)) {
      if (!KEYWORDS.has(keyword)) unsupported.push(childPath(path, keyword));
    }
    const type = fieldType(node);
    if (node.type !== undefined && !type) unsupported.push(childPath(path, 'type'));
    const fieldKind = type ?? (node.type === undefined
      ? record(node.properties) || Array.isArray(node.required) ? 'object' : node.items !== undefined ? 'array' : null
      : null);
    if (path && fieldKind) {
      fields.push({
        path,
        type: fieldKind,
        label: typeof node.title === 'string' ? node.title : path.split('.').at(-1)!,
        ...(typeof node.description === 'string' ? { description: node.description } : {}),
        required,
        ...(Object.hasOwn(node, 'default') ? { default: node.default } : {}),
        ...(Array.isArray(node.enum) ? { enum: [...node.enum] } : {}),
        multiline: isMultilineString(fieldKind, node, path),
        secret: node.format === 'password' || node.format === 'secret' || node.writeOnly === true,
      });
    }
    if (depth < MAX_DEPTH) {
      if ((type === 'object' || node.type === undefined) && record(node.properties)) {
        const requiredNames = new Set(Array.isArray(node.required) ? node.required : []);
        for (const [name, value] of Object.entries(node.properties as Record<string, unknown>)) {
          visit(value, childPath(path, name), depth + 1, requiredNames.has(name));
        }
      }
      if ((type === 'array' || node.type === undefined) && node.items !== undefined) {
        visit(node.items, `${path}[]`, depth + 1, false);
      }
    }
    ancestors.delete(node);
  }

  visit(schema, '', 0, false);
  return { fields, unsupported };
}

/** Validate only supported constraints; unknown keywords are reported by flattenSchema. */
export function validateSchemaValue(schema: unknown, value: unknown): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  const ancestors = new Set<object>();

  function visit(raw: unknown, current: unknown, path: string, depth: number): void {
    const node = record(raw);
    if (!node || ancestors.has(node)) return;
    ancestors.add(node);
    const type = fieldType(node);
    if (type) {
      const matches = type === 'object' ? record(current) !== null
        : type === 'array' ? Array.isArray(current)
        : type === 'integer' ? typeof current === 'number' && Number.isInteger(current)
        : type === 'number' ? typeof current === 'number' && Number.isFinite(current)
        : typeof current === type;
      if (!matches) {
        errors.push({ path, message: `Must be ${type === 'integer' ? 'an integer' : `a ${type}`}.` });
        ancestors.delete(node);
        return;
      }
    }
    if (Array.isArray(node.enum) && !node.enum.some((option) => equalJsonValue(option, current))) {
      errors.push({ path, message: 'Must be one of the allowed values.' });
    }
    if (typeof current === 'string') {
      const length = Array.from(current).length;
      if (typeof node.minLength === 'number' && length < node.minLength) {
        errors.push({ path, message: `Must have at least ${node.minLength} characters.` });
      }
      if (typeof node.maxLength === 'number' && length > node.maxLength) {
        errors.push({ path, message: `Must have at most ${node.maxLength} characters.` });
      }
      if (typeof node.pattern === 'string') {
        try {
          if (!new RegExp(node.pattern).test(current)) errors.push({ path, message: 'Does not match the required pattern.' });
        } catch {
          // An invalid schema pattern cannot impose a constraint on the value.
        }
      }
    }
    if (typeof current === 'number') {
      if (typeof node.minimum === 'number' && current < node.minimum) {
        errors.push({ path, message: `Must be at least ${node.minimum}.` });
      }
      if (typeof node.maximum === 'number' && current > node.maximum) {
        errors.push({ path, message: `Must be at most ${node.maximum}.` });
      }
    }
    if (Array.isArray(current)) {
      if (typeof node.minItems === 'number' && current.length < node.minItems) {
        errors.push({ path, message: `Must have at least ${node.minItems} items.` });
      }
      if (typeof node.maxItems === 'number' && current.length > node.maxItems) {
        errors.push({ path, message: `Must have at most ${node.maxItems} items.` });
      }
    }
    const object = record(current);
    if (object && (type === 'object' || node.type === undefined)) {
      if (Array.isArray(node.required)) {
        for (const name of node.required) {
          if (typeof name === 'string' && (!Object.hasOwn(object, name) || object[name] === undefined)) {
            errors.push({ path: childPath(path, name), message: 'Required.' });
          }
        }
      }
      if (depth < MAX_DEPTH) {
        const properties = record(node.properties);
        if (properties) {
          for (const [name, child] of Object.entries(properties)) {
            if (Object.hasOwn(object, name) && object[name] !== undefined) {
              visit(child, object[name], childPath(path, name), depth + 1);
            }
          }
        }
      }
    }
    if (depth < MAX_DEPTH && (type === 'array' || node.type === undefined)
      && Array.isArray(current) && node.items !== undefined) {
      current.forEach((item, index) => visit(node.items, item, `${path}[${index}]`, depth + 1));
    }
    ancestors.delete(node);
  }

  visit(schema, value, '', 0);
  return errors;
}
