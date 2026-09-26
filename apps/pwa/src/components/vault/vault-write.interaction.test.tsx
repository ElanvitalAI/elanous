import { createRequire } from 'node:module';
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { createReactHookHarness } from '@/lib/testing/react-hook-harness';
import * as realDaemonProvider from '@/components/providers/DaemonProvider';

// R-TST23 — mock.module 은 프로세스 전역이다. 끝에 원본으로 되돌린다.
const originalDaemonProvider = { ...realDaemonProvider };

const harness = createReactHookHarness(createRequire(import.meta.url)('react'));
const requests: Array<{ path: string; method?: string; body: unknown }> = [];
const reads: string[] = [];
let readMtime = 123;
let writeResponse: { status: number; body: unknown } = { status: 200, body: { path: 'note.md', mtimeMs: 124 } };
const client = {
  fetchJson: async (path: string) => {
    if (path.startsWith('/v1/vault/read?')) {
      reads.push(path);
      return { path: 'note.md', content: '# original', mtimeMs: readMtime };
    }
    if (path === '/v1/vault/backlinks') return { matches: [] };
    if (path.startsWith('/v1/vault/backlinks?')) return { matches: [] };
    if (path === '/v1/vault/templates') return { templates: [] };
    throw new Error(`unexpected vault read: ${path}`);
  },
  fetchResponse: async (path: string, init?: RequestInit) => {
    requests.push({ path, method: init?.method, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(writeResponse.body), {
      status: writeResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  },
};
const daemon = { client };
mock.module('@/components/providers/DaemonProvider', () => ({ useDaemon: () => daemon }));
afterAll(() => {
  harness.unmount();
  mock.module('@/components/providers/DaemonProvider', () => originalDaemonProvider);
});
beforeEach(() => {
  harness.unmount();
  requests.length = 0;
  reads.length = 0;
  readMtime = 123;
  writeResponse = { status: 200, body: { path: 'note.md', mtimeMs: 124 } };
});

function button(label: string) {
  return harness.find((element) => typeof element.props.onClick === 'function' && harness.textOf(element) === label);
}

async function click(label: string) {
  harness.act(() => (button(label).props.onClick as () => void)());
  await harness.settle();
}

test('the first editor save writes the opened path and passes the GET mtime', async () => {
  const { NoteEditor } = await import('./NoteEditor');
  harness.render(NoteEditor as never, { path: 'Nested/note.md', onClose: () => {} });
  await harness.settle();
  await click('저장');
  expect(reads).toEqual(['/v1/vault/read?path=Nested%2Fnote.md&maxBytes=8388608']);
  expect(requests).toEqual([{
    path: '/v1/vault/file', method: 'PUT',
    body: { path: 'Nested/note.md', content: '# original', lastKnownMtime: 123 },
  }]);
});

test('the editor displays an mtime conflict instead of a saved indication', async () => {
  writeResponse = { status: 409, body: { error: 'mtime_conflict', currentMtime: 130, lastKnownMtime: 123, path: 'note.md' } };
  const { NoteEditor } = await import('./NoteEditor');
  harness.render(NoteEditor as never, { path: 'note.md', onClose: () => {} });
  await harness.settle();
  await click('저장');
  expect(harness.findAll((element) => element.type === 'span' && harness.textOf(element) === '⚠ 충돌')).toHaveLength(1);
  expect(harness.findAll((element) => element.type === 'span' && harness.textOf(element) === '✓ 저장됨')).toHaveLength(0);
});

test('a conflict without currentMtime (note deleted on disk) still shows the conflict', async () => {
  writeResponse = { status: 409, body: { error: 'mtime_conflict', lastKnownMtime: 123, path: 'note.md' } };
  const { NoteEditor } = await import('./NoteEditor');
  harness.render(NoteEditor as never, { path: 'note.md', onClose: () => {} });
  await harness.settle();
  await click('저장');
  expect(harness.findAll((element) => element.type === 'span' && harness.textOf(element) === '⚠ 충돌')).toHaveLength(1);
  expect(harness.findAll((element) => element.type === 'span' && harness.textOf(element) === '✗ 오류')).toHaveLength(0);
});

test('new notes use create-only, and a duplicate never calls onCreated', async () => {
  writeResponse = { status: 409, body: { error: 'file_exists', path: 'title.md' } };
  const created: string[] = [];
  const { NewNoteDialog } = await import('./NewNoteDialog');
  harness.render(NewNoteDialog as never, { onClose: () => {}, onCreated: (path: string) => created.push(path) });
  await harness.settle();
  const input = harness.find((element) => element.type === 'input');
  harness.act(() => (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'title' } }));
  await click('생성');
  expect(requests).toEqual([{
    path: '/v1/vault/file', method: 'PUT', body: { path: 'title.md', content: '# title\n\n', createOnly: true },
  }]);
  expect(created).toEqual([]);
  expect(harness.findAll((element) => element.type === 'p' && harness.textOf(element) === '이미 존재하는 노트입니다')).toHaveLength(1);
});

test('daily note uses the Daily directory and a create-only request', async () => {
  const created: string[] = [];
  const { NewNoteDialog } = await import('./NewNoteDialog');
  harness.render(NewNoteDialog as never, { onClose: () => {}, onCreated: (path: string) => created.push(path) });
  await harness.settle();
  await click('오늘 데일리노트');
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  expect(requests).toEqual([{
    path: '/v1/vault/file', method: 'PUT',
    body: { path: `Daily/${date}.md`, content: `# ${date}\n\n## 오늘\n\n- \n`, createOnly: true },
  }]);
  expect(created).toEqual([`Daily/${date}.md`]);
});
