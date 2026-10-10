import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { debug } from '../debug/log.js';
import { ensureInternalMarketIndex, ensureMarketIndex, type MarketFetchOptions } from '../plugins/install/market-fetch.js';
import { scanPackInternalRefs } from '../market/pack-internal-refs.js';
import { createPack } from '../knowledge/kgs/pack.js';
import { KgsSqliteStore } from '../knowledge/kgs/sqlite-store.js';
import type { KnowledgeCard, KnowledgeKind } from '../knowledge/kgs/types.js';

export interface GiftInstallOptions {
  pack: string;
  code?: string;
  email?: string;
  agree?: boolean;
  endpoint?: string;
  fetch?: typeof fetch;
  targets?: string[];
  /** Caps (defaults below); tests pass small values. */
  maxDownloadBytes?: number;
  maxUnpackedBytes?: number;
  maxEntries?: number;
}

export type GiftInstallResult =
  | { ok: true; names: string[]; paths: string[]; collisions: string[]; needsKeys: boolean; message: string }
  | { ok: false; reason: string; message: string };

export type KnowledgePackInstallResult =
  | { ok: true; packId: string; citations: string[] }
  | { ok: false; reason: string };

/** Install a named knowledge pack from a configured, signed market; no gift code or skill target is involved. */
export async function installMarketKnowledgePack(input: {
  pack: string;
  market: string;
  enterpriseId?: string;
  marketOptions?: MarketFetchOptions;
  fetch?: typeof fetch;
  store?: Pick<KgsSqliteStore, 'writePack'>;
}): Promise<KnowledgePackInstallResult> {
  try {
    const verified = input.enterpriseId
      ? await ensureInternalMarketIndex(input.market, input.enterpriseId, input.marketOptions)
      : await ensureMarketIndex(input.market, input.marketOptions);
    const entry = verified.index.knowledgePacks?.find(item => item.name === input.pack);
    if (!entry || (input.enterpriseId ? entry.visibility !== 'internal' || entry.enterpriseId !== input.enterpriseId : entry.visibility !== 'public')) {
      return { ok: false, reason: 'pack-not-in-verified-market' };
    }
    const key = entry.artifact.key;
    if (!key || key.startsWith('/') || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')) {
      return { ok: false, reason: 'invalid-artifact-key' };
    }
    const base = new URL(verified.market.url);
    const artifactUrl = new URL(key, base);
    if (key.includes('%') || key.includes('?') || key.includes('#') || base.protocol !== 'https:') return { ok: false, reason: 'invalid-artifact-key' };
    if (artifactUrl.origin !== base.origin || !artifactUrl.pathname.startsWith(base.pathname) || artifactUrl.search || artifactUrl.hash) {
      return { ok: false, reason: 'invalid-artifact-key' };
    }
    if (entry.artifact.bytes > MAX_DOWNLOAD_BYTES) return { ok: false, reason: 'artifact-mismatch' };
    const response = await (input.fetch ?? fetch)(artifactUrl.href, { redirect: 'error' });
    if (!response.ok || response.redirected || (response.url && response.url !== artifactUrl.href)) return { ok: false, reason: 'artifact-download-failed' };
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, reason: 'artifact-download-failed' };
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_DOWNLOAD_BYTES || length > entry.artifact.bytes) { await reader.cancel(); return { ok: false, reason: 'artifact-mismatch' }; }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== entry.artifact.bytes ||
      createHash('sha256').update(bytes).digest('hex').toLowerCase() !== entry.artifact.sha256.toLowerCase()) {
      return { ok: false, reason: 'artifact-mismatch' };
    }
    const archive = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
    const files = new Map<string, string>();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let endOffset = 0;
    for (let offset = 0; offset + 512 <= archive.length;) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) { endOffset = offset; break; }
      const field = (start: number, end: number) => header.subarray(start, end).toString('utf8').replace(/\0.*$/, '');
      const checksum = parseInt(field(148, 156).trim(), 8);
      const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (checksum !== actualChecksum) return { ok: false, reason: 'invalid-archive' };
      const size = parseInt(field(124, 136).trim(), 8);
      const name = field(0, 100);
      const prefix = field(345, 500);
      const path = prefix ? `${prefix}/${name}` : name;
      if (!Number.isSafeInteger(size) || size < 0 || !path || path.includes('\\') ||
        path.split('/').some(part => !part || part === '.' || part === '..') || header[156] !== 48 ||
        offset + 512 + size > archive.length || files.has(path)) return { ok: false, reason: 'invalid-archive' };
      files.set(path, decoder.decode(archive.subarray(offset + 512, offset + 512 + size)));
      offset += 512 + Math.ceil(size / 512) * 512;
      if (files.size > MAX_ENTRIES) return { ok: false, reason: 'invalid-archive' };
    }
    if (!endOffset || archive.length - endOffset < 1024 || !archive.subarray(endOffset).every(byte => byte === 0)) return { ok: false, reason: 'invalid-archive' };
    const manifest = JSON.parse(files.get('knowledge-pack.json') ?? 'null') as Record<string, unknown> | null;
    if (files.size !== (Array.isArray(manifest?.content) ? manifest.content.length + 1 : -1)) return { ok: false, reason: 'invalid-content' };
    if (!manifest || manifest.kind !== 'knowledge-pack' || manifest.name !== entry.name || manifest.version !== entry.version ||
      !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(entry.name) || !/^\d+\.\d+\.\d+$/.test(entry.version) ||
      typeof manifest.description !== 'string' || !manifest.description || manifest.description.length > 200 ||
      !Array.isArray(manifest.content) || !manifest.content.length ||
      !Array.isArray(manifest.dependencies) || manifest.dependencies.length !== 0 ||
      manifest.visibility !== entry.visibility || typeof manifest.license !== 'string' || !manifest.license ||
      !manifest.signature || typeof manifest.signature !== 'object' ||
      (manifest.signature as Record<string, unknown>).algorithm !== 'ed25519' ||
      (manifest.signature as Record<string, unknown>).keyId !== verified.keyId) return { ok: false, reason: 'invalid-manifest' };
    const now = new Date().toISOString();
    const cards: KnowledgeCard[] = [];
    for (const item of manifest.content) {
      if (!item || typeof item !== 'object') return { ok: false, reason: 'invalid-content' };
      const { path, kind } = item as Record<string, unknown>;
      if (typeof path !== 'string' || !/^content\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md$/.test(path) || typeof kind !== 'string' ||
        !['document', 'glossary', 'procedure', 'rule', 'qa'].includes(kind) || !files.has(path)) return { ok: false, reason: 'invalid-content' };
      const body = files.get(path)!;
      cards.push({ schema_version: 2, id: path, createdAt: now, updatedAt: now, author: entry.name,
        title: body.match(/^# (.+)$/m)?.[1] ?? path, body, nature: 'fact',
        kind: ({ procedure: 'playbook', glossary: 'wiki', qa: 'card', rule: 'checklist', document: 'note' } as Record<string, KnowledgeKind>)[kind]!,
        reliability: 'self-reported', source: { kind: 'external', url: artifactUrl.href }, tags: [entry.name] });
    }
    if (cards.length > 200 || new Set(cards.map(card => card.id)).size !== cards.length ||
      scanPackInternalRefs([...files].map(([path, text]) => ({ path, text }))).length) return { ok: false, reason: 'invalid-content' };
    const pack = createPack({ id: { slug: entry.name, version: entry.version }, title: manifest.description as string,
      intent: manifest.description as string, audience: input.enterpriseId ? 'team' : 'public', kind: 'generic',
      author: entry.name, cards });
    if (input.store) input.store.writePack(pack);
    else {
      const store = new KgsSqliteStore();
      try { store.writePack(pack); } finally { store.close(); }
    }
    return { ok: true, packId: `pack:${entry.name}@${entry.version}`, citations: cards.map(card => `pack:${entry.name}@${entry.version}#${card.id}`) };
  } catch {
    return { ok: false, reason: 'knowledge-pack-install-failed' };
  }
}

// GK1 public bundle: packs/elanous-essentials/plugin.json extensions.ai.elanous.bundle.
const ESSENTIAL_SKILLS = ['youtube-master', 'omni-crawl', 'omni-digest', 'diagram-master', 'lecture-note-digitizer'];
// A malicious or broken gift must not exhaust the temp disk: cap the download, the unpacked total and the entry count.
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
export const MAX_ENTRIES = 5000;
const CONSENT_NOTICE = '선물 스킬 전달과 안내 메일을 위해 이메일을 받습니다 · 보관은 알림 신청과 같은 기간 · 동의하면 --agree 를 붙여 다시 시도해 주세요.';
const ERROR_MESSAGES: Record<string, string> = {
  'email-required': CONSENT_NOTICE,
  'consent-required': CONSENT_NOTICE,
  'unknown-code': '코드를 다시 확인해 주세요.',
  'used-up': '이미 다 쓴 코드예요 · 업데이트 소식 신청을 확인해 주세요.',
  expired: '만료된 코드예요.',
};

/** Redeem, verify and install a gift without modifying an existing skill directory. */
export async function installGiftPack({
  pack, code, email, agree, endpoint = 'https://elanous.ai', fetch: fetchImpl = fetch,
  targets = [join(homedir(), '.agents', 'skills'), join(homedir(), '.claude', 'skills')],
  maxDownloadBytes = MAX_DOWNLOAD_BYTES, maxUnpackedBytes = MAX_UNPACKED_BYTES, maxEntries = MAX_ENTRIES,
}: GiftInstallOptions): Promise<GiftInstallResult> {
  const codePrefix = code && code.length > 4 ? code.slice(0, 4) : undefined;
  const reject = (reason: string, message: string): GiftInstallResult => {
    debug.log('skills.gift', 'rejected', { pack, reason, count: 0, codePrefix });
    return { ok: false, reason, message };
  };
  if (!email?.trim() || !agree) return reject(!email?.trim() ? 'email-required' : 'consent-required', CONSENT_NOTICE);
  if (!code?.trim()) return reject('unknown-code', ERROR_MESSAGES['unknown-code']!);
  let gift: Record<string, unknown>;
  try {
    const response = await fetchImpl(`${endpoint.replace(/\/$/, '')}/api/gift`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, email, consent: true }),
    });
    // The gift API assigns these reasons by HTTP status; error bodies may be absent or malformed.
    const statusReason = ({ 404: 'unknown-code', 409: 'used-up', 410: 'expired' } as Record<number, string | undefined>)[response.status];
    if (statusReason) return reject(statusReason, ERROR_MESSAGES[statusReason]!);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return reject('invalid-response', '선물 응답을 확인할 수 없습니다. 다시 시도해 주세요.');
    }
    gift = payload as Record<string, unknown>;
    if (!response.ok) {
      const reason = response.status === 400 && (gift.reason === 'email-required' || gift.reason === 'consent-required')
        ? gift.reason : 'request-rejected';
      return reject(reason, ERROR_MESSAGES[reason] ?? '선물을 받을 수 없습니다. 다시 시도해 주세요.');
    }
  } catch {
    return reject('network-error', '네트워크에 연결할 수 없습니다. 다시 시도해 주세요.');
  }
  if (gift.ok !== true || gift.pack !== pack || typeof gift.zipUrl !== 'string' || !/^https?:\/\//.test(gift.zipUrl)
    || typeof gift.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(gift.sha256)) {
    return reject('invalid-response', '선물 응답을 확인할 수 없습니다. 다시 시도해 주세요.');
  }
  let zip: Buffer;
  const tooLarge = () => reject('too-large', '선물 zip 이 허용 크기를 넘습니다. 설치하지 않았습니다.');
  try {
    const response = await fetchImpl(gift.zipUrl, { redirect: 'error' });
    if (!response.ok) throw new Error('download-failed');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxDownloadBytes) return tooLarge();
    // Count the bytes actually received too — a missing or lying Content-Length must not bypass the cap.
    const chunks: Uint8Array[] = [];
    let received = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxDownloadBytes) { await reader.cancel().catch(() => {}); return tooLarge(); }
        chunks.push(value);
      }
    }
    zip = Buffer.concat(chunks);
  } catch {
    return reject('network-error', '다운로드에 실패했습니다. 다시 시도해 주세요.');
  }
  if (createHash('sha256').update(zip).digest('hex').toLowerCase() !== gift.sha256.toLowerCase()) {
    debug.log('skills.gift', 'checksum-mismatch', { pack, reason: 'sha256', count: 0, codePrefix });
    return { ok: false, reason: 'checksum-mismatch', message: '다운로드 검증(sha256)에 실패했습니다. 설치하지 않았습니다.' };
  }
  const temp = mkdtempSync(join(tmpdir(), 'elanous-gift-'));
  const created: string[] = [];
  let incomplete: string | undefined;
  try {
    const zipPath = join(temp, 'gift.zip');
    const extracted = join(temp, 'extracted');
    mkdirSync(extracted);
    writeFileSync(zipPath, zip);
    // Reject archive symlinks and traversal paths before extracting any entry.
    execFileSync('python3', ['-c', `import os, stat, sys, zipfile
root = sys.argv[2]
max_unpacked = int(sys.argv[3]); max_entries = int(sys.argv[4])
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > max_entries or sum(entry.file_size for entry in entries) > max_unpacked:
        sys.exit(3)
    for entry in entries:
        parts = entry.filename.split('/')
        mode = entry.external_attr >> 16
        if (not entry.filename or entry.filename.startswith('/') or '\\u005c' in entry.filename
            or any(part in ('', '.', '..') for part in parts[:-1])
            or parts[-1] in ('.', '..') or (not entry.is_dir() and not parts[-1])
            or stat.S_ISLNK(mode)):
            raise ValueError('invalid archive entry')
    written = 0
    for entry in entries:
        path = os.path.join(root, entry.filename)
        if entry.is_dir():
            os.makedirs(path, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with archive.open(entry) as source, open(path, 'xb') as target:
                while True:
                    block = source.read(65536)
                    if not block:
                        break
                    written += len(block)
                    if written > max_unpacked:
                        sys.exit(3)
                    target.write(block)
`, zipPath, extracted, String(maxUnpackedBytes), String(maxEntries)], { stdio: 'pipe' });
    const skillDirs = (root: string) => readdirSync(root, { withFileTypes: true })
      // SKILL.md must be a regular file — a `SKILL.md/` directory or a symlink is not a skill.
      .filter((entry) => entry.isDirectory() && lstatSync(join(root, entry.name, 'SKILL.md'), { throwIfNoEntry: false })?.isFile() === true)
      .map((entry) => ({ name: entry.name, path: join(root, entry.name) }));
    let skills = skillDirs(extracted);
    if (!skills.length) {
      const roots = readdirSync(extracted, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => join(extracted, entry.name));
      if (roots.length === 1) {
        skills = skillDirs(roots[0]!);
        if (!skills.length && existsSync(join(roots[0]!, 'skills'))) skills = skillDirs(join(roots[0]!, 'skills'));
      }
    }
    // Directory listing order differs between filesystems — keep the bundle order, then names.
    const rank = (name: string) => { const i = ESSENTIAL_SKILLS.indexOf(name); return i < 0 ? ESSENTIAL_SKILLS.length : i; };
    skills = [...skills].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    if (!skills.length || !targets.length) return reject('invalid-pack', '설치할 스킬 폴더나 대상 경로를 찾지 못했습니다.');
    if (pack === 'essential' && (skills.length !== ESSENTIAL_SKILLS.length
      || ESSENTIAL_SKILLS.some((name) => !skills.some((skill) => skill.name === name)))) {
      return reject('invalid-pack', '필수 스킬 다섯이 모두 들어 있지 않습니다. 설치하지 않았습니다.');
    }
    const paths: string[] = [];
    const collisions: string[] = [];
    const date = new Date().toISOString().slice(0, 10);
    for (const target of targets) {
      mkdirSync(target, { recursive: true });
      for (const skill of skills) {
        const desired = join(target, skill.name);
        let dest = desired;
        if (lstatSync(desired, { throwIfNoEntry: false })) {
          dest = `${desired}.gift-${date}`;
          let n = 2;
          while (lstatSync(dest, { throwIfNoEntry: false })) dest = `${desired}.gift-${date}-${n++}`;
          collisions.push(`${skill.name} → ${dest}`);
        }
        // Reserve the destination exclusively: a concurrent installer must not be overwritten.
        mkdirSync(dest);
        incomplete = dest;
        for (const entry of readdirSync(skill.path)) {
          cpSync(join(skill.path, entry), join(dest, entry), { recursive: true, errorOnExist: true, force: false });
        }
        created.push(dest);
        incomplete = undefined;
        paths.push(dest);
      }
    }
    const names = skills.map((skill) => skill.name);
    const needsKeys = skills.some((skill) => existsSync(join(skill.path, '.env.example')));
    const message = `${collisions.length ? `기존 폴더는 그대로 두고 옆에 설치했습니다: ${collisions.join(', ')}\n` : ''}${needsKeys ? '.env.example 이 있습니다 — 키는 가이드대로 설정해 주세요.\n' : ''}설치한 스킬: ${names.join(', ')}`;
    debug.log('skills.gift', 'installed', { pack, reason: 'ok', count: paths.length, codePrefix });
    return { ok: true, names, paths, collisions, needsKeys, message };
  } catch (error) {
    if ((error as { status?: number }).status === 3 && !created.length) return tooLarge();
    const remaining: string[] = [];
    for (const path of [...(incomplete ? [incomplete] : []), ...created.reverse()]) {
      try { rmSync(path, { recursive: true }); }
      catch { remaining.push(path); }
    }
    if (remaining.length) {
      debug.log('skills.gift', 'rejected', { pack, reason: 'partial-install', count: remaining.length, codePrefix });
      return { ok: false, reason: 'partial-install', message: `일부 설치된 스킬을 되돌리지 못했습니다: ${remaining.join(', ')}` };
    }
    return reject('invalid-pack', '선물 zip 을 안전하게 풀 수 없습니다. 설치하지 않았습니다.');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
