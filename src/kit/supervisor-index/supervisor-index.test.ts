import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyze, collectStageCopies, collectUnits, loadOntology, metaStrip, renderReport, writeIndex } from './index.js';

const root = mkdtempSync(join(tmpdir(), 'sup-index-'));
const repo = join(root, 'repo'), seats = join(root, 'seat-state');
const put = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
afterAll(() => rmSync(root, { recursive: true, force: true }));

const agent = (id: string, subject: string, action: string, kpi: string) => `apiVersion: elanous/loop-agent@3
manifest: { name: ${id}, version: 1.0.0 }
supervisor: { duty: landing }
card:
  name: ${id}
  role: "${subject} 를 보고 답 없는 우편에 재촉 우편을 보낸다"
  subject: "${subject}"
  actions: [${action}]
policies: { lesson_cap: 12, knowhow_cap: 5, sla_min: 30 }
kpis: [{ name: ${kpi}, at_most: 0 }]
wake: { registered_as: ${id}-agent, trigger: { condition: { predicate: {"kind":"state-changed","parts":[{"file":"{stateRoot}/msg/inbox.db"}]} } } }
body: { nodes: [{ node_id: observe, kind: ${id}.observe }, { node_id: done, kind: gate }], edges: [{ from: observe, on: outcome, map: { ok: done } }] }
`;
put(join(repo, 'graphs/loop-agents/mail-sla/agent.yaml'), agent('mail-sla', '답 없음 우편 · inbox ack SLA', 'nudge-mail', 'unanswered_mail'));
put(join(repo, 'graphs/loop-agents/mail-sla/soul.md'), '# 우편 SLA 감시 — 답 없는 우편을 재촉한다 · 우편 · inbox · ack');
put(join(repo, 'graphs/loop-agents/post-nudge/agent.yaml'), agent('post-nudge', '답 없음 우편 · inbox ack SLA', 'nudge-mail', 'unanswered_mail'));
put(join(repo, 'graphs/loop-agents/post-nudge/soul.md'), '# 우체국 재촉 — 답 없는 우편을 재촉한다 · 우편 · inbox · ack');
put(join(repo, 'graphs/loop-agents/host-lease/agent.yaml'), agent('host-lease', 'host load 부하 lease', 'route-host', 'overloaded_hosts').replace('우편에 재촉 우편을 보낸다', '호스트를 비운다'));
// ④ same job, different words: «last tick older than 30 min = 침묵 → 깨움» vs «beat DEAD past 2× cadence → restart»
const watcher = (id: string, role: string, action: string) => `apiVersion: elanous/loop-agent@3
manifest: { name: ${id}, version: 1.0.0 }
card: { name: ${id}, role: "${role}", subject: "${role}", actions: [${action}] }
kpis: [{ name: ${id.replace(/-/g, '_')}_gaps, at_most: 0 }]
`;
put(join(repo, 'graphs/loop-agents/peer-silence/agent.yaml'), watcher('peer-silence', '다른 감독의 마지막 틱이 30분 넘으면 침묵 — 한 번 깨운다(trigger tick --only)', 'wake-peer'));
put(join(repo, 'graphs/loop-agents/beat-dead/agent.yaml'), watcher('beat-dead', 'heartbeat 가 2× cadence 넘게 없으면 DEAD — restart 한 번', 'restart'));
const graph = (id: string, cron: string, scope: string) => `graph_id: ${id}
loop: { title: "${scope} steward", description: "Every 10 min match idle hands for ${scope}", trigger: { cron: '${cron}' } }
nodes: [{ node_id: tick, kind: agent, recipe: 'cmd:steward-tick' }, { node_id: done, kind: gate }]
edges: [{ from: tick, on: outcome, map: { ok: done } }]
`;
put(join(repo, 'graphs/steward/steward-tc.yaml'), graph('steward-tc', '*/10 * * * *', 'TC'));
put(join(repo, 'graphs/steward/steward-jud.yaml'), graph('steward-jud', '*/15 * * * *', 'JUD'));
put(join(repo, 'src/land-graph/refuse.ts'), 'export function classifyLandExit(code: number): string {\n  if (code === 124) return "timeout";\n  if (code === 1) return "content";\n  return "infra";\n}\n');
put(join(repo, 'src/loop-agent/bodies/autopsy.ts'), 'export function classifyDeath(code: number): string {\n  if (code === 137) return "killed";\n  if (code === 2) return "content";\n  return "infra";\n}\n');
put(join(seats, 'RES/tools/pinch-wake-1.sh'), '#!/bin/sh\n# wake the RES tab once\neln msg post --to RES --body wake\n');
put(join(seats, 'RES/tools/inbox-watch.sh'), '#!/bin/sh\n# watch the inbox every 5 min\neln msg list --to RES\n');
const old = new Date('2026-10-01T00:00:00Z');
utimesSync(join(seats, 'RES/tools/pinch-wake-1.sh'), old, old);
utimesSync(join(seats, 'RES/tools/inbox-watch.sh'), old, old);

describe('kit/supervisor-index', () => {
  test('one snapshot: two mail-SLA agents cluster, the host agent does not; commonization · stage · dead · policies', async () => {
    const onto = loadOntology();
    const { units, scriptText } = await collectUnits({ repoRoot: repo, seatStateRoot: seats, crontab: '*/5 * * * * sh ~/x/inbox-watch.sh\n*/10 * * * * eln loop cron steward-tc\n*/15 * * * * eln loop cron steward-jud\n', now: new Date('2026-11-28T00:00:00Z') }, onto);
    expect(units.map(u => u.id).sort()).toEqual(['agent:beat-dead', 'agent:host-lease', 'agent:mail-sla', 'agent:peer-silence', 'agent:post-nudge', 'graph:steward-jud', 'graph:steward-tc', 'script:RES/inbox-watch.sh', 'script:RES/pinch-wake-1.sh']);
    const db = writeIndex(':memory:', units, onto, collectStageCopies(repo, onto));
    expect((db.query("SELECT COUNT(*) AS n FROM edges WHERE src = 'agent:mail-sla' AND rel = 'watches' AND dst = 'mail'").get() as { n: number }).n).toBe(1);
    const a = await analyze(db, { now: new Date('2026-11-28T00:00:00Z'), codeText: scriptText, srcText: 'n("lesson_cap")' });
    const mail = a.clusters.find(c => c.units.includes('agent:mail-sla'))!;
    expect(mail.units.sort()).toEqual(['agent:mail-sla', 'agent:post-nudge']);
    expect(mail.target).toBe('mail');
    expect(mail.pairs[0]!.rdb).toBe(1);
    expect(a.clusters.some(c => c.units.includes('agent:host-lease'))).toBe(false);
    const fam = a.families.find(f => f.units.includes('graph:steward-tc'))!;
    expect(fam.units.sort()).toEqual(['graph:steward-jud', 'graph:steward-tc']);
    expect(fam.axes).toContain('kingdom');
    const classify = a.stageFamilies.find(f => f.family === 'classify-failure')!;
    expect(classify.stages).toEqual({ land: 1, ops: 1 });
    expect(a.dead.map(d => d.unit)).toEqual(['script:RES/pinch-wake-1.sh']);
    expect(a.edgePolicies.find(p => p.key === 'lesson_cap')).toEqual({ key: 'lesson_cap', agents: 3, value: '12', readByCode: true });
    expect(a.edgePolicies.find(p => p.key === 'knowhow_cap')!.readByCode).toBe(false);
    // kingdom variants are a commonization family (one agent + instances), not a duplicate cluster
    expect(a.clusters.some(c => c.units.includes('graph:steward-tc'))).toBe(false);
    expect(a.rows.find(r => r.id === 'graph:steward-tc')!.verdict).toBe('variant');
    // ④ same job, different words: «침묵 → 깨움» and «DEAD → restart» meet on the concept tokens (heartbeats · nudge)
    const hb = a.clusters.find(c => c.units.includes('agent:peer-silence'))!;
    expect([hb.target, [...hb.units].sort()]).toEqual(['heartbeats', ['agent:beat-dead', 'agent:peer-silence']]);
    expect([hb.pairs[0]!.bm25, hb.pairs[0]!.onto]).toEqual([1, 1]);
    expect(a.confirmed).toBe(0);
    expect(renderReport(a, { db: ':memory:', at: '2026-11-28' })).toContain('진척: 확정 군집 0/2 (0%)');
    const full = renderReport(a, { db: ':memory:', at: '2026-11-28', rows: true });
    expect(full).toContain('| `script:RES/pinch-wake-1.sh` | script | RES | — | — | — | — | — | dead |');
    expect(full).toContain('| classify-failure | land | `src/land-graph/refuse.ts:1` | classifyLandExit | 5 | kit/failure-class');
    expect(classify.nearPairs[0]!.a).toBe('src/land-graph/refuse.ts:1 classifyLandExit');
    expect(renderReport(a, { db: ':memory:', at: '2026-11-28' })).toContain('| mail | 2 | `agent:mail-sla` | `agent:post-nudge` | 1.00 | 1.00 |');
    db.close();
  });

  test('metaStrip removes numbers, kingdoms, phases and quoted text', () => {
    expect(metaStrip("cron '*/10' for TC at cut 30", loadOntology())).toBe('cron <STR> for <KINGDOM> at <PHASE> <N>');
  });
});
