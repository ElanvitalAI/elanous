import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';

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
