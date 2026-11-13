import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { listAbsorbScraps, updateAbsorbScrap, type AbsorbScrapPayload } from '../../intake-plane/items.js';
import { acquireLockAsync, type AsyncLockHandle } from '../../storage/file-lock.js';
import { handleVaultFilePut, handleVaultGet } from './vault-api.js';

export interface VoiceNoteExportOptions {
  instanceRoot: string;
  memberId: string;
  id: string;
  now?: () => Date;
  writeVaultFile?: (input: { path: string; content: string; createOnly: boolean }) => Promise<Response>;
  readVaultFile?: (path: string) => Promise<Response>;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

async function serializeExport<T>(instanceRoot: string, memberId: string, id: string,
  action: (lock: AsyncLockHandle) => Promise<T>): Promise<T> {
  const lockDir = join(instanceRoot, 'voice-export-locks');
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(`${memberId}\0${id}`).digest('hex');
  const lock = await acquireLockAsync(join(lockDir, `${key}.lock`), { breakDeadHolder: true, maxTries: 4_800 });
  try { return await action(lock); }
  finally { lock.release(); }
}

function renderVoiceNote(note: AbsorbScrapPayload): string {
  const title = note.raw.text?.split('\n')[0] || note.card?.title || '음성 노트';
  const timeline = (note.raw.timeline ?? []).map((entry) => `- ${Math.floor(entry.t / 1000)}s ${entry.kind}: ${entry.kind === 'marker' ? entry.label : entry.mediaRef}`);
  return [`# ${title}`, '', `녹음 날짜: ${note.raw.recordedDate ?? '미상'}`,
    `수업일: ${note.raw.classDate ?? '미지정'}`, `녹음 원본: ${note.raw.mediaRef ?? ''}`,
    '', '## 요약', '', note.raw.text ?? '', '', '## 전사', '', note.raw.transcript ?? note.extractedBody ?? '전사 원문 없음',
    '', '## 타임라인', '', ...timeline, ''].join('\n');
}

export async function handleVoiceNoteExport(req: Request, options: VoiceNoteExportOptions): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') return json({ error: 'method not allowed' }, 405);
  const { instanceRoot, memberId, id } = options;
  const item = listAbsorbScraps(instanceRoot, memberId).find((candidate) => candidate.id === id)?.absorb;
  if (!item) return json({ error: 'scrap-not-found' }, 404);
  if (item.kind !== 'voice' || item.status !== 'absorbed') return json({ error: 'voice-note-not-ready' }, 409);
  let input: { vaultId?: unknown; vaultRelativeFolder?: unknown };
  try { input = await req.json() as typeof input; } catch { return json({ error: 'invalid-json' }, 400); }
  if (input?.vaultId !== 'configured' || typeof input.vaultRelativeFolder !== 'string'
    || !input.vaultRelativeFolder || input.vaultRelativeFolder.length > 240
    || input.vaultRelativeFolder.split('/').some((part) => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part))) {
    return json({ error: 'invalid-vault-folder' }, 400);
  }
  const memberNamespace = createHash('sha256').update(memberId).digest('hex');
  const path = `Members/${memberNamespace}/${input.vaultRelativeFolder}/${id}.md`;
  return serializeExport(instanceRoot, memberId, id, async (lock) => {
    const current = listAbsorbScraps(instanceRoot, memberId).find((candidate) => candidate.id === id)?.absorb;
    if (!current) return json({ error: 'scrap-not-found' }, 404);
    if (current.kind !== 'voice' || current.status !== 'absorbed') return json({ error: 'voice-note-not-ready' }, 409);
    const previous = current.exports?.find((receipt) => receipt.vaultId === 'configured' && receipt.path === path);
    if (previous) return json(previous);
    let content = renderVoiceNote(current);
    let contentSha256 = createHash('sha256').update(content).digest('hex');
    const lockLost = () => json({ error: 'export-lock-lost' }, 503);
    const read = options.readVaultFile ?? ((value: string) => handleVaultGet(
      new Request(`http://nexus.test/v1/vault/read?path=${encodeURIComponent(value)}&maxBytes=1048576`), 'read'));
    const finalize = (expectedSha256: string): Response => {
      if (!lock.stillHeld()) return lockLost();
      const latest = listAbsorbScraps(instanceRoot, memberId).find((candidate) => candidate.id === id)?.absorb;
      if (!latest) return json({ error: 'scrap-not-found' }, 404);
      if (!latest.pendingExports?.some((pending) => pending.path === path && pending.contentSha256 === expectedSha256)) {
        return json({ error: 'export-reservation-lost' }, 409);
      }
      const receipt = { vaultId: 'configured', path, savedAt: (options.now ?? (() => new Date()))().toISOString() };
      updateAbsorbScrap(instanceRoot, id, {
        exports: [...(latest.exports ?? []), receipt],
        pendingExports: (latest.pendingExports ?? []).filter((pending) => pending.path !== path),
      });
      return json(receipt, 201);
    };
    const verifyExisting = async (expectedSha256: string, writeMarker?: string): Promise<Response | null> => {
      const response = await read(path);
      if (!lock.stillHeld()) return lockLost();
      if (response.status === 404) return null;
      if (!response.ok) return response;
      const stored = await response.json() as { content?: unknown; truncated?: unknown };
      if (stored.truncated || typeof stored.content !== 'string' || !writeMarker
        || !stored.content.includes(`<!-- elanous-export:${writeMarker} -->`)
        || createHash('sha256').update(stored.content).digest('hex') !== expectedSha256) {
        return json({ error: 'file_exists' }, 409);
      }
      return finalize(expectedSha256);
    };
    const reserve = (previous: typeof current.pendingExports = current.pendingExports): void => {
      const writeMarker = randomUUID();
      content = `${renderVoiceNote(current)}\n<!-- elanous-export:${writeMarker} -->\n`;
      contentSha256 = createHash('sha256').update(content).digest('hex');
      if (!lock.stillHeld()) return;
      updateAbsorbScrap(instanceRoot, id, { pendingExports: [
        ...(previous ?? []).filter((reservation) => reservation.path !== path),
        { vaultId: 'configured', path, contentSha256, content, writeMarker,
          startedAt: (options.now ?? (() => new Date()))().toISOString() },
      ] });
    };
    const pending = current.pendingExports?.find((reservation) => reservation.path === path);
    if (pending) {
      const recovered = await verifyExisting(pending.contentSha256, pending.writeMarker);
      if (recovered) return recovered;
      if (pending.content && pending.writeMarker
        && pending.content.includes(`<!-- elanous-export:${pending.writeMarker} -->`)
        && createHash('sha256').update(pending.content).digest('hex') === pending.contentSha256) {
        // A crash after reservation must retry the exact snapshot, even if the note changed meanwhile.
        content = pending.content;
        contentSha256 = pending.contentSha256;
      } else {
        // Legacy reservations have no write marker. An absent file can be reserved anew.
        if (!lock.stillHeld()) return lockLost();
        reserve();
      }
    } else {
      if (!lock.stillHeld()) return lockLost();
      reserve();
    }
    const write = options.writeVaultFile ?? (async (value: { path: string; content: string; createOnly: boolean }) =>
      handleVaultFilePut(new Request('http://nexus.test/v1/vault/file', { method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-elanous-caller': 'voice-note-export' }, body: JSON.stringify(value) })));
    if (!lock.stillHeld()) return lockLost();
    const response = await write({ path, content, createOnly: true });
    if (!lock.stillHeld()) return lockLost();
    if (response.status === 409) {
      // A definite create-only collision does not prove this request created the file.
      // Drop our reservation so a later identical readback cannot manufacture a receipt.
      const latest = listAbsorbScraps(instanceRoot, memberId).find((candidate) => candidate.id === id)?.absorb;
      if (latest) updateAbsorbScrap(instanceRoot, id, {
        pendingExports: (latest.pendingExports ?? []).filter((reservation) => reservation.path !== path),
      });
      return response;
    }
    if (!response.ok) return response;
    return finalize(contentSha256);
  });
}
