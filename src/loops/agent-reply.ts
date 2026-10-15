import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { buildCliAgentTools } from '../cli/agent-cli.js';
import { debug, redactSecrets, redactSecretText } from '../debug/log.js';
import type { LLMProvider, LLMToolSpec } from '../llm.js';
import type { Message, MsgStore } from '../msg/msg-store.js';
import { canonicalSeatId } from '../msg/msg-store.js';
import { ensureCliSession, runTurn } from '../session/chat.js';
import { getUserConfig, type RoleLlmSpec } from '../user-config.js';
import { Database } from 'bun:sqlite';

export type AgentReplyAddress = 'COORDINATOR' | 'GUARDIAN';
export interface AgentReplyRequest { id: number; from: string; body: string; kind?: string }
export interface AgentReplyInput {
  address: AgentReplyAddress;
  request: AgentReplyRequest;
  role: RoleLlmSpec;
  pack: string;
  store: MsgStore;
  /** The selected instance root for read-only observations, when available. */
  observationRoot?: string;
  /** Test seam: a fake provider still traverses the real runTurn tool loop. */
  provider?: LLMProvider;
  /** A turn seam; the production path uses the CLI agent's runTurn engine. */
  runAgent?: (input: AgentReplyInput) => Promise<string | undefined>;
}
export interface AgentReplyResult { replyId: number | null; posted: boolean }

/** MK owns the pack generator. Resolve it only when the configured body starts. */
export function loadAgentRolePack(role: 'coordinator' | 'guardian'): string {
  const modulePath = resolve(import.meta.dir, '../../scripts/coord-role-pack.ts');
  const module = require(modulePath) as { buildCoordRolePack?: (role: 'coordinator' | 'guardian') => string };
  const pack = module.buildCoordRolePack?.(role);
  if (!pack?.trim()) throw new Error(`${role} role pack unavailable`);
  return pack;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function existingPath(path: string): string {
  try { return realpathSync(path); }
  catch { return join(realpathSync(dirname(path)), path.slice(dirname(path).length + 1)); }
}

function repoRoot(start: string): string | null {
  let current = realpathSync(start);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function safeReadPath(path: unknown, cwd: string, roots: readonly string[], notesRoot: string): boolean {
  if (typeof path !== 'string') return false;
  // Credential stems also block their file forms: secrets.json, credentials.json, tokens.txt.
  const forbidden = /(?:^|\/)(?:\.[^/]+|auth[^/]*|(?:credentials?|secrets?|tokens?|passwords?)(?:\.[^/]+)?)(?:\/|$)|\.(?:pem|key)$/i;
  const target = resolve(cwd, path);
  try {
    const canonical = existingPath(target);
    const seatState = join(homedir(), 'elanous-hq', 'seat-state');
    if (inside(seatState, canonical) && !inside(notesRoot, canonical)) return false;
    return roots.some(root => inside(root, canonical)) && !forbidden.test(target) && !forbidden.test(canonical);
  }
  catch { return false; }
}

function safeNotePath(path: unknown, cwd: string, notesRoot: string): boolean {
  if (typeof path !== 'string') return false;
  try { return inside(notesRoot, existingPath(resolve(cwd, path))); }
  catch { return false; }
}

const FILE_READ_TOOLS = new Set(['Read', 'Grep', 'ListDir']);
const FILE_WRITE_TOOLS = new Set(['Edit', 'Write']);

const THREAD_LIMIT = 50;
const THREAD_DEPTH = 20;

function observedMessage(message: Message) {
  return { id: message.id, from: message.from, to: message.to, kind: message.kind ?? 'unknown',
    body: redactSecretText(message.body), replyTo: message.replyTo ?? null };
}

/** A thread is scoped to messages this address sent, received, or saw as a broadcast. */
function observeThread(address: AgentReplyAddress, store: MsgStore, messageId: unknown) {
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId < 1) throw new Error('invalid message id');
  const visible = (m: Message) => m.from === address || m.to === address || m.to === 'ALL';
  const requested = store.getMessage(messageId);
  if (!requested || !visible(requested)) throw new Error('message outside this address');
  // The requested message and its ancestor path always come first, so the limit cannot drop them.
  const path: Message[] = [requested];
  for (let depth = 0; path.at(-1)!.replyTo !== undefined && depth < THREAD_DEPTH; depth++) {
    const parent = store.getMessage(path.at(-1)!.replyTo!);
    if (!parent || !visible(parent)) break;
    path.push(parent);
  }
  const root = path.at(-1)!;
  const seen = new Set(path.map(m => m.id));
  const thread = [...path];
  // Replies are bounded by the same depth below the root as ancestors above it.
  let level: Message[] = [root];
  for (let depth = 0; depth < THREAD_DEPTH && level.length > 0 && thread.length < THREAD_LIMIT; depth++) {
    const next: Message[] = [];
    for (const parent of level) {
      for (const reply of store.listReplies(parent.id, THREAD_LIMIT)) {
        if (!visible(reply)) continue;
        if (seen.has(reply.id)) { next.push(reply); continue; }
        if (thread.length >= THREAD_LIMIT) break;
        seen.add(reply.id);
        thread.push(reply);
        next.push(reply);
      }
    }
    level = next;
  }
  return redactSecrets(thread.sort((a, b) => a.id - b.id).map(observedMessage));
}

async function observeL0(address: AgentReplyAddress, args: Record<string, unknown>, store?: MsgStore, root?: string): Promise<unknown> {
  const surface = args.surface;
  if (surface === 'messages') {
    if (!store) throw new Error('selected message store unavailable');
    const recipient = args.recipient === undefined ? address : canonicalSeatId(String(args.recipient));
    if (recipient === 'ALL') throw new Error('ALL is not a recipient');
    // `after` re-reads already acknowledged mail; the default stays the unread cursor.
    const after = args.after === undefined ? store.getCursor(recipient) : args.after;
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) throw new Error('invalid after cursor');
    return redactSecrets(store.listByRecipient(recipient, after, 20).map(observedMessage));
  }
  if (surface === 'thread') {
    if (!store) throw new Error('selected message store unavailable');
    return observeThread(address, store, args.messageId);
  }
  if (surface === 'checklist') {
    if (!root) throw new Error('selected checklist root unavailable');
    const version = args.version;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('invalid checklist version');
    const path = join(root, 'release', 'features.sqlite');
    if (!existsSync(path)) return { version, unavailable: 'checklist ledger missing' };
    const db = new Database(path, { readonly: true, strict: true });
    try {
      return redactSecrets(db.query('SELECT feature_id AS id, status, evidence FROM assignments WHERE version = ? LIMIT 100')
        .all(version));
    } finally { db.close(); }
  }
  throw new Error('unknown observation surface');
}

/** The advertised tools and the dispatcher both enforce L0; prompts are not the boundary. */
export function buildL0AgentTools(address: AgentReplyAddress, cwd: string = process.cwd(),
  observation?: { store: MsgStore; root?: string }) {
  const cfg = getUserConfig();
  const base = buildCliAgentTools(cfg, undefined, cwd);
  const notesRoot = join(homedir(), 'elanous-hq', 'seat-state', address);
  const readRoots = [repoRoot(cwd), realpathSync(resolve(import.meta.dir, '../..')), existsSync(notesRoot) ? realpathSync(notesRoot) : null]
    .filter((root): root is string => root !== null);
  const specs: LLMToolSpec[] = base.specs.filter(s => FILE_READ_TOOLS.has(s.name) || FILE_WRITE_TOOLS.has(s.name));
  specs.push({ name: 'Observe', description: 'Read-only selected-instance messages, one message thread, or release checklist. messages: unread by default, `after` re-reads acknowledged mail. thread: `messageId` returns its thread scoped to this address. No shell or writes.',
    parameters: { type: 'object', properties: {
      surface: { type: 'string', enum: ['messages', 'thread', 'checklist'] },
      recipient: { type: 'string' }, version: { type: 'string' },
      after: { type: 'integer', minimum: 0 }, messageId: { type: 'integer', minimum: 1 },
    }, required: ['surface'], additionalProperties: false } });
  const deny = (name: string, reason: string) => {
    debug.log('coord.agent', 'l0-denied', { address, tool: name, reason });
    return { error: `L0 denied: ${reason}` };
  };
  const dispatch = async (name: string, args: Record<string, unknown>) => {
    if (name === 'Observe') {
      try { return await observeL0(address, args, observation?.store, observation?.root); }
      catch { return deny(name, 'invalid or unavailable read-only observation'); }
    }
    if (FILE_READ_TOOLS.has(name)) {
      if (name === 'Read' && args.path !== undefined) return deny(name, 'unexpected path field');
      if (name !== 'Read' && args.file_path !== undefined) return deny(name, 'unexpected file_path field');
      const path = name === 'Read' ? args.file_path : args.path;
      if (!safeReadPath(path, cwd, readRoots, notesRoot)) return deny(name, 'outside approved read roots or credential path');
      // A directory-wide Grep can traverse hidden credentials below an otherwise safe root.
      if (name === 'Grep') {
        try { if (!statSync(resolve(cwd, String(args.path))).isFile()) return deny(name, 'grep needs one explicit file'); }
        catch { return deny(name, 'grep needs one explicit file'); }
      }
      return redactSecrets(await base.dispatch(name, args));
    }
    if (FILE_WRITE_TOOLS.has(name)) {
      if (!safeNotePath(args.file_path, cwd, notesRoot)) return deny(name, 'outside role notes');
      return redactSecrets(await base.dispatch(name, args));
    }
    return deny(name, 'tool is outside L0 allowlist');
  };
  return { specs, dispatch };
}

async function runRestrictedAgent(input: AgentReplyInput): Promise<string | undefined> {
  const cfg = getUserConfig();
  const model = input.role.model?.trim();
  const provider = input.role.provider;
  if (!model || !provider) throw new Error(`${input.address} role LLM needs resolved provider and model`);
  if (!input.pack.trim()) throw new Error(`${input.address} role pack is empty`);
  mkdirSync(join(homedir(), 'elanous-hq', 'seat-state', input.address), { recursive: true, mode: 0o700 });
  const configured = { ...cfg, llm: { ...cfg.llm, provider, model,
    goalLoop: { ...cfg.llm.goalLoop, enabled: false } } };
  const session = ensureCliSession(configured, undefined, { title: `${input.address} inbox #${input.request.id}` });
  const tools = buildL0AgentTools(input.address, process.cwd(), { store: input.store, root: input.observationRoot });
  const result = await runTurn({
    userConfig: configured, sessionId: session.id,
    userText: `Message #${input.request.id} from ${input.request.from} (kind: ${input.request.kind ?? 'unknown'}):\n${redactSecretText(input.request.body)}\n\nReply with one concise proposal and evidence.`,
    systemPrompt: `${input.pack}\n\nL0: only read tools and writing your own role notes are available. The wrapper posts one reply with replyTo automatically. Do not include credentials or attempt a traffic/checklist/landing action.`,
    tools: tools.specs, dispatchTool: tools.dispatch,
    llmOpts: { model, ...(input.role.effort ? { reasoningEffort: input.role.effort } : {}) },
    ...(input.provider ? { provider: input.provider } : {}),
    skipMemoryInjection: true,
  });
  return result.text.trim() || undefined;
}

function existingReply(store: MsgStore, address: AgentReplyAddress, request: AgentReplyRequest): number | null {
  const linked = store.db.query(`SELECT id FROM msg_messages WHERE sender = ? AND recipient = ? AND reply_to = ? AND kind = 'reply' ORDER BY id LIMIT 1`)
    .get(address, request.from, request.id) as { id: number } | null;
  return linked?.id ?? null;
}

/** Generate at most once per accepted request; the durable reply link wins every retry. */
export async function replyWithAgent(input: AgentReplyInput): Promise<AgentReplyResult> {
  const { store, address, request } = input;
  const durable = store.getMessage(request.id);
  if (!durable || durable.to !== address || durable.from !== request.from || durable.body !== request.body) {
    throw new Error('agent reply request does not match the durable message');
  }
  const prior = existingReply(store, address, request);
  if (prior !== null) return { replyId: prior, posted: false };
  const generated = await (input.runAgent ?? runRestrictedAgent)(input);
  if (!generated?.trim()) return { replyId: null, posted: false };
  let safe: string;
  try { safe = redactSecretText(generated.trim()); }
  catch (error) {
    debug.log('coord.agent', 'redaction-failed', { address, requestId: request.id });
    throw new Error('agent reply redaction failed', { cause: error });
  }
  if (!safe.trim()) throw new Error('agent reply redaction failed');
  return store.db.transaction(() => {
    const linked = existingReply(store, address, request);
    if (linked !== null) return { replyId: linked, posted: false };
    const message = store.post({ from: address, to: request.from, body: safe, kind: 'reply', replyTo: request.id });
    debug.log('coord.agent', 'decision', { address, requestId: request.id, replyId: message.id,
      model: input.role.model ?? null, provider: input.role.provider ?? null,
      decision: redactSecretText(safe.slice(0, 300)) });
    return { replyId: message.id, posted: true };
  }).immediate();
}
