import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KgsSqliteStore } from './kgs/sqlite-store.js';
import { isPackVersion, parsePackIdString } from './kgs/pack.js';
import { listInstalledPacks, queryInstalledPack } from './query.js';
import { packDirDeterministic } from '../market/tgz.js';
import { generateIndexKeyPair, signIndex } from '../market/signed-index.js';
import { installKnowledgePack, knowledgeWrite, removeKnowledgePack, upgradeKnowledgePack, validateKnowledgePack, validateKnowledgePackArchive } from './write.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(version = '1.0.0') {
  const root = mkdtempSync(join(tmpdir(), 'kpack1-'));
  roots.push(root);
  mkdirSync(join(root, 'content'));
  const manifest = { kind: 'knowledge-pack', name: 'fab-knowledge', version, description: '공정 지식',
    signature: { alg: 'ed25519', keyId: 'deadbeef' }, dependencies: [], license: 'MIT', visibility: 'public',
    content: [{ type: 'document', path: 'content/process.json' }] };
  const item = { type: 'document', title: '식각 온도', body: '식각 온도는 40도', source: 'https://example.org/process' };
  const save = () => {
    writeFileSync(join(root, 'knowledge-pack.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'content/process.json'), JSON.stringify(item));
  };
  save();
  return { root, manifest, item, save };
}
function withStore(run: (store: KgsSqliteStore) => void) {
  const store = new KgsSqliteStore(':memory:');
  try { run(store); } finally { store.close(); }
}

test('KPACK1 rejects invalid identity, missing and escaping content, symlinks, incomplete content and unresolved dependencies', () => {
  const f = fixture();
  expect(validateKnowledgePack(f.root).pack.cards[0]).toMatchObject({ title: '식각 온도', source: { url: 'https://example.org/process' } });
  f.manifest.name = '../escape'; f.save();
  expect(() => validateKnowledgePack(f.root)).toThrow('invalid name or version');
  f.manifest.name = 'fab-knowledge'; f.manifest.content[0]!.path = 'content/../../outside.json'; f.save();
  expect(() => validateKnowledgePack(f.root)).toThrow('unsafe path');
  f.manifest.content[0]!.path = 'content/missing.json'; f.save();
  expect(() => validateKnowledgePack(f.root)).toThrow();
  f.manifest.content[0]!.path = 'content/link.json'; f.save();
  symlinkSync(join(f.root, 'content/process.json'), join(f.root, 'content/link.json'));
  expect(() => validateKnowledgePack(f.root)).toThrow('symbolic link');
  rmSync(join(f.root, 'content/link.json'));
  f.manifest.content[0]!.path = 'content/process.json'; f.item.body = ''; f.save();
  expect(() => validateKnowledgePack(f.root)).toThrow('body must be a non-empty string');
  f.item.body = '식각 온도는 40도';
  (f.manifest.dependencies as unknown[]).push({ market: 'https://example.org/marketplace.json', name: 'base-pack', version: '1.0.0' }); f.save();
  expect(() => validateKnowledgePack(f.root)).toThrow('verified resolver');
});

test('KPACK1 rejects leading-zero SemVer identifiers before install and upgrade mutate storage', () => withStore(store => {
  const old = fixture('1.0.0-rc.2');
  const bad = fixture('1.0.0-rc.01');
  expect(isPackVersion('1.0.0-rc.01')).toBe(false);
  expect(parsePackIdString('pack:fab-knowledge@1.0.0-rc.01')).toBeNull();
  for (const version of ['01.0.0', '1.02.0', '1.0.03', '1.0.0-02', '1.0.0-rc.01', '1.0.0-rc.02', '1.0.0-rc..2']) {
    bad.manifest.version = version;
    bad.save();
    expect(isPackVersion(version)).toBe(false);
    expect(() => validateKnowledgePack(bad.root)).toThrow('invalid name or version');
    expect(() => installKnowledgePack(bad.root, store)).toThrow('invalid name or version');
  }
  expect(store.readPack('fab-knowledge', '1.0.0-rc.01')).toBeNull();
  installKnowledgePack(old.root, store);
  bad.manifest.version = '1.0.0-rc.02'; bad.save();
  expect(() => upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0-rc.2' }, bad.root, store)).toThrow('invalid name or version');
  expect(() => upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0-rc.02' }, fixture('1.0.0-rc.3').root, store)).toThrow('invalid previous pack id');
  expect(() => removeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0-rc.02' }, store)).toThrow('invalid pack id');
  expect(store.readPack('fab-knowledge', '1.0.0-rc.2')).not.toBeNull();
  expect(store.readPack('fab-knowledge', '1.0.0-rc.02')).toBeNull();
  expect(isPackVersion('1.0.0-rc.0')).toBe(true);
  expect(isPackVersion('1.0.0-rc.2')).toBe(true);
}));

test('standalone install persists a searchable pack, rejects duplicates and removes only the selected version', () => withStore(store => {
  const f = fixture();
  const id = installKnowledgePack(f.root, store);
  expect(id).toBe('pack:fab-knowledge@1.0.0');
  expect(listInstalledPacks(store)).toEqual([{ id, title: 'fab-knowledge' }]);
  expect(queryInstalledPack(id, '식각', store)[0]).toMatchObject({ body: '식각 온도는 40도', ref: expect.stringMatching(/^pack:fab-knowledge@1\.0\.0#card:/) });
  expect(() => installKnowledgePack(f.root, store)).toThrow('already installed');
  expect(removeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0' }, store)).toBe(true);
  expect(removeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0' }, store)).toBe(false);
  expect(listInstalledPacks(store)).toEqual([]);
  expect(() => queryInstalledPack(id, '식각', store)).toThrow('pack not installed');
}));

test('upgrade validates before mutation and atomically switches a single installed version', () => withStore(store => {
  const old = fixture(); const next = fixture('2.0.0');
  const id = installKnowledgePack(old.root, store);
  next.item.body = ''; next.save();
  expect(() => upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0' }, next.root, store)).toThrow('body must be');
  expect(store.readPack('fab-knowledge', '1.0.0')).not.toBeNull();
  next.item.body = '새 온도는 50도'; next.save();
  expect(upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0' }, next.root, store)).toBe('pack:fab-knowledge@2.0.0');
  expect(() => queryInstalledPack(id, '식각', store)).toThrow('pack not installed');
  expect(queryInstalledPack('pack:fab-knowledge@2.0.0', '온도', store)[0]?.body).toBe('새 온도는 50도');
  expect(() => upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0' }, next.root, store)).toThrow('pack not installed');
  const third = fixture('3.0.0');
  installKnowledgePack(third.root, store);
  expect(() => upgradeKnowledgePack({ slug: 'fab-knowledge', version: '2.0.0' }, third.root, store)).toThrow('already installed');
  expect(store.readPack('fab-knowledge', '2.0.0')).not.toBeNull();
  expect(store.readPack('fab-knowledge', '3.0.0')).not.toBeNull();
  expect(() => upgradeKnowledgePack({ slug: 'fab-knowledge', version: '3.0.0' }, next.root, store)).toThrow('newer version');
  expect(store.readPack('fab-knowledge', '3.0.0')).not.toBeNull();
  const prerelease = fixture('4.0.0-2');
  installKnowledgePack(prerelease.root, store);
  const laterPrerelease = fixture('4.0.0-10');
  expect(upgradeKnowledgePack({ slug: 'fab-knowledge', version: '4.0.0-2' }, laterPrerelease.root, store)).toBe('pack:fab-knowledge@4.0.0-10');
  expect(store.readPack('fab-knowledge', '4.0.0-2')).toBeNull();
}));

test('SemVer prerelease identifier ordering upgrades rc.2 to rc.10 without dropping the old version on rejection', () => withStore(store => {
  const old = fixture('1.0.0-rc.2');
  const next = fixture('1.0.0-rc.10');
  expect(installKnowledgePack(old.root, store)).toBe('pack:fab-knowledge@1.0.0-rc.2');
  expect(upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0-rc.2' }, next.root, store))
    .toBe('pack:fab-knowledge@1.0.0-rc.10');
  expect(store.readPack('fab-knowledge', '1.0.0-rc.2')).toBeNull();
  expect(queryInstalledPack('pack:fab-knowledge@1.0.0-rc.10', '식각', store)).toHaveLength(1);
  expect(() => upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0-rc.10' }, old.root, store)).toThrow('newer version');
  expect(store.readPack('fab-knowledge', '1.0.0-rc.10')).not.toBeNull();
  const numeric = fixture('1.0.0-11');
  expect(() => upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0-rc.10' }, numeric.root, store)).toThrow('newer version');
  const longer = fixture('1.0.0-rc.10.1');
  expect(upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0-rc.10' }, longer.root, store))
    .toBe('pack:fab-knowledge@1.0.0-rc.10.1');
  const stable = fixture('1.0.0');
  expect(upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0-rc.10.1' }, stable.root, store))
    .toBe('pack:fab-knowledge@1.0.0');
  expect(store.readPack('fab-knowledge', '1.0.0-rc.10.1')).toBeNull();
  const hyphenated = fixture('1.0.0-rc-build');
  const laterHyphenated = fixture('1.0.0-rc-next');
  installKnowledgePack(hyphenated.root, store);
  expect(upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0-rc-build' }, laterHyphenated.root, store))
    .toBe('pack:fab-knowledge@1.0.0-rc-next');
}));

test('market proof checks Ed25519 index, key id, archive bytes and SHA-256 before writing', () => withStore(store => {
  const f = fixture(); const key = generateIndexKeyPair(); f.manifest.signature.keyId = key.keyId; f.save();
  const artifactBytes = packDirDeterministic(f.root);
  const index = Buffer.from(JSON.stringify({ name: 'test', interface: { displayName: 'Test' }, sequence: 1, plugins: [],
    knowledgePacks: [{ name: f.manifest.name, version: f.manifest.version, visibility: 'public',
      artifact: { sha256: createHash('sha256').update(artifactBytes).digest('hex'), bytes: artifactBytes.byteLength, key: 'fab.tgz' } }] }));
  const proof = { marketplaceBytes: index, signatureText: signIndex(index, key.privateKeyPem, key.keyId),
    trustedKeys: [{ keyId: key.keyId, publicKey: key.publicKey }], artifactBytes };
  expect(() => installKnowledgePack(f.root, store, { ...proof, artifactBytes: Buffer.from('tampered') })).toThrow('artifact hash or size mismatch');
  expect(() => installKnowledgePack(f.root, store, { ...proof, signatureText: proof.signatureText.replace(/.$/, 'x') })).toThrow('index');
  expect(store.readPack('fab-knowledge', '1.0.0')).toBeNull();
  // A signed index listing an artifact whose manifest names another key is refused.
  f.manifest.signature.keyId = 'deadbeef'; f.save();
  const otherKeyBytes = packDirDeterministic(f.root);
  const otherKeyIndex = Buffer.from(JSON.stringify({ name: 'test', interface: { displayName: 'Test' }, sequence: 1, plugins: [],
    knowledgePacks: [{ name: f.manifest.name, version: f.manifest.version, visibility: 'public',
      artifact: { sha256: createHash('sha256').update(otherKeyBytes).digest('hex'), bytes: otherKeyBytes.byteLength, key: 'fab.tgz' } }] }));
  expect(() => installKnowledgePack(f.root, store, { ...proof, marketplaceBytes: otherKeyIndex,
    signatureText: signIndex(otherKeyIndex, key.privateKeyPem, key.keyId), artifactBytes: otherKeyBytes })).toThrow('keyId differs');
  f.manifest.signature.keyId = key.keyId; f.save();
  expect(() => installKnowledgePack(f.root, store, { ...proof, lastSequence: 2 })).toThrow('sequence-rollback');
  expect(store.readPack('fab-knowledge', '1.0.0')).toBeNull();
  expect(installKnowledgePack(f.root, store, proof)).toBe('pack:fab-knowledge@1.0.0');
}));

test('market install stores the cards parsed from the verified artifact bytes, not a later directory read', () => withStore(store => {
  const f = fixture(); const key = generateIndexKeyPair(); f.manifest.signature.keyId = key.keyId; f.save();
  const artifactBytes = packDirDeterministic(f.root);
  // The archive alone (no directory) yields the signed content.
  expect(validateKnowledgePackArchive(artifactBytes).pack.cards[0]).toMatchObject({ body: '식각 온도는 40도' });
  const index = Buffer.from(JSON.stringify({ name: 'test', interface: { displayName: 'Test' }, sequence: 1, plugins: [],
    knowledgePacks: [{ name: f.manifest.name, version: f.manifest.version, visibility: 'public',
      artifact: { sha256: createHash('sha256').update(artifactBytes).digest('hex'), bytes: artifactBytes.byteLength, key: 'fab.tgz' } }] }));
  const proof = { marketplaceBytes: index, signatureText: signIndex(index, key.privateKeyPem, key.keyId),
    trustedKeys: [{ keyId: key.keyId, publicKey: key.publicKey }], artifactBytes };
  // A directory that no longer matches the artifact is refused.
  f.item.body = '식각 온도는 99도'; f.save();
  expect(() => installKnowledgePack(f.root, store, proof)).toThrow('differs from verified artifact');
  expect(store.readPack('fab-knowledge', '1.0.0')).toBeNull();
  f.item.body = '식각 온도는 40도'; f.save();
  installKnowledgePack(f.root, store, proof);
  expect(store.readPack('fab-knowledge', '1.0.0')?.cards[0]?.body).toBe('식각 온도는 40도');
}));

test('existing note-writing schema rejection leaves vault and ledger bytes untouched and valid note retains its format', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-note-')); roots.push(root);
  const vault = { root } as Parameters<typeof knowledgeWrite>[0];
  const note = join(root, 'note.md');
  const ledger = join(root, 'ledger.jsonl');
  const priorNote = Buffer.from('---\ntitle: Old\n---\nprior body');
  const priorLedger = Buffer.from('{"kind":"note","path":"note.md"}\n');
  writeFileSync(note, priorNote);
  writeFileSync(ledger, priorLedger);
  const before = readdirSync(root).sort();

  expect(knowledgeWrite(vault, { rel_path: 'note.md', body: 'body', kind: 'note', overwrite: true, frontmatter: {} }).ok).toBe(false);
  expect(readFileSync(note)).toEqual(priorNote);
  expect(readFileSync(ledger)).toEqual(priorLedger);
  expect(readdirSync(root).sort()).toEqual(before);
  expect(knowledgeWrite(vault, { rel_path: 'new.md', body: 'body', kind: 'note', frontmatter: {} }).ok).toBe(false);
  expect(existsSync(join(root, 'new.md'))).toBe(false);
  expect(readFileSync(note)).toEqual(priorNote);
  expect(readFileSync(ledger)).toEqual(priorLedger);
  expect(readdirSync(root).sort()).toEqual(before);

  expect(knowledgeWrite(vault, { rel_path: 'note.md', body: 'body', kind: 'note', overwrite: true,
    frontmatter: { title: 'Title' }, tags: ['verified'] })).toMatchObject({ ok: true, relPath: 'note.md' });
  expect(readFileSync(note)).toEqual(Buffer.from('---\ntitle: Title\nkind: note\ntags: ["verified"]\n---\nbody'));
  expect(readFileSync(ledger)).toEqual(priorLedger);
  expect(readdirSync(root).sort()).toEqual(before);
  expect(() => knowledgeWrite(vault, { rel_path: 'note.md', body: 'body', kind: 'note', frontmatter: { title: 'Title' } })).toThrow('overwrite=false');
  expect(readFileSync(note)).toEqual(Buffer.from('---\ntitle: Title\nkind: note\ntags: ["verified"]\n---\nbody'));
  expect(readFileSync(ledger)).toEqual(priorLedger);
});

test('upgrade rolls back the new version when deleting the previous one fails inside the transaction', () => {
  class FailingDelete extends KgsSqliteStore { override deletePack(): boolean { throw new Error('injected delete failure'); } }
  const store = new FailingDelete(':memory:');
  try {
    installKnowledgePack(fixture('1.0.0').root, store);
    expect(() => upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0' }, fixture('2.0.0').root, store)).toThrow('injected delete failure');
    expect(store.readPack('fab-knowledge', '1.0.0')).not.toBeNull();
    expect(store.readPack('fab-knowledge', '2.0.0')).toBeNull();
  } finally { store.close(); }
});

test('upgrade rolls back when the previous version is not actually deleted', () => {
  class NoopDelete extends KgsSqliteStore { override deletePack(): boolean { return false; } }
  const store = new NoopDelete(':memory:');
  try {
    installKnowledgePack(fixture('1.0.0').root, store);
    expect(() => upgradeKnowledgePack({ slug: 'fab-knowledge', version: '1.0.0' }, fixture('2.0.0').root, store)).toThrow('pack not removed');
    expect(store.readPack('fab-knowledge', '1.0.0')).not.toBeNull();
    expect(store.readPack('fab-knowledge', '2.0.0')).toBeNull();
  } finally { store.close(); }
});

test('archive validation refuses an oversized inflation (compression bomb)', () => {
  const bomb = gzipSync(Buffer.alloc(33 * 1024 * 1024));
  expect(bomb.byteLength).toBeLessThan(1024 * 1024);
  expect(() => validateKnowledgePackArchive(bomb)).toThrow('archive unreadable or larger than');
});
