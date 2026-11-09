import { expect, test } from 'bun:test';
import { selectRemotePrimary } from '../control-plane/remote-primary-candidates.js';

const candidates = [
  { machine: 'mbp', url: 'https://mbp.example:8413', token: 'a'.repeat(64) },
  { machine: 'node-b', url: 'https://node-b.example:8413', token: 'b'.repeat(64) },
];

test('HQ move follower selects the serving advertisement, moves, and closes on stale or unreadable advertisements', async () => {
  let holder = 'mbp';
  let generation = 7;
  let oldReachable = true;
  let newReachable = true;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const machine = url.includes('node-b') ? 'node-b' : 'mbp';
    if (machine === 'mbp' && !oldReachable || machine === 'node-b' && !newReachable) throw new Error('offline');
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${machine === 'mbp' ? candidates[0]!.token : candidates[1]!.token}`);
    expect(init?.redirect).toBe('error');
    return Response.json({ holder, generation, known: true, serving: holder === machine });
  };
  expect(await selectRemotePrimary(candidates, fetcher)).toMatchObject({ kind: 'present', holder: 'mbp', generation: 7, url: candidates[0]!.url });
  holder = 'node-b'; generation = 8;
  expect(await selectRemotePrimary(candidates, fetcher)).toMatchObject({ kind: 'present', holder: 'node-b', generation: 8, url: candidates[1]!.url });
  holder = 'mbp'; generation = 7; newReachable = false;
  expect(await selectRemotePrimary(candidates, fetcher, 8)).toMatchObject({ kind: 'unmeasured', why: 'HQ primary generation 회귀' });
  holder = 'node-b'; generation = 8; newReachable = true;
  oldReachable = false;
  expect(await selectRemotePrimary(candidates, fetcher)).toMatchObject({ kind: 'present', holder: 'node-b', generation: 8 });
  newReachable = false;
  expect(await selectRemotePrimary(candidates, fetcher)).toMatchObject({ kind: 'unmeasured' });
  expect(await selectRemotePrimary(candidates, async () => Response.json({ holder: 'node-b', generation: 8, known: false, serving: false })))
    .toMatchObject({ kind: 'unmeasured' });
  expect(await selectRemotePrimary(candidates, async () => Response.json({ holder: 'outsider', generation: 9, known: true, serving: true })))
    .toMatchObject({ kind: 'unmeasured' });
  expect(await selectRemotePrimary(candidates, async input => Response.json({
    holder: String(input).includes('node-b') ? 'node-b' : 'mbp', generation: 8, known: true, serving: true,
  }))).toMatchObject({ kind: 'unmeasured', why: 'HQ primary endpoint 광고 충돌' });
});
