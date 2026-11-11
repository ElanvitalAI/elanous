import { isRecord } from '../../primitives/guards.js';
import { isMap, isScalar, parseDocument } from 'yaml';
import { validateAppSimulation } from './app-simulate.js';

export interface AppContractIssue {
  /** `/rpc/@entry:N` and `/actions/@entry:N` identify the Nth YAML map entry; map keys are never emitted. */
  readonly path: string;
  readonly reason: string;
}

export interface AppManifest {
  readonly apiVersion: 'elanous.app/v0';
  readonly slug: string;
  readonly title: string;
  readonly storage?: AppStorageDeclaration;
  readonly [key: string]: unknown;
}

export interface AppStorageDeclaration {
  readonly prefix: string;
  readonly quotaBytes?: number;
  readonly upload?: {
    readonly allow: readonly string[];
    readonly types: readonly string[];
    readonly maxBytes?: number;
    readonly anonymous?: boolean;
  };
}

export type AppManifestParseResult =
  | { readonly ok: true; readonly manifest: AppManifest; readonly warnings: readonly AppContractIssue[] }
  | { readonly ok: false; readonly errors: readonly AppContractIssue[] };

type RecordValue = Record<string, unknown>;
type SqlToken = { readonly type: 'word' | 'param' | 'string' | 'symbol'; readonly value: string };

const TOP_LEVEL_KEYS = new Set([
  'apiVersion', 'slug', 'title', 'template', 'design', 'frontend', 'tables', 'roles',
  'rpc', 'actions', 'storage', 'credentials', 'origin',
  'simulate',
]);
// Host-name reservation examples named by 내부 문서 `nexus-backend-in-a-box` §③b.
const RESERVED_SLUGS = new Set(['www', 'docs', 'api', 'admin', 'relay', 'mail']);
const BUILTINS = new Set(['stt', 'summarize', 'tts', 'generate', 'translate', 'extract']);
const ACTION_IO_CONTRACTS = {
  extract: {
    input: { required: { url: 'text' }, optional: {} },
    output: { required: { url: 'text', title: 'text', excerpt: 'text', content: 'text', provider: 'text' }, optional: {} },
  },
  stt: {
    input: { required: { audio: 'object-ref' }, optional: { language: 'text' } },
    output: { required: { text: 'text' }, optional: { language: 'text', durationMs: 'number' } },
  },
  summarize: {
    input: { required: { text: 'text' }, optional: {} },
    output: { required: { text: 'text' }, optional: {} },
  },
  tts: {
    input: { required: { text: 'text', voiceId: 'text' }, optional: { modelId: 'text' } },
    output: { required: { audioBase64: 'text', mimeType: 'text' }, optional: {} },
  },
  translate: {
    input: { required: { text: 'text', sourceLanguage: 'text', targetLanguage: 'text' }, optional: {} },
    output: { required: { text: 'text' }, optional: {} },
  },
} as const;
const DDL_WORDS = new Set(['CREATE', 'DROP', 'ALTER', 'ATTACH', 'PRAGMA']);
const SQL_TABLE_KEYWORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE']);

// OP #76053 (APP-CONTRACT-SECRET-ENTROPY): retain known key prefixes and add a conservative
// length/entropy classifier calibrated against the synthetic corpus device.
const CREDENTIAL_VALUE_PREFIXES = ['sk-', 'xai-', 'ghp_', 'gho_', 'github_pat_', 'AKIA', 'AIza', 'xoxb-'] as const;
const CREDENTIAL_VALUE_MIN_LENGTH = 32;
const CREDENTIAL_VALUE_MIN_ENTROPY = 4.25;

function shannonEntropy(value: string): number {
  const symbols = [...value];
  if (symbols.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / symbols.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMimeType(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value);
}

function push(errors: AppContractIssue[], path: string, reason: string): void {
  errors.push({ path, reason });
}

function validateActionIo(
  raw: RecordValue,
  path: string,
  field: 'input' | 'output',
  contract: { readonly required: Readonly<Record<string, string>>; readonly optional: Readonly<Record<string, string>> },
  errors: AppContractIssue[],
): void {
  const value = raw[field];
  if (!isRecord(value)) {
    push(errors, `${path}/${field}`, `${field} 는 내장 동작 계약 맵이어야 한다`);
    return;
  }
  for (const [key, type] of Object.entries(contract.required)) {
    if (!Object.hasOwn(value, key)) push(errors, `${path}/${field}`, `${field} 필수 필드가 빠졌다`);
    else if (value[key] !== type) push(errors, `${path}/${field}`, `${field} 필드 형식이 실행 계약과 다르다`);
  }
  for (const [key, type] of Object.entries(contract.optional)) {
    if (Object.hasOwn(value, key) && value[key] !== type) push(errors, `${path}/${field}`, `${field} 필드 형식이 실행 계약과 다르다`);
  }
  if (Object.keys(value).some(key => !Object.hasOwn(contract.required, key) && !Object.hasOwn(contract.optional, key))) {
    push(errors, `${path}/${field}`, `${field} 에 실행 계약에 없는 필드가 있다`);
  }
}

function mapEntryPath(parent: string, index: number): string {
  // Map names are caller-controlled and may themselves be secrets. An explicit ordinal locator avoids
  // exposing any name and cannot collide with a literal key such as "redacted-key-0".
  return `${parent}/@entry:${index}`;
}

function orderedMapKeys(root: unknown, field: string): string[] | undefined {
  if (!isMap(root)) return undefined;
  const fieldPair = root.items.find(pair => isScalar(pair.key) && pair.key.value === field);
  if (!fieldPair || !isMap(fieldPair.value)) return undefined;
  return fieldPair.value.items
    .filter(pair => isScalar(pair.key))
    .map(pair => String((pair.key as { value: unknown }).value));
}

function credentialLike(value: string): boolean {
  const lower = value.toLowerCase();
  return CREDENTIAL_VALUE_PREFIXES.some(prefix => lower.includes(prefix.toLowerCase()))
    || (!isCredentialReference(value)
      && [...value].length >= CREDENTIAL_VALUE_MIN_LENGTH
      && shannonEntropy(value) >= CREDENTIAL_VALUE_MIN_ENTROPY);
}

function isCredentialReference(value: unknown): value is string {
  return typeof value === 'string' && /^cred:[a-z0-9][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9_-]*$/.test(value);
}

function tokenizeSql(sql: string): SqlToken[] | undefined {
  const tokens: SqlToken[] = [];
  for (let i = 0; i < sql.length;) {
    const char = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(char)) { i++; continue; }
    if (char === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return undefined;
      i = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      const quoteStart = i;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        // SQLite does not treat backslash as a quote escape; only doubled quote characters escape quotes.
        i++;
      }
      if (!closed) return undefined;
      if (quote === "'") tokens.push({ type: 'string', value: 'quoted' });
      else tokens.push({ type: 'word', value: sql.slice(quoteStart + 1, i - 1) });
      continue;
    }
    if (char === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) return undefined;
      tokens.push({ type: 'word', value: sql.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (char === ':') {
      const match = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (!match) return undefined;
      tokens.push({ type: 'param', value: match[1]! });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))!;
      tokens.push({ type: 'word', value: match[0] });
      i += match[0].length;
      continue;
    }
    if (char === ';') { tokens.push({ type: 'symbol', value: ';' }); i++; continue; }
    if (char === '|' && next === '|') { tokens.push({ type: 'symbol', value: '||' }); i += 2; continue; }
    if (char === '?' || char === '$' || char === '@') return undefined;
    tokens.push({ type: 'symbol', value: char });
    i++;
  }
  return tokens;
}

function fromCommaTablesAreDeclared(tokens: SqlToken[], fromIndex: number, knownTables: Set<string>): boolean {
  let depth = 0;
  for (let cursor = fromIndex + 1; cursor < tokens.length; cursor++) {
    const current = tokens[cursor]!;
    if (current.value === '(') depth++;
    else if (current.value === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && current.type === 'word' && ['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION', 'RETURNING'].includes(current.value.toUpperCase())) break;
    else if (depth === 0 && current.value === ',') {
      const relation = tokens[cursor + 1];
      if (!relation) return false;
      if (relation.value === '(') {
        const first = tokens[cursor + 2];
        if (first?.type !== 'word' || !['SELECT', 'WITH'].includes(first.value.toUpperCase())) return false;
      } else if (relation.type !== 'word' || !knownTables.has(relation.value.toLowerCase()) || tokens[cursor + 2]?.value === '.') {
        return false;
      }
    }
  }
  return true;
}

function sqlIsSafe(sql: string, params: unknown, declaredTables: Set<string>): boolean {
  const tokens = tokenizeSql(sql);
  if (!tokens || !tokens.some(token => token.type === 'word')) return false;

  const semicolons = tokens.filter(token => token.value === ';');
  if (semicolons.length > 1 || (semicolons.length === 1 && tokens[tokens.length - 1]?.value !== ';')) return false;

  const words = tokens.filter(token => token.type === 'word').map(token => token.value.toUpperCase());
  if (words.some(word => DDL_WORDS.has(word))) return false;
  const allowedStatements = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
  const firstStatement = words[0];
  let mainStatement = firstStatement;
  if (firstStatement === 'WITH') {
    let depth = 0;
    for (const token of tokens) {
      if (token.value === '(') depth++;
      else if (token.value === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0 && token.type === 'word' && allowedStatements.has(token.value.toUpperCase())) mainStatement = token.value.toUpperCase();
    }
  }
  if (!mainStatement || !allowedStatements.has(mainStatement)) return false;
  if (tokens.some(token => token.value === '||')) return false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.value === '+' && (tokens[i - 1]?.type === 'string' || tokens[i + 1]?.type === 'string')) return false;
  }

  const declaredParams = isRecord(params) ? new Set(Object.keys(params)) : new Set<string>();
  if (tokens.some(token => token.type === 'param' && !declaredParams.has(token.value))) return false;

  const knownTables = new Set([...declaredTables].map(name => name.toLowerCase()));
  for (let i = 0; i < tokens.length; i++) {
    const token: SqlToken = tokens[i]!;
    if (token.type !== 'word' || !SQL_TABLE_KEYWORDS.has(token.value.toUpperCase())) continue;
    if (token.value.toUpperCase() === 'FROM' && !fromCommaTablesAreDeclared(tokens, i, knownTables)) return false;
    const tableIndex = token.value.toUpperCase() === 'UPDATE'
      && tokens[i + 1]?.value.toUpperCase() === 'OR' && tokens[i + 2]?.value.toUpperCase() === 'REPLACE'
      ? i + 3
      : i + 1;
    const table = tokens[tableIndex];
    if (!table) continue;
    if (table.value === '(') {
      // Derived tables must be a query; a parenthesized bare table name is not a declaration bypass.
      const first = tokens[i + 2];
      if (first?.type !== 'word' || !['SELECT', 'WITH'].includes(first.value.toUpperCase())) return false;
      continue;
    }
    if (table.type !== 'word') continue;
    let tableName = table.value;
    if (tokens[tableIndex + 1]?.value === '.') return false; // app tables are local, unqualified names
    if (!knownTables.has(tableName.toLowerCase())) return false;
  }
  return true;
}

function sqlIsReadOnly(sql: string): boolean {
  const tokens = tokenizeSql(sql);
  if (!tokens) return false;
  const words = tokens.filter(token => token.type === 'word').map(token => token.value.toUpperCase());
  return (words[0] === 'SELECT' || words[0] === 'WITH')
    && !words.some(word => ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(word));
}

function validateCredentialList(value: unknown, path: string, errors: AppContractIssue[], mustBeArray: boolean): void {
  if (!Array.isArray(value)) {
    if (mustBeArray || value !== undefined) push(errors, path, '자격은 cred:<슬롯> 이름 목록이어야 한다');
    return;
  }
  value.forEach((entry, index) => {
    const at = `${path}/${index}`;
    if (typeof entry === 'string' && credentialLike(entry)) {
      push(errors, at, '자격 값은 app.yaml 에 넣을 수 없다 → cred:<슬롯> 으로');
    } else if (!isCredentialReference(entry)) {
      push(errors, at, '자격은 cred:<슬롯> 이름이어야 한다');
    }
  });
}

function validateManifest(
  doc: RecordValue,
  existingSlugs: Iterable<string>,
  rpcKeys?: readonly string[],
  actionKeys?: readonly string[],
): { errors: AppContractIssue[]; warnings: AppContractIssue[] } {
  const errors: AppContractIssue[] = [];
  const warnings: AppContractIssue[] = [];
  let unknownTopLevelIndex = 0;
  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push({ path: `/unknownTopLevelKeys/${unknownTopLevelIndex++}`, reason: 'v0 에서 알 수 없는 최상위 키다' });
  }

  if (doc.apiVersion !== 'elanous.app/v0') push(errors, '/apiVersion', 'elanous.app/v0 이어야 한다');
  if (!nonEmptyString(doc.slug)) {
    push(errors, '/slug', 'slug 은 소문자 영숫자와 하이픈으로 된 1~63자 이름이어야 한다');
  } else {
    const slug = doc.slug;
    if (slug.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.includes('--') || slug.startsWith('xn--') || /-pr\d+$/.test(slug)) {
      push(errors, '/slug', 'slug 형식 위반');
    } else if (RESERVED_SLUGS.has(slug)) {
      push(errors, '/slug', '예약된 slug 다');
    } else if (new Set(existingSlugs).has(slug)) {
      push(errors, '/slug', '이미 사용 중인 slug 다');
    }
  }
  if (!nonEmptyString(doc.title)) push(errors, '/title', 'title 이 비어 있거나 문자열이 아니다');

  if (!isRecord(doc.frontend)) push(errors, '/frontend', 'frontend 맵이 필요하다');
  else if (doc.frontend.kind !== 'static-export') push(errors, '/frontend/kind', 'static-export 만 지원한다');

  const declaredTables = isRecord(doc.tables) ? new Set(Object.keys(doc.tables)) : new Set<string>();
  if (doc.tables !== undefined && !isRecord(doc.tables)) push(errors, '/tables', 'tables 는 맵이어야 한다');
  const roles = isRecord(doc.roles) ? new Set(Object.keys(doc.roles)) : new Set<string>();
  if (doc.roles !== undefined && !isRecord(doc.roles)) push(errors, '/roles', 'roles 는 맵이어야 한다');
  const publicRole = isRecord(doc.roles) && isRecord(doc.roles.public) && doc.roles.public.via === 'public-read';

  if (doc.rpc !== undefined && !isRecord(doc.rpc)) push(errors, '/rpc', 'rpc 는 맵이어야 한다');
  if (isRecord(doc.rpc)) {
    for (const [index, name] of (rpcKeys ?? Object.keys(doc.rpc)).entries()) {
      const raw = doc.rpc[name];
      const path = mapEntryPath('/rpc', index);
      if (!isRecord(raw)) { push(errors, path, 'RPC 선언은 맵이어야 한다'); continue; }
      if (typeof raw.sql !== 'string' || !sqlIsSafe(raw.sql, raw.params, declaredTables)) push(errors, `${path}/sql`, 'SQL 문·바인딩·DDL·테이블 선언을 확인하라');
      if (publicRole && Array.isArray(raw.allow) && raw.allow.includes('public') && typeof raw.sql === 'string' && !sqlIsReadOnly(raw.sql)) {
        push(errors, `${path}/allow`, 'public-read 역할에는 읽기 전용 SQL만 허용된다');
      }
      if (!Array.isArray(raw.allow) || raw.allow.length === 0 || raw.allow.some(role => typeof role !== 'string' || !roles.has(role))) {
        push(errors, `${path}/allow`, 'allow 은 선언된 역할만 포함하는 비어 있지 않은 목록이어야 한다');
      }
    }
  }

  if (doc.actions !== undefined && !isRecord(doc.actions)) push(errors, '/actions', 'actions 는 맵이어야 한다');
  if (isRecord(doc.actions)) {
    for (const [index, name] of (actionKeys ?? Object.keys(doc.actions)).entries()) {
      const raw = doc.actions[name];
      const path = mapEntryPath('/actions', index);
      if (!isRecord(raw)) { push(errors, path, '동작 선언은 맵이어야 한다'); continue; }
      if (typeof raw.builtin !== 'string' || !BUILTINS.has(raw.builtin)) push(errors, `${path}/builtin`, '허용된 내장 동작(stt, summarize, tts, generate, translate, extract) 중 하나여야 한다');
      else if (Object.hasOwn(ACTION_IO_CONTRACTS, raw.builtin)) {
        const contract = ACTION_IO_CONTRACTS[raw.builtin as keyof typeof ACTION_IO_CONTRACTS];
        validateActionIo(raw, path, 'input', contract.input, errors);
        validateActionIo(raw, path, 'output', contract.output, errors);
      }
      if (raw.uses !== undefined) validateCredentialList(raw.uses, `${path}/uses`, errors, false);
      if (raw.allow !== undefined && (!Array.isArray(raw.allow) || raw.allow.length === 0
        || raw.allow.some(role => typeof role !== 'string' || !roles.has(role)))) {
        push(errors, `${path}/allow`, 'allow 은 선언된 역할만 포함하는 비어 있지 않은 목록이어야 한다');
      }
      if (raw.async === true && raw.builtin === 'generate' && !nonEmptyString(raw.spend)) push(errors, `${path}/spend`, '비동기 generate 는 spend 선언이 필요하다');
    }
  }

  if (doc.credentials !== undefined) validateCredentialList(doc.credentials, '/credentials', errors, false);
  if (doc.storage !== undefined) {
    if (!isRecord(doc.storage)) push(errors, '/storage', 'storage 는 맵이어야 한다');
    else {
      if (typeof doc.slug === 'string' && doc.storage.prefix !== `apps/${doc.slug}/`) push(errors, '/storage/prefix', 'storage.prefix 는 apps/<slug>/ 와 같아야 한다');
      if (doc.storage.quotaBytes !== undefined && (!Number.isSafeInteger(doc.storage.quotaBytes) || Number(doc.storage.quotaBytes) <= 0)) {
        push(errors, '/storage/quotaBytes', 'storage.quotaBytes 는 양의 안전한 정수여야 한다');
      }
      if (doc.storage.upload !== undefined) {
        if (!isRecord(doc.storage.upload)) push(errors, '/storage/upload', 'storage.upload 는 맵이어야 한다');
        else {
          if (!Array.isArray(doc.storage.upload.allow) || doc.storage.upload.allow.length === 0
            || doc.storage.upload.allow.some(role => typeof role !== 'string' || !roles.has(role))) {
            push(errors, '/storage/upload/allow', 'storage.upload.allow 는 선언된 역할을 하나 이상 포함해야 한다');
          }
          if (publicRole && Array.isArray(doc.storage.upload.allow) && doc.storage.upload.allow.includes('public')) {
            push(errors, '/storage/upload/allow', 'public-read 역할은 업로드를 허용할 수 없다');
          }
          if (!Array.isArray(doc.storage.upload.types) || doc.storage.upload.types.length === 0
            || doc.storage.upload.types.some(type => !isMimeType(type))) {
            push(errors, '/storage/upload/types', 'storage.upload.types 는 MIME 형식을 하나 이상 포함해야 한다');
          }
          if (doc.storage.upload.maxBytes !== undefined
            && (!Number.isSafeInteger(doc.storage.upload.maxBytes) || Number(doc.storage.upload.maxBytes) <= 0)) {
            push(errors, '/storage/upload/maxBytes', 'storage.upload.maxBytes 는 양의 안전한 정수여야 한다');
          }
          if (doc.storage.upload.anonymous !== undefined && typeof doc.storage.upload.anonymous !== 'boolean') {
            push(errors, '/storage/upload/anonymous', 'storage.upload.anonymous 는 boolean 이어야 한다');
          }
        }
      }
    }
  }
  for (const issue of validateAppSimulation(doc.simulate, {
    actions: isRecord(doc.actions) ? Object.keys(doc.actions) : [],
    rpc: isRecord(doc.rpc) ? Object.keys(doc.rpc) : [],
    roles,
    tables: declaredTables,
  })) push(errors, issue.path, issue.reason);
  return { errors, warnings };
}

/** Parse and validate app.yaml v0 without filesystem, network, or state access. Diagnostics never contain source values. */
export function parseAppManifest(source: string, existingSlugs: Iterable<string> = []): AppManifestParseResult {
  let document: ReturnType<typeof parseDocument>;
  let parsed: unknown;
  try {
    document = parseDocument(source);
    if (document.errors.length > 0) return { ok: false, errors: [{ path: '/', reason: 'YAML 파싱 실패' }] };
    parsed = document.toJS();
  } catch {
    return { ok: false, errors: [{ path: '/', reason: 'YAML 파싱 실패' }] };
  }
  if (!isRecord(parsed)) return { ok: false, errors: [{ path: '/', reason: 'app.yaml 최상위는 맵이어야 한다' }] };
  const { errors, warnings } = validateManifest(
    parsed,
    existingSlugs,
    orderedMapKeys(document.contents, 'rpc'),
    orderedMapKeys(document.contents, 'actions'),
  );
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: parsed as AppManifest, warnings };
}
