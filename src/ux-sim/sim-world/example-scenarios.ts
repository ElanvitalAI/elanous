// Reference world module for SIM-WORLD-KERNEL: the shape every world hand copies, and the fixture the kernel tests
// point a temporary pack at. It is in no built-in pack, so `sim world run all` never runs it.
//   K01 pass (device + contract + walk + seam + random) · K02 red for its declared reason · K03 throws → infra-error
//   K04 graph-only · K05 names an unregistered device · K06 red for another reason · K07 returns nothing
//   K08 returns a malformed outcome · K09 a device more lenient than the recorded real gh shape → contract-violation (device-fidelity)
//   K10 records an event whose getter throws → recorder finalize { ok:false } → infra-error · K11/K12 test-root isolation across await
//   (K10–K12 are kept out of the default fixture rows)
import { getTestStateRoot } from '../../nexus/paths.js';
import { createFakeGh, type FakeGh } from '../fake-gh.js';
import type { SimWorldDeviceDef, SimWorldScenario } from './types.js';

// Both gh devices are the ledger device `fake-github` (createFakeGh), not a new fake. K-GH-LOOSE wraps it and drops
// `head` from every pull, standing in for a fake that is more lenient than the real API.
interface RecordedGh { readonly gh: FakeGh; readonly replies: string[]; pulls(): string }
const RECORDING = 'src/ux-sim/sim-world/recordings/example-gh-pulls-open.json';
const recordedGh = (lenient: boolean): RecordedGh => {
  const gh = createFakeGh({ repository: 'acme/widget', now: () => new Date('2026-11-04T10:00:00.000Z'),
    prs: [{ number: 7, title: 'Recorded PR', branch: 'feature/recorded', createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-04T09:00:00.000Z' }] });
  const replies: string[] = [];
  return { gh, replies, pulls() {
    const raw = gh.api(['api', '/repos/acme/widget/pulls?state=open']);
    const reply = lenient ? JSON.stringify((JSON.parse(raw) as Record<string, unknown>[]).map(({ head: _head, ...rest }) => rest)) : raw;
    replies.push(reply);
    return reply;
  } };
};
const GH_CONTRACT = { name: 'gh-pulls-open', recording: RECORDING, call: 0, responses: (device: RecordedGh) => device.replies };

export const simWorldDevices: readonly SimWorldDeviceDef<RecordedGh>[] = [
  { id: 'K-GH', title: 'fake-github through createFakeGh', create: () => recordedGh(false), contracts: [GH_CONTRACT] },
  { id: 'K-GH-LOOSE', title: 'fake-github made too lenient', create: () => recordedGh(true), contracts: [GH_CONTRACT] },
];

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'K01', title: 'example pass', devices: ['K-GH'],
    async run(ctx) {
      const gh = ctx.device<RecordedGh>('K-GH');
      const seams = ctx.recorder.wrapSeams({ gate: (round: number) => ({ ok: round > 1 }) });
      let green = 0;
      for (const round of [1, 2]) {
        ctx.recorder.onNodeEntry('implement', round);
        ctx.recorder.onNodeEntry('gate', round);
        green += seams.gate(round).ok ? 1 : 0;
      }
      ctx.recorder.seam('listPulls', { state: 'open' }, JSON.parse(gh.pulls()));
      ctx.recorder.event('example.random', { draw: Math.floor(ctx.random() * 1000), engine: ctx.engine });
      return green === 1 ? { ok: true } : { ok: false, diff: `green gates: expected 1, got ${green}`, reason: 'gate count' };
    },
  },
  { id: 'K02', title: 'example red', async run() { return { ok: false, diff: 'context.memory: expected 1 line, got 0\nsecond line', reason: 'memory fixed to []' }; } },
  { id: 'K03', title: 'example throw', async run() { throw new Error('scenario crashed'); } },
  { id: 'K04', title: 'example graph-only', engines: ['graph'], async run(ctx) { ctx.recorder.step('graph-only'); return { ok: true }; } },
  { id: 'K05', title: 'example missing device', devices: ['K-MISSING'], async run() { return { ok: true }; } },
  { id: 'K06', title: 'example wrong red reason', async run() { return { ok: false, diff: 'provider refused', reason: 'unknown provider' }; } },
  { id: 'K07', title: 'example absent outcome', async run() { return undefined as never; } },
  { id: 'K08', title: 'example malformed outcome', async run() { return { ok: 'yes' } as never; } },
  { id: 'K09', title: 'example lenient device', devices: ['K-GH-LOOSE'], async run(ctx) { ctx.device<RecordedGh>('K-GH-LOOSE').pulls(); return { ok: true }; } },
  { id: 'K10', title: 'example unserializable record', async run(ctx) {
    ctx.recorder.event('example.hostile', { value: { get boom(): never { throw new Error('getter exploded'); } } });
    return { ok: true };
  } },
  // K11 / K12: the process-global test root must still be this scenario's universe after an await (worlds that share a
  // process must not interleave). Same body, two ids, so two packs can each list one.
  ...(['K11', 'K12'] as const).map((id): SimWorldScenario => ({ id, title: `example universe kept across await (${id})`, async run(ctx) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    const root = getTestStateRoot();
    return root === ctx.universeRoot ? { ok: true } : { ok: false, diff: `test state root changed under ${id}: ${root ?? 'unset'}`, reason: 'universe leaked' };
  } })),
];
