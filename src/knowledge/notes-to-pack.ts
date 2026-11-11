import { isIP } from 'node:net';
import type { KnowledgePackManifest } from './write.js';

/** A deterministic, offline recipe. The caller supplies extracted facts; this module does not infer them. */
export interface ExpertNote {
  id: string;
  speaker: string;
  observedAt: string;
  claim: string;
  premise: string;
  falsifier: string;
  asset: string;
  horizon: string;
  source?: { url: string; capturedAt: string };
}

export interface ClaimCard {
  noteId: string;
  claim: string;
  premise: string;
  falsifier: string;
  asset: string;
  horizon: string;
  source?: ExpertNote['source'];
  evidence: string;
}

export interface QuestionCard {
  noteId: string;
  level: 4 | 5;
  question: string;
  source: string;
}

export interface NotesToPackResult {
  manifest: KnowledgePackManifest;
  claimCards: ClaimCard[];
  questionCards: QuestionCard[];
  files: Record<string, object>;
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`notes-to-pack: ${field} required`);
  return value.trim();
}

function validHttpsSourceUrl(value: string): boolean {
  // URL() alone repairs hostless inputs such as https:///path into a host.
  if (typeof value !== 'string' || /[\s\\]/.test(value) || !/^https:\/\/[^/?#@\s]+/.test(value)) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname;
    const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    const validHost = hostname.startsWith('[') && hostname.endsWith(']')
      ? isIP(hostname.slice(1, -1)) === 6
      : isIP(host) === 4 || (host.length > 0 && host.length <= 253
        && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)));
    return url.protocol === 'https:' && validHost && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Build KPACK1 directory contents, ready for the ordinary pack validator and signing path. */
export function notesToPack(notes: readonly ExpertNote[], identity: { name: string; version: string }): NotesToPackResult {
  if (notes.length === 0) throw new Error('notes-to-pack: notes required');
  const manifest: KnowledgePackManifest = {
    kind: 'knowledge-pack', name: required(identity.name, 'name'), version: required(identity.version, 'version'),
    description: 'Expert view cards derived from attributed notes; simulation, not investment advice',
    signature: { alg: 'ed25519', keyId: '00000000' }, dependencies: [], license: 'UNLICENSED',
    visibility: 'internal', content: [],
  };
  const content: Array<{ type: 'document' | 'qa'; path: string }> = [];
  const files: Record<string, object> = {};
  const claimCards: ClaimCard[] = [];
  const questionCards: QuestionCard[] = [];
  const seen = new Set<string>();
  for (const [index, note] of notes.entries()) {
    const id = required(note.id, 'id');
    if (seen.has(id)) throw new Error(`notes-to-pack: duplicate note id ${id}`);
    seen.add(id);
    const claim = required(note.claim, 'claim');
    const premise = required(note.premise, 'premise');
    const falsifier = required(note.falsifier, 'falsifier');
    const asset = required(note.asset, 'asset');
    const horizon = required(note.horizon, 'horizon');
    const speaker = required(note.speaker, 'speaker');
    const observedAt = required(note.observedAt, 'observedAt');
    if (Number.isNaN(Date.parse(observedAt))) throw new Error(`notes-to-pack: invalid observedAt for ${id}`);
    if (note.source && (!validHttpsSourceUrl(note.source.url) || Number.isNaN(Date.parse(note.source.capturedAt)))) {
      throw new Error(`notes-to-pack: invalid source for ${id}`);
    }
    const source = note.source ? `${note.source.url} (captured ${note.source.capturedAt})` : '근거 없음';
    const card: ClaimCard = { noteId: id, claim, premise, falsifier, asset, horizon, source: note.source, evidence: source };
    claimCards.push(card);
    const stem = `content/note-${String(index + 1).padStart(3, '0')}`;
    const claimPath = `${stem}-claim.json`;
    content.push({ type: 'document', path: claimPath });
    files[claimPath] = {
      type: 'document', title: `${asset} · ${horizon} · ${id}`, source,
      body: JSON.stringify({ speaker, observedAt, ...card }),
    };
    const questions: [4 | 5, string][] = [
      [4, `${asset}의 ${horizon} 전망 '${claim}'은 전제 '${premise}'에서 어떤 인과 경로로 이어지며, 무엇과 비교해야 하는가?`],
      [5, `${asset}의 ${horizon} 전망 '${claim}'의 출처 근거 강도와 한계는 무엇이고, '${falsifier}'가 관측되면 판단을 어떻게 바꿔야 하는가?`],
    ];
    for (const [level, question] of questions) {
      const path = `${stem}-bloom-${level}.json`;
      content.push({ type: 'qa', path });
      questionCards.push({ noteId: id, level, question, source });
      files[path] = { type: 'qa', title: `${id} · Bloom ${level}`, source, question, answer: '시뮬 질문 카드; 조사와 평가가 필요함' };
    }
  }
  const completeManifest = { ...manifest, content };
  files['knowledge-pack.json'] = completeManifest;
  return { manifest: completeManifest, claimCards, questionCards, files };
}
