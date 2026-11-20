import { afterEach, expect, test } from 'bun:test';
import { fetchActivitySnapshot } from './fetch-activity-snapshot';

const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => {
  if (realDocument) Object.defineProperty(globalThis, 'document', realDocument);
  else delete (globalThis as { document?: unknown }).document;
});

test('bare webchat origin asks nothing and keeps the activity strip quiet', async () => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => ({ getAttribute: () => '1' }) } });
  const asked: string[] = [];
  const snapshot = await fetchActivitySnapshot({ fetchImpl: async (path) => { asked.push(path); return new Response('', { status: 404 }); } });
  expect(snapshot).toEqual({ kind: 'quiet' });
  expect(asked).toEqual([]);
});

test('a normal origin still asks and reports a failed activity read', async () => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null } });
  const asked: string[] = [];
  const snapshot = await fetchActivitySnapshot({
    fetchImpl: async (path) => { asked.push(path); return new Response('', { status: 404 }); },
    listProgressFrames: async () => ({ logs: [] }),
  });
  expect(snapshot.kind).toBe('error');
  expect(asked).toEqual(['/v1/terminals']);
});
