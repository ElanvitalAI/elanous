import { describe, expect, it } from 'bun:test';

import type { DaemonClient } from './daemon-client';
import { VaultApi } from './vault-api';

const payload = { path: 'note.md', markdown: '# edited', lastKnownMtime: 100 };

function makeApi(response: Response): VaultApi {
  const client = {
    fetchResponse: async (path: string, init?: RequestInit) => {
      expect(path).toBe('/v1/notes/save');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual(payload);
      return response;
    },
    fetchJson: () => { throw new Error('saveNote must use fetchResponse'); },
  } as unknown as DaemonClient;
  return new VaultApi(client);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('VaultApi.writeNote', () => {
  const writePayload = { path: 'note.md', content: '# edited', lastKnownMtime: 100 };
  function writeApi(response: Response): VaultApi {
    return new VaultApi({
      fetchResponse: async (path: string, init?: RequestInit) => {
        expect(path).toBe('/v1/vault/file');
        expect(init?.method).toBe('PUT');
        expect(init?.headers).toEqual({ 'content-type': 'application/json' });
        expect(JSON.parse(String(init?.body))).toEqual(writePayload);
        return response;
      },
      fetchJson: () => { throw new Error('writeNote must use fetchResponse'); },
    } as unknown as DaemonClient);
  }
  it('returns successful response and 409 conflict bodies unchanged', async () => {
    const saved = { path: 'note.md', mtimeMs: 456 };
    const conflict = { error: 'mtime_conflict', currentMtime: 123, lastKnownMtime: 100, path: 'note.md' };
    expect(await writeApi(jsonResponse(200, saved)).writeNote(writePayload)).toEqual(saved);
    expect(await writeApi(jsonResponse(409, conflict)).writeNote(writePayload)).toEqual(conflict);
  });
  it('passes the create-only precondition and returns duplicate conflicts without throwing', async () => {
    const duplicate = { error: 'file_exists', path: 'note.md' };
    const api = new VaultApi({
      fetchResponse: async (path: string, init?: RequestInit) => {
        expect(path).toBe('/v1/vault/file');
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(String(init?.body))).toEqual({ path: 'note.md', content: '# new', createOnly: true });
        return jsonResponse(409, duplicate);
      },
    } as unknown as DaemonClient);
    expect(await api.writeNote({ path: 'note.md', content: '# new', createOnly: true })).toEqual(duplicate);
  });
  it('쓰기 가드 403 은 서버의 사람용 문장을 보인다(코드가 아니라)', async () => {
    await expect(writeApi(jsonResponse(403, { error: 'vault-write-blocked-test-universe', path: 'note.md', message: '격리(test) 우주에서는 운영 Obsidian 볼트에 쓰지 않는다' })).writeNote(writePayload))
      .rejects.toThrow('격리(test) 우주에서는 운영 Obsidian 볼트에 쓰지 않는다');
  });

  it('throws on other errors', async () => {
    await expect(writeApi(jsonResponse(503, { error: 'obsidian-vault-unavailable' })).writeNote(writePayload))
      .rejects.toThrow('obsidian-vault-unavailable');
  });
});

describe('VaultApi.saveNote', () => {
  it('returns the 409 mtime conflict body instead of throwing', async () => {
    const conflict = { error: 'mtime_conflict', currentMtime: 123, lastKnownMtime: 100, path: 'note.md' };
    const result = await makeApi(jsonResponse(409, conflict)).saveNote(payload);
    expect(result).toEqual(conflict);
    expect(result.currentMtime).toBe(123);
  });

  it('returns the 200 save body unchanged', async () => {
    const saved = { path: 'note.md', mtimeMs: 456 };
    expect(await makeApi(jsonResponse(200, saved)).saveNote(payload)).toEqual(saved);
  });

  it('throws on 500 with reason before error', async () => {
    await expect(makeApi(jsonResponse(500, { reason: 'disk unavailable', error: 'save_failed' })).saveNote(payload))
      .rejects.toThrow('disk unavailable');
  });

  it('throws on other failures with error or status fallback', async () => {
    await expect(makeApi(jsonResponse(500, { error: 'save_failed' })).saveNote(payload))
      .rejects.toThrow('save_failed');
    await expect(makeApi(jsonResponse(503, {})).saveNote(payload))
      .rejects.toThrow('503');
  });
});
