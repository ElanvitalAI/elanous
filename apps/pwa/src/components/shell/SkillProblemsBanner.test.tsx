import { afterEach, expect, test } from 'bun:test';
import { beforeEach as __beforeEach } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { SKILL_REPAIR_CONFIRM, SkillProblemsBanner, __resetSkillProblemsCacheForTests } from './SkillProblemsBanner';
__beforeEach(() => { __resetSkillProblemsCacheForTests(); });


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(async () => { tree!.unmount(); }); tree = undefined; });

function client(items: unknown[], log: Array<{ path: string; method: string; body?: string }>) {
  let current = items;
  return {
    fetchResponse: async (path: string, init?: RequestInit) => {
      log.push({ path, method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) });
      if (init?.method === 'POST') { current = current.filter((i) => (i as { id: string }).id !== JSON.parse(String(init.body)).id); return Response.json({ ok: true }); }
      return Response.json({ items: current });
    },
  };
}
const text = () => JSON.stringify(tree!.toJSON());
const button = (label: string) => tree!.root.findAllByType('button').find((b) => b.props.children === label);

test('no problems → no banner (and no repair call)', async () => {
  const log: Array<{ path: string; method: string }> = [];
  await act(async () => { tree = create(<DaemonContext.Provider value={{ client: client([], log) } as never}><SkillProblemsBanner /></DaemonContext.Provider>); });
  expect(tree!.toJSON()).toBeNull();
  expect(log.map((l) => l.method)).toEqual(['GET']);
});

test('problems → one line; «고치기» asks first, repairs only fixable ones, then reloads', async () => {
  const log: Array<{ path: string; method: string; body?: string }> = [];
  const items = [
    { id: 'a1', name: 'locked', code: 'EACCES', fixable: true },
    { id: 'b2', name: 'theirs', code: 'EACCES', fixable: false, hint: '읽기 권한이 없습니다 — 터미널에서: sudo chmod a+r "…/theirs/SKILL.md"' },
  ];
  let asked = 0; let answer = false;
  await act(async () => { tree = create(<DaemonContext.Provider value={{ client: client(items, log) } as never}><SkillProblemsBanner confirm={(q) => { asked += 1; expect(q).toBe(SKILL_REPAIR_CONFIRM); return answer; }} /></DaemonContext.Provider>); });
  expect(text()).toContain('스킬 2개를 읽지 못했습니다');
  await act(async () => { button('고치기')!.props.onClick(); });
  expect(asked).toBe(1);
  expect(log.filter((l) => l.method === 'POST')).toEqual([]);
  answer = true;
  await act(async () => { button('고치기')!.props.onClick(); });
  expect(log.filter((l) => l.method === 'POST').map((l) => JSON.parse(l.body!).id)).toEqual(['a1']);
  expect(text()).toContain('1개를 고쳤습니다');
  expect(text()).toContain('스킬 1개를 읽지 못했습니다');
  await act(async () => { button('왜 못 고치나')!.props.onClick(); });
  expect(text()).toContain('sudo chmod a+r');
  expect(button('고치기')).toBeUndefined();
});
