import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGraphApprovals } from './graph-approvals.js';
import { applyFeedEdit, resolveFeedMedia, type FeedDraft } from './graph-approvals-feed.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function draft(folder: string): FeedDraft {
  return {
    kind: 'feed-draft', version: 1, revision: 1, updatedAt: '2026-10-01T09:00:00Z', updatedBy: 'graph',
    graphId: 'field-feed', runId: 'run-1', folder,
    brand: { name: 'Elanous', handle: 'elanous.ai', avatar: null },
    event: { title: '행사', date: '2026.10.01' },
    cover: { text: '표지', sub: '현장 스케치', image: 'feed/slide-0.png', renderedText: '표지' },
    slides: [
      { image: 'feed/slide-1.png', source: 'a.jpg', caption: '첫 장', include: true, renderedCaption: '1/2:첫 장' },
      { image: 'feed/slide-2.png', source: 'b.jpg', caption: '둘째 장', include: true, renderedCaption: '2/2:둘째 장' },
    ],
    caption: { hook: '훅', body: '본문' },
    hashtags: ['#행사'],
    location: '한국거래소',
    reel: 'reel/reel-9x16.mp4',
  };
}

function fixture(opts: { message?: string; folder?: (configDir: string) => string; status?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'feed-approvals-'));
  dirs.push(base);
  const root = join(base, 'instance');
  const configDir = join(base, 'config');
  const folder = join(configDir, 'field', 'night-2026');
  mkdirSync(join(folder, 'feed'), { recursive: true });
  mkdirSync(join(folder, 'reel'), { recursive: true });
  for (const name of ['slide-0.png', 'slide-1.png', 'slide-2.png']) writeFileSync(join(folder, 'feed', name), 'png');
  writeFileSync(join(folder, 'reel', 'reel-9x16.mp4'), 'mp4');
  writeFileSync(join(folder, 'secret.txt'), 'nope');
  writeFileSync(join(folder, 'feed', 'feed-draft.json'), JSON.stringify(draft(folder)));
  const runs = join(root, 'graph-runs', 'field-feed');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, 'run-1.json'), JSON.stringify({
    graphId: 'field-feed', runId: 'run-1', status: opts.status ?? 'awaiting-approval', path: ['feed', 'post'],
    input: { folder: opts.folder ? opts.folder(configDir) : folder },
    nodes: [{ nodeId: 'feed', ok: true }],
    pending: { nodeId: 'post', message: opts.message ?? '{"kind":"feed-preview"}', since: '2026-10-01T09:00:00Z' },
  }));
  return { root, configDir, folder };
}

function call(fx: { root: string; configDir: string }, path: string, init: RequestInit = {}, authReason = 'bearer-match') {
  return handleGraphApprovals(new Request(`http://localhost${path}`, init), {
    authorize: () => true, authReason: () => authReason, root: fx.root, configDir: fx.configDir,
  });
}

const edit = (overrides: Record<string, unknown> = {}) => ({
  slides: [{ image: 'feed/slide-2.png', caption: '둘째 장!', include: true }, { image: 'feed/slide-1.png', include: false }],
  caption: { hook: '새 훅', body: '새 본문' }, hashtags: ['#행사', ' #마케터 '], cover: { text: '새 표지', sub: '부제' }, location: null,
  ...overrides,
});

test('a feed-preview approval lists its draft as feed (without the absolute folder); other approvals stay as they were', async () => {
  const fx = fixture();
  const body = await (await call(fx, '/v1/graph-approvals')).json() as { items: Array<{ graphId: string; feed?: Record<string, unknown>; message: string }> };
  expect(body.items).toHaveLength(1);
  expect(body.items[0]!.feed?.kind).toBe('feed-draft');
  expect(body.items[0]!.feed?.revision).toBe(1);
  expect(body.items[0]!.feed).not.toHaveProperty('folder');
  expect(JSON.stringify(body)).not.toContain(fx.folder);

  const plain = fixture({ message: '게시할까요?' });
  const plainBody = await (await call(plain, '/v1/graph-approvals')).json() as { items: Array<{ feed?: unknown; message: string }> };
  expect(plainBody.items[0]!.feed).toBeUndefined();
  expect(plainBody.items[0]!.message).toBe('게시할까요?');
});

test('a run folder outside <configDir>/field/<slug> is not a feed (no draft read, no media)', async () => {
  const outside = fixture({ folder: (configDir) => join(configDir, '..', 'elsewhere') });
  mkdirSync(join(outside.configDir, '..', 'elsewhere', 'feed'), { recursive: true });
  const body = await (await call(outside, '/v1/graph-approvals')).json() as { items: Array<{ feed?: unknown }> };
  expect(body.items[0]!.feed).toBeUndefined();
  expect((await call(outside, '/v1/graph-approvals/field-feed/run-1/media?path=feed/slide-1.png')).status).toBe(404);

  const linked = fixture();
  const link = join(linked.configDir, 'field', 'linked-slug');
  symlinkSync(join(linked.configDir, '..'), link);
  const viaLink = fixture({ folder: () => link });
  const linkBody = await (await call({ ...viaLink, configDir: linked.configDir }, '/v1/graph-approvals')).json() as { items: Array<{ feed?: unknown }> };
  expect(linkBody.items[0]!.feed).toBeUndefined();
});

test('PUT feed-draft saves only the editable fields, bumps the revision, keeps rendered* fields, and leaves the approval pending', async () => {
  const fx = fixture();
  const response = await call(fx, '/v1/graph-approvals/field-feed/run-1/feed-draft', { method: 'PUT', body: JSON.stringify(edit()) });
  expect(response.status).toBe(200);
  const saved = JSON.parse(readFileSync(join(fx.folder, 'feed', 'feed-draft.json'), 'utf8')) as FeedDraft;
  expect(saved.revision).toBe(2);
  expect(saved.updatedBy).toBe('human');
  expect(saved.slides.map((slide) => [slide.image, slide.include, slide.caption])).toEqual([
    ['feed/slide-2.png', true, '둘째 장!'], ['feed/slide-1.png', false, '첫 장'],
  ]);
  expect(saved.slides[0]!.renderedCaption).toBe('2/2:둘째 장');
  expect(saved.slides[0]!.source).toBe('b.jpg');
  expect(saved.cover).toEqual({ text: '새 표지', sub: '부제', image: 'feed/slide-0.png', renderedText: '표지' });
  expect(saved.caption).toEqual({ hook: '새 훅', body: '새 본문' });
  expect(saved.hashtags).toEqual(['#행사', '#마케터']);
  expect(saved.location).toBeNull();
  expect(saved.folder).toBe(fx.folder);
  const state = JSON.parse(readFileSync(join(fx.root, 'graph-runs', 'field-feed', 'run-1.json'), 'utf8')) as { status: string; pending: { decision?: string } };
  expect(state.status).toBe('awaiting-approval');
  expect(state.pending.decision).toBeUndefined();
});

test('PUT refuses new or missing images, decided runs, unpaired callers, and bodies that are not an edit', async () => {
  const fx = fixture();
  const put = (body: unknown, authReason?: string) => call(fx, '/v1/graph-approvals/field-feed/run-1/feed-draft', { method: 'PUT', body: JSON.stringify(body) }, authReason);
  expect((await put(edit({ slides: [{ image: '../../secret.txt' }, { image: 'feed/slide-1.png' }] }))).status).toBe(400);
  expect((await put(edit({ slides: [{ image: 'feed/slide-1.png' }] }))).status).toBe(400);
  expect((await put(edit({ slides: [{ image: 'feed/slide-1.png' }, { image: 'feed/slide-1.png' }] }))).status).toBe(400);
  expect((await put({ caption: 'x' })).status).toBe(400);
  expect((await put(edit(), 'same-origin')).status).toBe(403);
  expect(JSON.parse(readFileSync(join(fx.folder, 'feed', 'feed-draft.json'), 'utf8')).revision).toBe(1);

  const decided = fixture({ status: 'done' });
  expect((await call(decided, '/v1/graph-approvals/field-feed/run-1/feed-draft', { method: 'PUT', body: JSON.stringify(edit()) })).status).toBe(409);
});

test('media serves only feed images and the reel inside the run folder', async () => {
  const fx = fixture();
  const ok = await call(fx, '/v1/graph-approvals/field-feed/run-1/media?path=feed/slide-1.png');
  expect(ok.status).toBe(200);
  expect(ok.headers.get('content-type')).toBe('image/png');
  expect(await ok.text()).toBe('png');
  expect((await call(fx, '/v1/graph-approvals/field-feed/run-1/media?path=reel/reel-9x16.mp4')).headers.get('content-type')).toBe('video/mp4');
  for (const path of ['secret.txt', '../secret.txt', 'feed/../secret.txt', '/etc/passwd', 'feed/feed-draft.json', 'feed/missing.png', '']) {
    expect((await call(fx, `/v1/graph-approvals/field-feed/run-1/media?path=${encodeURIComponent(path)}`)).status).toBe(404);
  }
  expect(resolveFeedMedia(fx.folder, 'feed/./slide-1.png')).toBeNull();
});

test('applyFeedEdit never changes approval-irrelevant fields', () => {
  const base = draft('/x');
  const result = applyFeedEdit(base, edit(), new Date('2026-10-01T10:00:00Z'));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.draft.reel).toBe(base.reel);
  expect(result.draft.brand).toEqual(base.brand);
  expect(result.draft.updatedAt).toBe('2026-10-01T10:00:00.000Z');
});
