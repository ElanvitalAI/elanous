// MEMBER-JOURNEY S1: the signup page never prints or asks for the event code; one line says it was applied.
import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import MemberSignupPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(search: string): Promise<string> {
  const priorWindow = globalThis.window;
  const priorStorage = globalThis.sessionStorage;
  Object.assign(globalThis, { window: { location: { search, assign: () => {} } }, sessionStorage: { setItem: () => {}, getItem: () => null } });
  let tree: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { tree = create(<MemberSignupPage />); });
    const labelled = tree!.root.findAll(node => node.props['aria-label'] === '행사 코드');
    expect(labelled).toHaveLength(0);
    return JSON.stringify(tree!.toJSON());
  } finally {
    if (tree) await act(async () => tree!.unmount());
    Object.assign(globalThis, { window: priorWindow, sessionStorage: priorStorage });
  }
}

test('code in the link: one applied line, the code and its label are never rendered', async () => {
  const out = await render('?code=KCB1114');
  expect(out.includes('KCB1114')).toBe(false);
  expect(out.includes('행사 코드')).toBe(false);
  expect(out.split('초대 코드 적용됨').length - 1).toBe(1);
});

test('no code in the link: no applied line', async () => {
  const out = await render('');
  expect(out.includes('초대 코드 적용됨')).toBe(false);
  expect(out.includes('행사 코드')).toBe(false);
});

test('mixed, empty and whitespace code= links apply eventCode= with one line and no dead end (UX #116886 · JUD #116120)', async () => {
  for (const search of ['?code=&eventCode=KCB1114', '?code=%20&eventCode=KCB1114', '?code=AB12&eventCode=KCB1114']) {
    const out = await render(search);
    expect(out.includes('KCB1114')).toBe(false);
    expect(out.includes('행사 코드')).toBe(false);
    expect(out.split('초대 코드 적용됨').length - 1).toBe(1);
    expect(out.includes('비어 있습니다')).toBe(false);
  }
});
