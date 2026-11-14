import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import MemberSignupPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('signup requires an explicit newsletter decision and preserves decline in the member request', async () => {
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  let posted: unknown;
  Object.assign(globalThis, {
    window: { location: { search: '?code=KCB1114', assign: () => {} } },
    fetch: async (_url: string, init: RequestInit) => {
      posted = JSON.parse(String(init.body));
      return Response.json({ authorizationUrl: 'https://accounts.example.test/authorize' }, { status: 201 });
    },
  });
  let tree: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { tree = create(<MemberSignupPage />); });
    const newsletterChoices = tree!.root.findAllByType('input').filter(input => input.props.name === 'newsletterPreference');
    expect(newsletterChoices).toHaveLength(2);
    expect(newsletterChoices.every(input => !input.props.checked)).toBe(true);
    const terms = tree!.root.findAllByType('input').find(input => input.props.type === 'checkbox')!;
    await act(async () => { terms.props.onChange({ target: { checked: true } }); });
    expect(tree!.root.findByType('button').props.disabled).toBe(true);
    await act(async () => { newsletterChoices.find(input => input.props.value === 'declined')!.props.onChange(); });
    await act(async () => { await tree!.root.findByType('button').props.onClick(); });
    expect(posted).toMatchObject({ newsletterPreference: { choice: 'declined', revision: 'newsletter-v1' } });
  } finally {
    if (tree) await act(async () => tree!.unmount());
    Object.assign(globalThis, { window: priorWindow, fetch: priorFetch });
  }
});
