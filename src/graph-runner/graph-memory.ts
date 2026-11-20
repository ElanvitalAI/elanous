import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

export type GraphMemoryScope = 'instance' | 'template' | 'global';
export type GraphMemoryAction = 'read' | 'write' | 'promote';
export interface GraphMemoryDeclaration {
  readonly action: GraphMemoryAction;
  readonly read?: readonly GraphMemoryScope[];
  readonly write?: GraphMemoryScope;
  readonly promote?: { readonly to: 'template' | 'global'; readonly validationNode: string; readonly approvalNode?: string };
}
export interface GraphMemoryIdentity {
  /** Supplied by an authenticated caller, never by graph input. */
  readonly memberId: string;
  /** A test/sim/replay run cannot address the operational universe. */
  readonly universe: 'prod' | 'test' | 'sim' | 'replay';
  readonly provenance: 'real' | 'sim' | 'replay';
}
export interface GraphMemoryItem {
  id: string; scope: GraphMemoryScope; key: string; text: string; tags: string[];
  memberId: string; universe: GraphMemoryIdentity['universe']; graphId: string; runId: string; nodeId: string;
  sourceRunId: string; sourceNodeId: string; reason: string; provenance: GraphMemoryIdentity['provenance'];
  createdAt: string; expiresAt: string;
}
const SCOPES = ['instance', 'template', 'global'] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Source: 내부 문서 `RFC-adaptive-graph-ops-2026-10-09` §11-11 GRAPH-UNIVERSAL-SUBSTRATE.
const MAX_ENTRIES = 1000;
const MAX_BYTES = 1_000_000;
const TTL_MS: Record<GraphMemoryScope, number> = { instance: 86_400_000, template: 2_592_000_000, global: 7_776_000_000 };
const SENSITIVE = /(?:\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+\S+)|["']?(?:api[_-]?key|password|secret|token|authorization)["']?\s*[:=])/i;

export function parseGraphMemoryDeclaration(value: unknown): GraphMemoryDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('memory declaration must be an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['action', 'read', 'write', 'promote'].includes(key)) ||
    !['read', 'write', 'promote'].includes(String(raw.action))) throw new Error('invalid memory action');
  const action = raw.action as GraphMemoryAction;
  const read = raw.read;
  if (read !== undefined && (!Array.isArray(read) || read.length === 0 ||
    read.some(scope => !SCOPES.includes(scope)) || new Set(read).size !== read.length)) throw new Error('invalid memory.read scopes');
  if (raw.write !== undefined && !SCOPES.includes(raw.write as GraphMemoryScope)) throw new Error('invalid memory.write scope');
  const promote = raw.promote;
  if (promote !== undefined && (!promote || typeof promote !== 'object' || Array.isArray(promote) ||
    Object.keys(promote).some(key => !['to', 'validationNode', 'approvalNode'].includes(key)) ||
    !['template', 'global'].includes(String((promote as Record<string, unknown>).to)) ||
    typeof (promote as Record<string, unknown>).validationNode !== 'string' ||
    !ID.test((promote as { validationNode: string }).validationNode) ||
    ((promote as Record<string, unknown>).approvalNode !== undefined &&
      (typeof (promote as Record<string, unknown>).approvalNode !== 'string' ||
        !ID.test((promote as { approvalNode: string }).approvalNode))))) throw new Error('invalid memory.promote declaration');
  if (action === 'read' && (!read || raw.write !== undefined || promote !== undefined)) throw new Error('memory.read needs read scopes only');
  if (action === 'write' && (read !== undefined || promote !== undefined || (raw.write !== undefined && raw.write !== 'instance')))
    throw new Error('memory.write starts in instance; template/global require promotion');
  if (action === 'promote' && (!promote || read !== undefined || raw.write !== undefined ||
    ((promote as { to: string }).to === 'global' && !(promote as { approvalNode?: string }).approvalNode)))
    throw new Error('memory.promote needs validation and global approval');
  return { action, ...(read ? { read: read as GraphMemoryScope[] } : {}),
    ...(raw.write ? { write: raw.write as GraphMemoryScope } : {}),
    ...(promote ? { promote: promote as GraphMemoryDeclaration['promote'] } : {}) };
}

export function assertGraphMemoryIdentity(identity: GraphMemoryIdentity | undefined): asserts identity is GraphMemoryIdentity {
  if (!identity || !ID.test(identity.memberId) || !['prod', 'test', 'sim', 'replay'].includes(identity.universe) ||
    !['real', 'sim', 'replay'].includes(identity.provenance) ||
    (identity.universe === 'prod' && identity.provenance !== 'real') ||
    (identity.universe === 'sim' && identity.provenance !== 'sim') ||
    (identity.universe === 'replay' && identity.provenance !== 'replay')) throw new Error('graph memory requires a trusted member/universe identity');
}

function tokens(text: string): string[] { return text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu)?.filter(token => token.length > 1) ?? []; }
function itemId(parts: readonly string[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function score(item: GraphMemoryItem, query: string, docs: readonly GraphMemoryItem[]): number {
  const q = [...new Set(tokens(query))];
  const terms = tokens(item.text + ' ' + item.key);
  const tf = new Map<string, number>();
  for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
  const avgLength = docs.reduce((total, doc) => total + tokens(doc.text + ' ' + doc.key).length, 0) / Math.max(1, docs.length);
  const bm25 = q.reduce((total, term) => {
    const count = tf.get(term) ?? 0;
    const df = docs.filter(doc => tokens(doc.text + ' ' + doc.key).includes(term)).length;
    return total + Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) * count * 2.2 /
      (count + 1.2 * (0.25 + 0.75 * terms.length / Math.max(1, avgLength)));
  }, 0);
  // Sparse term vectors provide a deterministic local vector signal; a semantic embedder can replace this adapter.
  const cosine = q.reduce((sum, term) => sum + (tf.get(term) ?? 0), 0) /
    (Math.sqrt(q.length) * Math.sqrt([...tf.values()].reduce((sum, count) => sum + count * count, 0)) || 1);
  const ontology = q.filter(term => item.tags.some(tag => tag.toLocaleLowerCase().split('.').includes(term))).length;
  return bm25 + cosine + ontology;
}

export class GraphMemoryStore {
  private readonly db: Database;
  constructor(root: string) {
    if (!root) throw new Error('graph memory root is required');
    const dir = join(root, 'graph-memory');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'memory.sqlite');
    this.db = new Database(file, { create: true });
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, scope TEXT NOT NULL, member_id TEXT NOT NULL,
      universe TEXT NOT NULL, graph_id TEXT NOT NULL, run_id TEXT NOT NULL, expires_at TEXT NOT NULL,
      bytes INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS items_scope ON items(member_id, universe, graph_id, scope, expires_at);`);
  }
  close(): void { this.db.close(); }
  private visible(identity: GraphMemoryIdentity, graphId: string, runId: string, now: string): GraphMemoryItem[] {
    return (this.db.query(`SELECT payload FROM items WHERE member_id = ? AND universe = ? AND expires_at > ?
      AND (scope = 'global' OR (graph_id = ? AND (scope != 'instance' OR run_id = ?)))`)
      .all(identity.memberId, identity.universe, now, graphId, runId) as { payload: string }[])
      .map(row => JSON.parse(row.payload) as GraphMemoryItem)
      .filter(item => item.provenance === identity.provenance);
  }
  read(input: { identity: GraphMemoryIdentity; graphId: string; runId: string; scopes: readonly GraphMemoryScope[]; query: string; now?: Date }): GraphMemoryItem[] {
    assertGraphMemoryIdentity(input.identity);
    if (!ID.test(input.graphId) || !ID.test(input.runId) || !input.scopes.length ||
      input.scopes.some(scope => !SCOPES.includes(scope)) || !input.query.trim()) throw new Error('invalid graph memory read');
    const docs = this.visible(input.identity, input.graphId, input.runId, (input.now ?? new Date()).toISOString())
      .filter(item => input.scopes.includes(item.scope));
    return docs.map(item => ({ item, rank: score(item, input.query, docs) })).filter(row => row.rank > 0)
      .sort((a, b) => SCOPES.indexOf(a.item.scope) - SCOPES.indexOf(b.item.scope) || b.rank - a.rank)
      .slice(0, 10).map(row => row.item);
  }
  getInstance(input: { identity: GraphMemoryIdentity; graphId: string; runId: string; id: string; now?: Date }): GraphMemoryItem | undefined {
    assertGraphMemoryIdentity(input.identity);
    if (![input.graphId, input.runId, input.id].every(value => ID.test(value))) throw new Error('invalid graph memory item lookup');
    return this.visible(input.identity, input.graphId, input.runId, (input.now ?? new Date()).toISOString())
      .find(item => item.scope === 'instance' && item.runId === input.runId && item.id === input.id);
  }
  write(input: { identity: GraphMemoryIdentity; graphId: string; runId: string; nodeId: string;
    key: string; text: string; tags?: string[]; now?: Date }): GraphMemoryItem {
    assertGraphMemoryIdentity(input.identity);
    const scope = 'instance';
    if (![input.graphId, input.runId, input.nodeId, input.key].every(value => ID.test(value)) ||
      !input.text.trim() || SENSITIVE.test(input.text) || SENSITIVE.test(input.key) ||
      input.tags?.some(tag => typeof tag !== 'string' || !ID.test(tag) || SENSITIVE.test(tag))) throw new Error('invalid or sensitive graph memory value');
    const now = input.now ?? new Date();
    const item: GraphMemoryItem = { id: itemId([input.identity.memberId, input.identity.universe, input.identity.provenance, input.graphId,
      input.runId, input.nodeId, input.key, input.text]), scope, key: input.key, text: input.text,
      tags: input.tags ?? [], memberId: input.identity.memberId, universe: input.identity.universe,
      graphId: input.graphId, runId: input.runId, nodeId: input.nodeId,
      sourceRunId: input.runId, sourceNodeId: input.nodeId, reason: 'original', provenance: input.identity.provenance,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL_MS[scope]).toISOString() };
    return this.insert(item);
  }
  promote(input: { identity: GraphMemoryIdentity; graphId: string; runId: string; nodeId: string; sourceId: string;
    to: 'template' | 'global'; reason: string; validated: boolean; approved?: boolean; now?: Date }): GraphMemoryItem {
    assertGraphMemoryIdentity(input.identity);
    if (!input.validated || !input.reason.trim() || SENSITIVE.test(input.reason) || (input.to === 'global' && !input.approved) ||
      (input.identity.provenance !== 'real' && input.identity.universe === 'prod')) throw new Error('graph memory promotion denied');
    const now = input.now ?? new Date();
    const source = this.visible(input.identity, input.graphId, input.runId, now.toISOString()).find(item => item.id === input.sourceId);
    if (!source || source.scope !== 'instance' || source.runId !== input.runId) throw new Error('graph memory source not visible');
    const item: GraphMemoryItem = { ...source, id: itemId([source.id, input.to, input.nodeId, input.reason]), scope: input.to, nodeId: input.nodeId,
      reason: input.reason, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL_MS[input.to]).toISOString() };
    return this.insert(item);
  }
  private insert(item: GraphMemoryItem): GraphMemoryItem {
    const payload = JSON.stringify(item);
    const bytes = Buffer.byteLength(payload);
    return this.db.transaction(() => {
      this.db.query('DELETE FROM items WHERE expires_at <= ?').run(item.createdAt);
      const existing = this.db.query('SELECT payload FROM items WHERE id = ?').get(item.id) as { payload: string } | null;
      if (existing) return JSON.parse(existing.payload) as GraphMemoryItem;
      const total = this.db.query(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM items
        WHERE member_id = ? AND universe = ? AND json_extract(payload, '$.provenance') = ?
        AND scope = ? AND (? = 'global' OR graph_id = ?)
        AND (? != 'instance' OR run_id = ?)`)
        .get(item.memberId, item.universe, item.provenance, item.scope, item.scope, item.graphId, item.scope, item.runId) as { count: number; bytes: number };
      if (total.count >= MAX_ENTRIES || total.bytes + bytes > MAX_BYTES) throw new Error('graph memory capacity exceeded');
      this.db.query(`INSERT INTO items(id, scope, member_id, universe, graph_id, run_id, expires_at, bytes, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(item.id, item.scope, item.memberId, item.universe, item.graphId, item.runId, item.expiresAt, bytes, payload);
      return item;
    })();
  }
}
