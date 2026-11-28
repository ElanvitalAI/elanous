// kit/bus-post — the `bus-post` node executor (CONTEXT-BUS-FEDERATION ③) · literal expectations.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ORG } from '../../org/org-map.js';
import { busAck, busPost, readBus } from '../../op-context-bus/bus.js';
import { lintAgentYaml } from '../../loop-agent/v3/agent-yaml.js';
import { busNoticePort, busPostConfigOf, liveBusPostConfig } from './index.js';

const T0 = Date.parse('2026-11-28T09:00:00.000Z');

function world() {
  const root = mkdtempSync(join(tmpdir(), 'bus-post-'));
  const r = busPost(root, { type: 'status', from: 'CLAUDE-OP', body: 'seed' }, { space: 'OP', now: T0 - 60_000 });
  busAck(root, r.kind === 'posted' ? r.entry.id : '', 'OP', { space: 'OP', now: T0 - 60_000 });
  const mailed: string[] = [];
  const mail = (key: string, to: string, _body: string, kind?: string) => { if (mailed.includes(key)) return null; mailed.push(`${key}`); void to; void kind; return mailed.length; };
  return { root, mailed, mail, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe('busNoticePort', () => {
  test('a notice to a bus-reading L0 is one bus status; a request stays mail; RES climbs to OP', () => {
    const w = world();
    try {
      const port = busNoticePort(w.mail, { notices: ['info', 'status'], readerWindowMs: 86_400_000 }, { stateRoot: w.root, from: 'GUARDIAN', org: () => DEFAULT_ORG, now: () => T0 });
      const id = port('guardian-digest:1', 'RES', '[수호자 · 30분] 정리 0', 'status');
      expect(String(id).startsWith('bus:b-')).toBe(true);
      expect(port('guardian-digest:1', 'RES', '[수호자 · 30분] 정리 0', 'status')).toBe(null);
      expect(port('scale-up:1', 'RES', '[수호자 · 손 늘리기 제안]', 'request')).toBe(1);
      expect(port('no-kind', 'RES', 'x')).toBe(2);
      const rows = readBus(w.root, 'OP').filter((i) => i.from === 'GUARDIAN');
      expect(rows.map((i) => [i.type, i.refs.join(' ')])).toEqual([['status', 'seat:RES notice:status']]);
      expect(w.mailed).toEqual(['scale-up:1', 'no-kind']);
    } finally { w.done(); }
  });
  test('a recipient that never acked keeps mail', () => {
    const w = world();
    try {
      const port = busNoticePort(w.mail, { notices: ['info'], readerWindowMs: 86_400_000 }, { stateRoot: w.root, from: 'SILENCE-WATCH', org: () => DEFAULT_ORG, now: () => T0 });
      expect(port('silence-bounce:REL:TC:d', 'TC', 'notice', 'info')).toBe(1);
      expect(readBus(w.root, 'TC').length).toBe(0);
    } finally { w.done(); }
  });
  test('a throwing bus write falls back to mail once and the key never reaches the bus later', () => {
    const w = world();
    try {
      let n = 0;
      const port = busNoticePort(w.mail, { notices: ['info'], readerWindowMs: 86_400_000 }, {
        stateRoot: w.root, from: 'SILENCE-WATCH', org: () => DEFAULT_ORG, now: () => T0,
        busPost: (r, input, opts) => { n++; if (n === 1) throw new Error('bus: write lock busy'); return busPost(r, input, opts); },
        mailHas: (k) => w.mailed.includes(k),
      });
      expect(port('lesson-candidate:L1', 'OP', 'lesson', 'info')).toBe(1);
      expect(port('lesson-candidate:L1', 'OP', 'lesson', 'info')).toBe(null);
      expect(readBus(w.root, 'OP').filter((i) => i.from === 'SILENCE-WATCH').length).toBe(0);
      expect(w.mailed).toEqual(['lesson-candidate:L1']);
    } finally { w.done(); }
  });
});

describe('agent.yaml opt-in', () => {
  test('the repo\'s silence-watch and guardian declare bus-post (info · status)', () => {
    expect(liveBusPostConfig('silence-watch')).toEqual({ notices: ['info'], readerWindowMs: 86_400_000 });
    expect(liveBusPostConfig('guardian')).toEqual({ notices: ['status'], readerWindowMs: 86_400_000 });
    expect(liveBusPostConfig('run-doctor')).toBe(null);
  });
  test('no bus-post node → null', () => {
    expect(busPostConfigOf({ body: { nodes: [{ kind: 'gate' }] }, policies: {} })).toBe(null);
  });
  test('lint refuses a request kind as a bus notice', () => {
    const text = `apiVersion: elanous/loop-agent@3
manifest: { name: a, version: 1.0.0, requires: { executor: loop-agent@3, kits: [kpi, bus-post], node_kinds: [gate, bus-post] }, provides: { agent: a, kpis: [k] } }
identity: { id: a, address: A, soul: soul.md }
supervisor: { duty: escalation-parent }
policies: { k_max: 0, bus_reader_window_h: 24 }
kpis: [{ name: k, at_most: $policies.k_max }]
soul: { purpose: p, values: [v], do_not: [d], voice: v, serves: [OP] }
wake: { trigger: { cron: "*/5 * * * *" } }
body: { entry_node: done, terminal_nodes: [done], nodes: [{ node_id: done, kind: gate }, { node_id: bus, kind: bus-post, optional: true }], edges: [] }
bus: { notices: [info, request] }
`;
    const r = lintAgentYaml(text, '/nonexistent');
    expect(r.errors).toContain('bus.notices: request is not a notice kind (info|status) — requests and ✋ stay mail');
  });
});
