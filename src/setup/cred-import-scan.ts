import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { CREDENTIAL_SLOT_DEFINITIONS, parseCredentialSlotId } from '../nexus/config/secrets/cred-slot-schema.js';
import { SERVICE_KEY_CATALOG } from './service-key-catalog.js';

export interface CredentialImportProposal {
  readonly id: string;
  readonly name: string;
  readonly sourcePath: string;
  readonly slot: string;
  /** Present when a shell source mentions this key in syntax the scanner does not interpret. */
  readonly reason?: string;
}

export interface CredentialImportScan {
  readonly proposals: readonly CredentialImportProposal[];
  /** Resolve only IDs the user selected. Values stay out of proposal metadata. */
  readSelected(ids: readonly string[]): Record<string, string>;
}

export interface CredentialImportScanOptions {
  homeDir?: string;
  cwd?: string;
  configPath?: string;
  existingSlots?: readonly string[];
}

const SLOT_BY_ENV = new Map<string, string>();
for (const service of SERVICE_KEY_CATALOG) {
  if (service.kind !== 'api-key' || service.envNames.length === 0) continue;
  const normalizedService = service.id.replace(/-api$/, '');
  const definition = CREDENTIAL_SLOT_DEFINITIONS.find(item => item.service === normalizedService);
  if (!definition) continue;
  const catalogSlots = (service.storeIds ?? []).filter(id => parseCredentialSlotId(id)?.service === definition.service);
  const slots = catalogSlots.length ? catalogSlots : definition.fields.map(field => `cred:${definition.service}.${field}`);
  for (const [index, name] of service.envNames.entries()) {
    const slot = slots[index];
    if (slot && parseCredentialSlotId(slot)) SLOT_BY_ENV.set(name, slot);
  }
}

interface InternalCandidate extends CredentialImportProposal {
  readonly value?: string;
}

function safeReadRegularFile(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return undefined;
    // Source: service-keys.ts bounds accepted dotenv input at 1 MiB.
    if (stat.size > 1024 * 1024) return undefined;
    return readFileSync(path, 'utf8');
  } catch { return undefined; }
}

function parseValue(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const pattern = quote === '"' ? /^"((?:\\.|[^"\\])*)"(?:\s*(?:#.*)?)$/ : /^'((?:\\'|[^'])*)'(?:\s*(?:#.*)?)$/;
    const match = pattern.exec(value);
    if (!match) return undefined;
    const parsed = quote === '"'
      ? unescapeDoubleQuoted(match[1]!)
      : match[1]!.replace(/\\'/g, "'");
    return parsed.trim() && !parsed.includes('\0') ? parsed : undefined;
  }
  // Parse dotenv text as data. Shell metacharacters remain literal; no expansion or evaluation occurs.
  const unquoted = value.replace(/\s+#.*$/, '').trim();
  return unquoted && !unquoted.includes('\0') ? unquoted : undefined;
}

function unescapeDoubleQuoted(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== '\\' || index + 1 >= value.length) {
      result += character;
      continue;
    }
    const escaped = value[index + 1]!;
    if (escaped === '"' || escaped === '\\') {
      result += escaped;
      index += 1;
    } else if (escaped === 'n' || escaped === 'r') {
      result += escaped === 'n' ? '\n' : '\r';
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
}

function addCandidate(
  candidates: InternalCandidate[],
  existingSlots: ReadonlySet<string>,
  seenSourceNames: Set<string>,
  name: string,
  sourcePath: string,
  slot: string,
  value: unknown,
): void {
  if (existingSlots.has(slot) || typeof value !== 'string' || !value.trim() || value.includes('\0')) return;
  const sourceKey = `${sourcePath}\0${name}\0${slot}`;
  if (seenSourceNames.has(sourceKey)) return;
  seenSourceNames.add(sourceKey);
  candidates.push({ id: `candidate-${randomUUID()}`, name, sourcePath, slot, value: value.trim() });
}

function scanDotenv(path: string, candidates: InternalCandidate[], existingSlots: ReadonlySet<string>, seen: Set<string>): void {
  const text = safeReadRegularFile(path);
  if (text === undefined) return;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    const slot = SLOT_BY_ENV.get(name);
    if (!slot) continue;
    const value = parseValue(match[2]!);
    addCandidate(candidates, existingSlots, seen, name, resolve(path), slot, value);
  }
}

function isSimpleOtherEnvironmentStatement(line: string): boolean {
  const assignment = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(\+?=)\s*(.*)$/.exec(line);
  if (assignment && assignment[2] !== 'OPENROUTER_API_KEY') {
    const rawValue = assignment[4]!.trim();
    return assignment[3] === '=' && !/[`$;|&()]/.test(rawValue) && parseValue(rawValue) !== undefined;
  }
  const unset = /^unset\s+(.+)$/.exec(line);
  if (unset) {
    const args = unset[1]!.trim().split(/\s+/).filter(Boolean);
    return args.every(arg => /^-[fv]+$/.test(arg) || arg === '--' || (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg) && arg !== 'OPENROUTER_API_KEY'));
  }
  const exportOnly = /^export\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
  if (exportOnly && exportOnly[1] !== 'OPENROUTER_API_KEY') return true;
  // A static echo has no effect on the environment and can be ignored without
  // evaluating shell expansions or operators. Other commands remain unresolved.
  return /^echo(?:\s+(?:'[^']*'|"[^"$`;&|()]*"|[^\s"$`;&|()]+))*\s*$/.test(line);
}

/** Read literal exported key assignments from startup files as text; never source or expand shell code. */
function scanShellExports(path: string, candidates: InternalCandidate[], existingSlots: ReadonlySet<string>, seen: Set<string>): void {
  const text = safeReadRegularFile(path);
  if (text === undefined) return;
  const slot = SLOT_BY_ENV.get('OPENROUTER_API_KEY');
  if (!slot) return;
  const lines = text.split(/\r?\n/);
  const hasKeyMention = lines.some(line => line.includes('OPENROUTER_API_KEY'));
  if (!hasKeyMention) return;
  let pendingValue: string | undefined;
  let exported = false;
  let unresolvedReason: string | undefined;
  const sourcePath = resolve(path);
  const sourceKey = `${sourcePath}\0OPENROUTER_API_KEY\0${slot}`;
  const replaceCandidate = (value: string | undefined, reason?: string) => {
    if (seen.delete(sourceKey)) {
      const index = candidates.findIndex(candidate => candidate.sourcePath === sourcePath
        && candidate.name === 'OPENROUTER_API_KEY' && candidate.slot === slot);
      if (index >= 0) candidates.splice(index, 1);
    }
    if (reason && !existingSlots.has(slot) && !seen.has(sourceKey)) {
      seen.add(sourceKey);
      candidates.push({ id: `candidate-${randomUUID()}`, name: 'OPENROUTER_API_KEY', sourcePath, slot, reason, ...(value ? { value } : {}) });
    } else if (value) addCandidate(candidates, existingSlots, seen, 'OPENROUTER_API_KEY', sourcePath, slot, value);
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const controlFlow = /(?:^|[;\s])(?:if|case|for|while|until|select|then|else|fi|do|done|esac)\b/.test(line);
    if (controlFlow && hasKeyMention) {
      unresolvedReason = 'shell control flow is not interpreted; inspect this startup file before importing its key';
      break;
    }
    if (!line.includes('OPENROUTER_API_KEY')) {
      if (isSimpleOtherEnvironmentStatement(line)) continue;
      unresolvedReason = 'shell command is not interpreted; inspect this startup file before importing its key';
      break;
    }
    const unset = /^unset\s+(.+)$/.exec(line);
    if (unset) {
      const args = unset[1]!.trim().split(/\s+/).filter(Boolean);
      if (!args.every(arg => /^-[fv]+$/.test(arg) || arg === '--' || /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg))) {
        unresolvedReason = 'compound or quoted unset syntax is not interpreted; inspect this startup file before importing its key';
        break;
      }
      let index = 0;
      let unsetFlags = '';
      while (index < args.length) {
        const arg = args[index]!;
        if (arg === '--') { index++; break; }
        if (!/^-[fv]+$/.test(arg)) break;
        unsetFlags += arg.slice(1);
        index++;
      }
      const unsetNamesVariable = !unsetFlags.includes('f') || unsetFlags.includes('v');
      if (unsetNamesVariable && args.slice(index).includes('OPENROUTER_API_KEY')) {
        pendingValue = undefined;
        exported = false;
        replaceCandidate(undefined);
      }
      continue;
    }
    const assignment = /^(export\s+)?OPENROUTER_API_KEY\s*(\+?=)\s*(.*)$/.exec(line);
    if (assignment) {
      const isExport = Boolean(assignment[1]);
      const operator = assignment[2]!;
      const rawValue = assignment[3]!.trim();
      // Only direct literals are interpreted; expansions, append assignments, and shell
      // control operators make the resulting value ambiguous and fail closed.
      const literal = operator === '=' && !/[`$;|&()]/.test(rawValue) ? parseValue(rawValue) : undefined;
      if (!literal) {
        unresolvedReason = 'dynamic or compound key assignment is not interpreted; inspect this startup file before importing its key';
        break;
      }
      if (isExport) exported = true;
      pendingValue = literal;
      if (exported) replaceCandidate(literal);
      continue;
    }
    if (/^export\s+OPENROUTER_API_KEY$/.test(line) && pendingValue) {
      exported = true;
      addCandidate(candidates, existingSlots, seen, 'OPENROUTER_API_KEY', resolve(path), slot, pendingValue);
      pendingValue = undefined;
      continue;
    }
    unresolvedReason = 'shell syntax mentioning this key is not interpreted; inspect this startup file before importing it';
    break;
  }
  if (unresolvedReason) replaceCandidate(exported ? pendingValue : undefined, unresolvedReason);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function scanConfig(path: string, candidates: InternalCandidate[], existingSlots: ReadonlySet<string>, seen: Set<string>): void {
  const text = safeReadRegularFile(path);
  if (text === undefined) return;
  let root: unknown;
  try { root = JSON.parse(text); } catch { return; }
  const llm = objectRecord(objectRecord(root)?.llm);
  if (!llm) return;
  const configPath = resolve(path);
  if (llm.provider === 'openai' || llm.provider === 'openrouter') {
    const slot = `cred:${llm.provider}.api_key`;
    addCandidate(candidates, existingSlots, seen, 'llm.apiKey', `${configPath}#llm.apiKey`, slot, llm.apiKey);
  }
  if (Array.isArray(llm.rotation)) {
    for (const [index, rawEntry] of llm.rotation.entries()) {
      const entry = objectRecord(rawEntry);
      if (entry?.provider === 'openai' || entry?.provider === 'openrouter') {
        const slot = `cred:${entry.provider}.api_key`;
        addCandidate(candidates, existingSlots, seen, 'llm.rotation[].apiKey', `${configPath}#llm.rotation[${index}].apiKey`, slot, entry.apiKey);
      }
    }
  }
}

/** Scan known dotenv, shell-export and Elanous config paths as data; never execute shell files or return values as metadata. */
export function scanCredentialImports(options: CredentialImportScanOptions = {}): CredentialImportScan {
  const home = resolve(options.homeDir ?? homedir());
  const cwd = resolve(options.cwd ?? process.cwd());
  const instanceRoot = resolve(effectiveInstanceRoot());
  const existingSlots = new Set(options.existingSlots ?? []);
  const candidates: InternalCandidate[] = [];
  const seenSourceNames = new Set<string>();
  const dotenvPaths = [
    join(cwd, '.env'),
    join(cwd, '.env.local'),
    join(home, '.env'),
    join(instanceRoot, '.env'),
    join(home, '.config', 'elanous', '.env'),
  ];
  for (const path of [...new Set(dotenvPaths.map(path => resolve(path)))]) scanDotenv(path, candidates, existingSlots, seenSourceNames);
  const shellPaths = ['.zshrc', '.bashrc', '.bash_profile', '.profile'].map(name => join(home, name));
  for (const path of shellPaths.map(path => resolve(path))) scanShellExports(path, candidates, existingSlots, seenSourceNames);
  const configPath = options.configPath ?? join(instanceRoot, 'config.json');
  scanConfig(configPath, candidates, existingSlots, seenSourceNames);
  const internalById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const proposals = candidates.map(({ id, name, sourcePath, slot, reason }) => ({ id, name, sourcePath, slot, ...(reason ? { reason } : {}) }));
  return {
    proposals,
    readSelected(ids) {
      const values: Record<string, string> = {};
      const selected = new Set<string>();
      for (const id of ids) {
        const candidate = internalById.get(id);
        if (!candidate) throw new Error('unknown credential import selection');
        if (candidate.reason || !candidate.value) throw new Error(`credential import candidate is unresolved: ${candidate.reason ?? 'no proven literal value'}`);
        if (selected.has(candidate.slot)) throw new Error('duplicate credential slot selection');
        selected.add(candidate.slot);
        values[candidate.slot] = candidate.value;
      }
      return values;
    },
  };
}
