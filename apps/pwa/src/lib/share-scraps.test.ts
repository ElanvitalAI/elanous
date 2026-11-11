import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleScraps } from '../../../../src/nexus/api/scraps';
import { saveSharedScraps, ScrapsUnavailableError } from './share-scraps';
import type { SharedPayload } from './share-target-store';

function payload(files: File[] = []): SharedPayload {
  return { id: 'share-1', title: '읽을거리', text: 'https://youtu.be/abc', url: '', files,
    fileKeys: files.map((_, index) => `file-${index}`), combinedText: '' };
}

test('fake member session, signed media upload, and scraps ingest cover Web Share Target kinds', async () => {
  const posted: Array<{ kind: string; source: string; raw: Record<string, string>; memberId?: string }> = [];
  const uploads: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/members') {
      expect(init?.credentials).toBe('include');
      return Response.json({ member: { id: 'member-a' }, appSlot: { appSlug: 'my-app' } });
    }
    if (url.pathname.endsWith('/storage/uploads')) {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer daemon-token' });
      const body = JSON.parse(String(init?.body));
      expect(body.key.startsWith('scraps/share-share-1-')).toBe(true);
      expect(body.key.includes('member-a')).toBe(false);
      return Response.json({ url: `https://nexus.test/upload/${encodeURIComponent(body.key)}` });
    }
    if (url.pathname.startsWith('/upload/')) {
      uploads.push(url.pathname);
      expect(init?.method).toBe('PUT');
      return new Response(null, { status: 201 });
    }
    if (url.pathname === '/v1/scraps') {
      expect(init?.credentials).toBe('include');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      posted.push(body);
      return Response.json({ id: `scrap-${posted.length}`, status: 'absorbed' }, { status: 201 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const files = [
    new File(['photo'], 'image.png'),
    new File(['sound'], 'sound.ogg', { type: 'audio/ogg' }),
    new File(['movie'], 'movie.mp4', { type: 'video/mp4' }),
  ];
  const result = await saveSharedScraps(payload(files), { baseUrl: 'https://nexus.test', daemonToken: 'daemon-token', fetcher });
  expect(result.failed).toEqual([]);
  expect(posted.map((item) => item.kind)).toEqual(['youtube', 'photo', 'voice', 'video']);
  expect(posted[0]?.raw.text).toContain('읽을거리');
  expect(posted.every((item) => item.source === 'pwa' && item.memberId === undefined)).toBe(true);
  expect(posted.filter((item) => item.raw.mediaRef).every((item) => item.raw.mediaRef!.startsWith('scraps/share-share-1-'))).toBe(true);
  expect(posted.filter((item) => item.raw.mediaRef).every((item) => !item.raw.mediaRef!.includes('member-a'))).toBe(true);
  expect(uploads).toHaveLength(3);
});

test('PWA media object key is accepted and member-scoped by the landed ABSORB route', async () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'pwa-share-absorb-'));
  try {
    let sentMediaRef = '';
    let normalizedMediaRef = '';
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/members') return Response.json({ member: { id: 'member-a' }, appSlot: { appSlug: 'my-app' } });
      if (path.endsWith('/storage/uploads')) return Response.json({ url: 'https://nexus.test/upload/photo' });
      if (path === '/upload/photo') return new Response(null, { status: 201 });
      if (path === '/v1/scraps') {
        const body = JSON.parse(String(init?.body)) as { raw: { mediaRef: string }; memberId?: string };
        sentMediaRef = body.raw.mediaRef;
        expect(body.memberId).toBeUndefined();
        const response = await handleScraps(new Request(String(input), init), {
          instanceRoot, resolveOwner: async () => ({ memberId: 'member-a' }),
          extractors: { ocrPhoto: async () => 'Photo words' },
        });
        normalizedMediaRef = (await response.clone().json() as { raw: { mediaRef: string } }).raw.mediaRef;
        return response;
      }
      throw new Error(`unexpected ${path}`);
    };
    const result = await saveSharedScraps({ ...payload([new File(['photo'], 'image.png')]), text: '', title: '' }, {
      baseUrl: 'https://nexus.test', daemonToken: 'daemon-token', fetcher,
    });
    expect(result.failed).toEqual([]);
    expect(result.saved).toEqual(['image.png']);
    expect(sentMediaRef.startsWith('scraps/')).toBe(true);
    expect(sentMediaRef.split('/')).toHaveLength(2);
    expect(normalizedMediaRef).toBe(`member-a/${sentMediaRef}`);
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
  }
});

test('embedded URL is classified as a link and keeps surrounding commentary', async () => {
  const posted: Array<{ kind: string; raw: { text: string; url: string } }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/members') return Response.json({ member: { id: 'member-a' } });
    if (init?.method === 'GET') return Response.json({ scraps: [] });
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'scrap-1' }, { status: 201 });
  };
  await saveSharedScraps({ ...payload(), title: '', text: 'Read this: https://example.test/a. Great idea.' }, { baseUrl: 'https://nexus.test', fetcher });
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ kind: 'web', raw: { url: 'https://example.test/a', text: 'Read this: https://example.test/a. Great idea.' } });
});

test('a second shared URL remains available as text alongside the classified link', async () => {
  const posted: Array<{ kind: string; raw: { text?: string; url?: string } }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/scraps' && init?.method === 'GET') return Response.json({ scraps: [] });
    if (path === '/v1/members') return Response.json({ member: { id: 'member-a' } });
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `scrap-${posted.length}` }, { status: 201 });
  };
  await saveSharedScraps({ ...payload(), title: '', url: 'https://example.test/one', text: 'See https://example.test/two as well' }, { baseUrl: 'https://nexus.test', fetcher });
  expect(posted.map((entry) => entry.kind)).toEqual(['web', 'text']);
  expect(posted[0]?.raw.text).toBeUndefined();
  expect(posted[1]?.raw.text).toContain('https://example.test/two');
});

test('media without supported upload credential keeps the share for chat', async () => {
  let signed = false;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/members') return Response.json({ member: { id: 'member-a' }, appSlot: { appSlug: 'my-app' } });
    if (path === '/v1/scraps' && init?.method === 'GET') return Response.json({ scraps: [] });
    if (path.endsWith('/storage/uploads')) {
      signed = true;
    }
    throw new Error(`unexpected ${path}`);
  };
  await expect(saveSharedScraps(payload([new File(['photo'], 'image.png')]), { baseUrl: 'https://nexus.test', fetcher })).rejects.toBeInstanceOf(ScrapsUnavailableError);
  expect(signed).toBe(false);
});

test('media with no app slot or a rejected upload signature preserves chat handoff', async () => {
  const media = { ...payload([new File(['photo'], 'photo.png')]), title: '', text: '' };
  for (const outcome of ['no-slot', 'sign-401', 'sign-403'] as const) {
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/members') return Response.json({ member: { id: 'member-a' },
        ...(outcome === 'no-slot' ? {} : { appSlot: { appSlug: 'my-app' } }) });
      if (path.endsWith('/storage/uploads')) return Response.json({ error: 'denied' }, { status: outcome === 'sign-401' ? 401 : 403 });
      throw new Error(`unexpected ${path}`);
    };
    await expect(saveSharedScraps(media, { baseUrl: 'https://nexus.test', daemonToken: 'daemon-token', fetcher })).rejects.toBeInstanceOf(ScrapsUnavailableError);
  }
});

test('non-HTTP shared URL is retained as text instead of disappearing', async () => {
  const posted: Array<{ kind: string; raw: { text: string } }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/members') return Response.json({ member: { id: 'member-a' } });
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'scrap-1' }, { status: 201 });
  };
  await saveSharedScraps({ ...payload(), title: '', text: '', url: 'mailto:person@example.test' }, { baseUrl: 'https://nexus.test', fetcher });
  expect(posted).toEqual([{ kind: 'text', source: 'pwa', raw: { text: 'mailto:person@example.test' } }]);
});

test('non-HTTP URL remains in the scrap when commentary contains an HTTP link', async () => {
  const posted: Array<{ kind: string; raw: { text: string; url: string } }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/members') return Response.json({ member: { id: 'member-a' } });
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'scrap-1' }, { status: 201 });
  };
  await saveSharedScraps({ ...payload(), title: '', text: 'Read https://example.test/story', url: 'mailto:person@example.test' }, {
    baseUrl: 'https://nexus.test', fetcher,
  });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.raw.url).toBe('https://example.test/story');
  expect(posted[0]?.raw.text).toContain('mailto:person@example.test');
});

test('non-HTTP shared URL survives when commentary has multiple HTTP links', async () => {
  const posted: Array<{ kind: string; raw: { text?: string; url?: string } }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/members') return Response.json({ member: { id: 'member-a' } });
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `scrap-${posted.length}` }, { status: 201 });
  };
  await saveSharedScraps({ ...payload(), title: '', text: 'Read https://example.test/one and https://example.test/two', url: 'mailto:person@example.test' }, {
    baseUrl: 'https://nexus.test', fetcher,
  });
  expect(posted.map((entry) => entry.kind)).toEqual(['web', 'text']);
  expect(posted[1]?.raw.text).toContain('https://example.test/two');
  expect(posted[1]?.raw.text).toContain('mailto:person@example.test');
});

test('explicit HTTP URL retains trailing punctuation that belongs to the URL', async () => {
  const posted: Array<{ kind: string; raw: { text?: string; url?: string } }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/members') return Response.json({ member: { id: 'member-a' } });
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'scrap-1' }, { status: 201 });
  };
  const exactUrl = 'https://example.test/what?!.';
  await saveSharedScraps({ ...payload(), title: '', text: '', url: exactUrl }, { baseUrl: 'https://nexus.test', fetcher });
  expect(posted).toEqual([{ kind: 'web', source: 'pwa', raw: { url: exactUrl } }]);
});

test('unavailable ABSORB route preserves the share for the chat fallback', async () => {
  const fetcher: typeof fetch = async (input) => new URL(String(input)).pathname === '/v1/members'
    ? Response.json({ member: { id: 'member-a' } })
    : Response.json({ error: 'not-found' }, { status: 404 });
  await expect(saveSharedScraps(payload(), { baseUrl: 'https://nexus.test', fetcher })).rejects.toBeInstanceOf(ScrapsUnavailableError);
});

test('media-only share falls back when its scrap POST route is unavailable', async () => {
  let uploaded = false;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/members') return Response.json({ member: { id: 'member-a' }, appSlot: { appSlug: 'my-app' } });
    if (path.endsWith('/storage/uploads')) return Response.json({ url: 'https://nexus.test/upload/photo' });
    if (path === '/upload/photo') { uploaded = true; return new Response(null, { status: 201 }); }
    if (path === '/v1/scraps') {
      expect(init?.method).toBe('POST');
      return Response.json({ error: 'not-found' }, { status: 404 });
    }
    throw new Error(`unexpected ${path}`);
  };
  await expect(saveSharedScraps({ ...payload([new File(['photo'], 'photo.png')]), title: '', text: '' }, {
    baseUrl: 'https://nexus.test', daemonToken: 'daemon-token', fetcher,
  })).rejects.toBeInstanceOf(ScrapsUnavailableError);
  expect(uploaded).toBe(true);
});

test('member network, authorization, and malformed-response errors preserve chat handoff', async () => {
  for (const outcome of ['network', 'forbidden', 'malformed'] as const) {
    const fetcher: typeof fetch = async () => {
      if (outcome === 'network') throw new Error('offline');
      if (outcome === 'forbidden') return Response.json({ error: 'forbidden' }, { status: 403 });
      return Response.json({ member: {} });
    };
    await expect(saveSharedScraps(payload(), { baseUrl: 'https://nexus.test', fetcher })).rejects.toBeInstanceOf(ScrapsUnavailableError);
  }
});

test('member session failure keeps the share for the chat fallback', async () => {
  let posted = false;
  const fetcher: typeof fetch = async (input) => {
    if (new URL(String(input)).pathname === '/v1/members') return Response.json({ error: 'unauthorized' }, { status: 401 });
    posted = true;
    return Response.json({ id: 'unexpected' });
  };
  await expect(saveSharedScraps(payload(), { baseUrl: 'https://nexus.test', fetcher })).rejects.toBeInstanceOf(ScrapsUnavailableError);
  expect(posted).toBe(false);
});
