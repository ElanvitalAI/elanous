import { describe, expect, test } from 'bun:test';
import { PaneRegistry, authorizeRequest, isMutating, resolveTabCloseScope, spawnParentOf, type ServerRole } from './server-auth.js'; import type { AllowRule } from './control.js';

test('acting seat gets OP decisions but not owner registration or confirmation bypass', () => {
  const roles: ServerRole[] = [
    { kind: 'hand', seat: 'TC-H-CX-2', pane: 'p', workspaces: ['own'] },
    { kind: 'peer', seat: 'TC-H-CX-2', pane: 'p', pid: 1, uid: 501 },
  ];
  for (const role of roles) {
    const denied = authorizeRequest(role, { op: 'do' }, 'foreign', []);
    expect(denied.allow).toBe(false);
    expect(denied.allow === false && denied.reason).toContain('an OP pane is authorized for this request at this gate');
    expect(authorizeRequest(role, { op: 'do' }, 'foreign', [], undefined, true).allow).toBe(true);
    expect(authorizeRequest(role, { op: 'coordinator' }, undefined, [], undefined, true).allow).toBe(true);
    expect(authorizeRequest(role, { op: 'seat-set', seat: 'OP', runtime: {} }, undefined, [], undefined, true).allow).toBe(false);
    expect(authorizeRequest(role, { op: 'close' }, 'foreign', [], undefined, true).allow).toBe(false);
    expect(authorizeRequest(role, { op: 'close', confirmed: true }, 'foreign', [], undefined, true).allow).toBe(true);
  }
});

const OWNER_ENV = 'ELANOUS_ELS_OWNER_TOKEN';
const PANE_ENV = 'ELANOUS_ELS_PANE_TOKEN';
const HAND_PARENT = { kind: 'hand', seat: 'HAND-MCP', workspaces: ['w-hand'] } as const;
const OP_PARENT = { kind: 'op' } as const;

describe('PaneRegistry.registerOwner + classify — owner 등록 절차', () => {
  test('owner 토큰: 등록 전 owner(11-23 완화 — 모든 연산 허용) · `els seat set OP` 후 op', () => {
    const registry = new PaneRegistry();
    const owner = registry.registerOwner();
    const before = registry.classify({ token: owner.token });
    expect(before.kind).toBe('owner');
    const spawn = authorizeRequest(before, { op: 'new', ws: 'w' }, undefined, undefined);
    expect(spawn.allow).toBe(true);
    const close = authorizeRequest(before, { op: 'close', pane: 'w:p' }, undefined, undefined);
    expect(close).toEqual({ allow: true });
    const seatSet = authorizeRequest(before, { op: 'seat-set', seat: 'OP' }, undefined, undefined);
    expect(seatSet.allow).toBe(true);
    expect(registry.registerSeat('OP')).toBe(true);
    expect(registry.classify({ token: owner.token })).toEqual({ kind: 'op', pane: 'server-owner' });
    expect(authorizeRequest(registry.classify({ token: owner.token }), { op: 'new', ws: 'w' }, undefined, undefined).allow).toBe(true);
  });

  test('seat-set rejects an OP pane credential but allows the registered server owner', () => {
    const registry = new PaneRegistry();
    const owner = registry.registerOwner();
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-op', ELANOUS_ELS_WS: 'w' }, '/tmp', OP_PARENT);
    registry.registerSeat('OP');
    expect(authorizeRequest(registry.classify({ token: env[PANE_ENV] }), { op: 'seat-set', seat: 'OP' }, undefined, undefined).allow).toBe(false);
    expect(authorizeRequest(registry.classify({ token: owner.token }), { op: 'seat-set', seat: 'OP' }, undefined, undefined).allow).toBe(true);
  });

  test('an OP pane named server-owner cannot register the OP runtime', () => {
    const registry = new PaneRegistry();
    const owner = registry.registerOwner();
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'server-owner', ELANOUS_ELS_WS: 'w' }, '/tmp', OP_PARENT);
    registry.registerSeat('OP');
    expect(authorizeRequest(registry.classify({ token: env[PANE_ENV] }), { op: 'seat-set', seat: 'OP' }, undefined, undefined).allow).toBe(false);
    expect(authorizeRequest(registry.classify({ token: owner.token }), { op: 'seat-set', seat: 'OP' }, undefined, undefined).allow).toBe(true);
  });
  test('seat-set 은 hand·outsider 에게 거부', () => {
    const registry = new PaneRegistry();
    const handEnv = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-hand', ELANOUS_ELS_WS: 'w-hand' }, '/Users/x/elanous-hq/seats/HAND-MCP', HAND_PARENT);
    const hand = registry.classify({ token: handEnv[PANE_ENV] });
    expect(hand.kind).toBe('hand');
    expect(authorizeRequest(hand, { op: 'seat-set', seat: 'OP' }, 'w-hand', undefined).allow).toBe(false);
    expect(authorizeRequest(registry.classify(undefined), { op: 'seat-set', seat: 'OP' }, undefined, undefined).allow).toBe(false);
    expect(isMutating({ op: 'seat-set', seat: 'OP' })).toBe(true);
  });
});

describe('JUD #39057 ⓒ1 승격 RED 리터럴 — 역할은 상속으로만 정해진다, cwd 는 무관 (JUD #39071: 부모 역할은 직접 인자)', () => {
  test('① hand 가 요청한 new pane: cwd 가 …/seats/OP 여도 hand 상속', () => {
    const registry = new PaneRegistry();
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p1', ELANOUS_ELS_WS: 'w1' }, '/Users/x/elanous-hq/seats/OP', HAND_PARENT);
    expect(registry.classify({ token: env[PANE_ENV] })).toEqual({ kind: 'hand', seat: 'HAND-MCP', workspaces: ['w1'], pane: 'p1' });
  });

  test('② cwd=/tmp/evil/seats/OP 로도 승격 불가', () => {
    const registry = new PaneRegistry();
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p2', ELANOUS_ELS_WS: 'w2' }, '/tmp/evil/seats/OP', HAND_PARENT);
    expect(registry.classify({ token: env[PANE_ENV] }).kind).toBe('hand');
  });

  test('③ op 가 요청한 new pane: op 상속', () => {
    const registry = new PaneRegistry();
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p3', ELANOUS_ELS_WS: 'w3' }, '/tmp', OP_PARENT);
    expect(registry.classify({ token: env[PANE_ENV] })).toEqual({ kind: 'op', pane: 'p3' });
  });

  test('④ 자식 pane 은 owner 토큰을 물려받지 않는다 — env 에 있어도 제거', () => {
    const registry = new PaneRegistry();
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p4', ELANOUS_ELS_WS: 'w4', [OWNER_ENV]: 'leaked-owner-token' }, '/tmp', HAND_PARENT);
    expect(env[OWNER_ENV]).toBeUndefined();
    expect(registry.classify({ token: 'leaked-owner-token' }).kind).toBe('outsider');
    expect(registry.classify({ token: env[PANE_ENV] }).kind).toBe('hand');
  });

  test('⑤ 부모 역할 없는 spawn 은 fail-closed (hand/unknown)', () => {
    const registry = new PaneRegistry();
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p5', ELANOUS_ELS_WS: 'w5' }, '/tmp');
    expect(registry.classify({ token: env[PANE_ENV] })).toEqual({ kind: 'hand', seat: 'unknown', workspaces: ['w5'], pane: 'p5' });
  });

  test('⑥ outsider 의 new 요청은 스폰으로 열려 있다 (main #39060) — spawnParentOf(outsider) = undefined 로 자식은 hand (fail-closed)', () => {
    const registry = new PaneRegistry();
    const outsider = registry.classify(undefined);
    expect(authorizeRequest(outsider, { op: 'new', ws: 'w' }, undefined, undefined).allow).toBe(true);
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p6', ELANOUS_ELS_WS: 'w6' }, '/tmp', spawnParentOf(outsider));
    expect(registry.classify({ token: env[PANE_ENV] }).kind).toBe('hand');
  });

  test('원장 토큰만 인정 — 무토큰·가짜 토큰 = outsider', () => {
    const registry = new PaneRegistry();
    expect(registry.classify(undefined).kind).toBe('outsider');
    expect(registry.classify({ token: 'spoofed' }).kind).toBe('outsider');
  });

  test('spawnParentOf — OP·hand 역할을 SpawnParent 로 직접 변환, owner/outsider 는 undefined (스폰 불가)', () => {
    const opRole: ServerRole = { kind: 'op', pane: 'server-owner' };
    const handRole: ServerRole = { kind: 'hand', seat: 'S1', workspaces: ['w1'], pane: 'p' };
    expect(spawnParentOf(opRole)).toEqual({ kind: 'op' });
    expect(spawnParentOf(handRole)).toEqual({ kind: 'hand', seat: 'S1', workspaces: ['w1'] });
    expect(spawnParentOf({ kind: 'owner', note: 'x' })).toBeUndefined();
    expect(spawnParentOf({ kind: 'outsider', note: 'x' })).toBeUndefined();
  });
});

describe('authorizeRequest — JUD #39053 ⓒ1 리터럴', () => {
  const registry = new PaneRegistry();
  const opEnv = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-op', ELANOUS_ELS_WS: 'w-op' }, '/tmp', OP_PARENT);
  const handEnv = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-hand', ELANOUS_ELS_WS: 'w-hand' }, '/tmp', HAND_PARENT);
  const opRole = registry.classify({ token: opEnv[PANE_ENV] }) as Extract<ServerRole, { kind: 'op' }>;
  const handRole = registry.classify({ token: handEnv[PANE_ENV] }) as Extract<ServerRole, { kind: 'hand' }>;

  test('① env 위장 손 — 원장이 말하는 것만 인정: 남의 pane 거부', () => {
    const spoofed = registry.classify({ token: handEnv[PANE_ENV] });
    expect(spoofed.kind).toBe('hand');
    const verdict = authorizeRequest(handRole, { op: 'do', pane: 'p-op' }, 'w-op', undefined);
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.reason).toContain('denied');
  });

  test('② 소켓 직통(무토큰) = outsider: 같은 uid 운영자 — 11-23 완화로 변형 연산 허용', () => {
    const outsider = registry.classify(undefined);
    expect(outsider.kind).toBe('outsider');
    expect(authorizeRequest(outsider, { op: 'do', pane: 'p-op' }, 'w-op', undefined)).toEqual({ allow: true });
  });

  test('③ 진짜 OP pane: 모든 pane 허용', () => {
    expect(authorizeRequest(opRole, { op: 'do', pane: 'p-hand' }, 'w-hand', undefined)).toEqual({ allow: true });
    expect(authorizeRequest(opRole, { op: 'new', ws: 'w-x' }, undefined, undefined).allow).toBe(true);
  });

  test('④ 손은 자기 workspace 만 — foreign-workspace denial identifies an allowed OP pane', () => {
    expect(authorizeRequest(handRole, { op: 'do', pane: 'p-hand' }, 'w-hand', undefined)).toEqual({ allow: true });
    expect(authorizeRequest(handRole, { op: 'send', pane: 'p-op' }, 'w-op', undefined)).toEqual({
      allow: false,
      reason: 'els: send denied — default rules: seat HAND-MCP may control only its own workspaces (target w-op not bound); an OP pane is authorized for this request at this gate (other checks may still apply)',
    });
    expect(authorizeRequest(opRole, { op: 'send', pane: 'p-op' }, 'w-op', undefined)).toEqual({ allow: true });
  });

  test('guidance is true for default and no-rule refusals, but not asserted for earlier target failures', () => {
    const peer: ServerRole = { kind: 'peer', pid: 42, uid: 501, seat: 'OTHER', pane: 'peer' };
    for (const [role, request, workspace] of [
      [handRole, { op: 'do', pane: 'p-other' }, 'foreign'],
      [handRole, { op: 'snapshot', pane: 'p-other' }, 'foreign'],
      [handRole, { op: 'close', pane: 'p-hand' }, 'w-hand'],
      [peer, { op: 'send', pane: 'p-other' }, 'foreign'],
    ] as const) {
      const denied = authorizeRequest(role, request, workspace, undefined);
      expect(denied.allow).toBe(false);
      expect(denied.allow === false && denied.reason).toContain('an OP pane is authorized for this request at this gate (other checks may still apply)');
      expect(authorizeRequest(opRole, request, workspace, undefined)).toEqual({ allow: true });
    }
    const unresolved = authorizeRequest(handRole, { op: 'rename', kind: 'workspace' }, undefined, undefined);
    expect(unresolved).toEqual({ allow: false, reason: 'els: rename denied — workspace target not resolved' });
    expect(authorizeRequest(opRole, { op: 'rename', kind: 'workspace' }, undefined, undefined).allow).toBe(false);
  });

  test('close: 손은 confirm 필요 · OP 는 confirm 없이 허용(11-23 완화)', () => {
    const verdict = authorizeRequest(handRole, { op: 'close', pane: 'p-hand' }, 'w-hand', undefined);
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.reason).toContain('confirm');
    expect(authorizeRequest(opRole, { op: 'close', pane: 'p-x' }, 'w-x', undefined)).toEqual({ allow: true });
  });

  test('tab close: a confirmed own-workspace tab is allowed, a foreign tab and unconfirmed close are refused', () => {
    expect(authorizeRequest(handRole, { op: 'close-tab', tab: 't-own', confirmed: true }, 'w-hand', undefined,
      { tabId: 't-own', workspace: 'w-hand', ownerSeats: ['HAND-MCP'] })).toEqual({ allow: true });
    expect(authorizeRequest(handRole, { op: 'close-tab', tab: 't-other', confirmed: true }, 'w-op', undefined,
      { tabId: 't-other', workspace: 'w-op', ownerSeats: ['HAND-OTHER'] }).allow).toBe(false);
    const unconfirmed = authorizeRequest(handRole, { op: 'close-tab', tab: 't-own' }, 'w-hand', undefined,
      { tabId: 't-own', workspace: 'w-hand', ownerSeats: ['HAND-MCP'] });
    expect(unconfirmed.allow).toBe(false);
    expect(unconfirmed.allow === false && unconfirmed.reason).toContain('confirm');
    expect(authorizeRequest(opRole, { op: 'close-tab', tab: 't-own' }, 'w-hand', undefined,
      { tabId: 't-own', workspace: 'w-hand', ownerSeats: ['HAND-MCP'] })).toEqual({ allow: true });
  });

  test('tab close refuses another seat in the same workspace, mixed owners, and a checked tab ID unlike execution', () => {
    const request = { op: 'close-tab', tab: 't-other', confirmed: true };
    expect(authorizeRequest(handRole, request, 'w-hand', undefined,
      { tabId: 't-other', workspace: 'w-hand', ownerSeats: ['HAND-OTHER'] }).allow).toBe(false);
    expect(authorizeRequest(handRole, request, 'w-hand', undefined,
      { tabId: 't-other', workspace: 'w-hand', ownerSeats: ['HAND-MCP', 'HAND-OTHER'] }).allow).toBe(false);
    expect(authorizeRequest(handRole, request, 'w-hand', undefined,
      { tabId: 't-own', workspace: 'w-hand', ownerSeats: ['HAND-MCP'] }).allow).toBe(false);
  });

  test('same-workspace tab owners come from server-minted pane registrations, including mixed seats', () => {
    const minted = new PaneRegistry();
    const a = minted.registerSpawn({ ELANOUS_ELS_PANE: 'p-a', ELANOUS_ELS_WS: 'W' }, '/seats/HAND-B',
      { kind: 'hand', seat: 'HAND-A', workspaces: ['W'] });
    minted.registerSpawn({ ELANOUS_ELS_PANE: 'p-b', ELANOUS_ELS_WS: 'W' }, '/seats/HAND-A',
      { kind: 'hand', seat: 'HAND-B', workspaces: ['W'] });
    const role = minted.classify({ token: a[PANE_ENV] });
    const base = { workspaces: [{ id: 'w', name: 'W' }], tabs: [{ id: 't', workspaceId: 'w' }] };
    const foreign = resolveTabCloseScope({ ...base, panes: [{ pane: 'p-b', tab: 't' }] }, minted.entries(), 't')!;
    expect(foreign.ownerSeats).toEqual(['HAND-B']);
    expect(authorizeRequest(role, { op: 'close-tab', tab: 't', confirmed: true }, 'W', undefined, foreign).allow).toBe(false);
    const mixed = resolveTabCloseScope({ ...base, panes: [{ pane: 'p-a', tab: 't' }, { pane: 'p-b', tab: 't' }] }, minted.entries(), 't')!;
    expect(mixed.ownerSeats).toEqual(['HAND-A', 'HAND-B']);
    expect(authorizeRequest(role, { op: 'close-tab', tab: 't', confirmed: true }, 'W', undefined, mixed).allow).toBe(false);
  });

  test('RES-INFRA allow-list peer cannot close another seat live tab in the same workspace', () => {
    const peer: ServerRole = { kind: 'peer', pid: 4242, pane: 'p-res', seat: 'RES-INFRA', uid: 501 };
    const rules: readonly AllowRule[] = [{ principal: 'local:501', seat: 'RES-INFRA', workspace: 'W', pane: '*', actions: ['close'] }];
    const request = { op: 'close-tab', tab: 't-live', confirmed: true };
    expect(authorizeRequest(peer, request, 'W', rules,
      { tabId: 't-live', workspace: 'W', ownerSeats: ['TC-H-CX-12'] }).allow).toBe(false);
    expect(authorizeRequest(peer, request, 'W', rules,
      { tabId: 't-live', workspace: 'W', ownerSeats: ['RES-INFRA', 'TC-H-CX-12'] }).allow).toBe(false);
    expect(authorizeRequest(peer, request, 'W', rules,
      { tabId: 't-live', workspace: 'W', ownerSeats: ['RES-INFRA'] }).allow).toBe(true);
    const opPeer: ServerRole = { ...peer, seat: 'OP' };
    const opRules: readonly AllowRule[] = [{ ...rules[0]!, seat: 'OP' }];
    // ELS-OP-CLOSE-TAB (대표 11-24 «보안 기본 완화»): the verified OP peer is the coordinator — closing another seat's tab is
    // its routine action (the OP tab itself stays refused: op-close-tab.test.ts).
    expect(authorizeRequest(opPeer, request, 'W', opRules,
      { tabId: 't-live', workspace: 'W', ownerSeats: ['TC-H-CX-12'] }).allow).toBe(true);
  });

  test('outsider 읽기 연산 허용(③ 읽기 전용)', () => {
    const outsider = registry.classify(undefined);
    expect(authorizeRequest(outsider, { op: 'ls' }, undefined, undefined)).toEqual({ allow: true });
    expect(authorizeRequest(outsider, { op: 'status', pane: 'p' }, 'w', undefined)).toEqual({ allow: true });
    expect(isMutating({ op: 'child', action: 'start' })).toBe(true);
    expect(isMutating({ op: 'child', action: 'tree' })).toBe(false);
  });
});


describe('JUD must ⓒ2-① (OP #104711) — reads are an allowlist: input-line is a mutation', () => {
  test('① 분류 반전: input-line·모르는 op = mutating, ls·grep·read·status·ping = 읽기', () => {
    expect(isMutating({ op: 'input-line', pane: 'p', text: 'x', from: 'y' })).toBe(true);
    expect(isMutating({ op: 'no-such-op' } as Parameters<typeof isMutating>[0])).toBe(true);
    expect(isMutating({ op: 'ls' })).toBe(false);
    expect(isMutating({ op: 'grep', pattern: 'x' })).toBe(false);
    expect(isMutating({ op: 'read', pane: 'p' })).toBe(false);
    expect(isMutating({ op: 'status', pane: 'p' })).toBe(false);
    expect(isMutating({ op: 'ping' })).toBe(false);
  });
  test('② outsider(같은 uid 운영자) → OP pane input-line 허용(11-23 완화)', () => {
    const registry = new PaneRegistry();
    const outsider = registry.classify(undefined);
    const verdict = authorizeRequest(outsider, { op: 'input-line', pane: 'p-op', text: 'x', from: 'y' }, 'w-op', undefined);
    expect(verdict).toEqual({ allow: true });
  });
  test('③ hand → 다른 workspace(OP) pane input-line 거부 — 문을 경유해 default 규칙이 거부', () => {
    const registry = new PaneRegistry();
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-hand', ELANOUS_ELS_WS: 'w-hand' }, '/Users/x/elanous-hq/seats/HAND-MCP', HAND_PARENT);
    const hand = registry.classify({ token: env[PANE_ENV] });
    const verdict = authorizeRequest(hand, { op: 'input-line', pane: 'p-op', text: 'x', from: 'y' }, 'w-op', undefined);
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.reason).toContain('may control only its own workspaces');
  });
  test('④ 대조: OP pane 자격의 input-line은 문을 통과해 허용', () => {
    const registry = new PaneRegistry();
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-op', ELANOUS_ELS_WS: 'w-op' }, '/Users/x/elanous-hq/seats/OP', OP_PARENT);
    const op = registry.classify({ token: env[PANE_ENV] });
    expect(op.kind).toBe('op');
    const verdict = authorizeRequest(op, { op: 'input-line', pane: 'p-any', text: 'x', from: 'y' }, 'w-any', undefined);
    expect(verdict.allow).toBe(true);
  });
});

// ELS-BUILD-BADGE: a pane reports the build of the process running IN it. Spawned from a person's terminal its seat is
// 'unknown' (no default rule, no allow row), so mapping `build` onto the generic `do` door denied every such pane's own report.
describe('build self-report — a pane reports its own build, nobody else\'s', () => {
  const handRole = (): ServerRole => {
    const registry = new PaneRegistry();
    const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-self', ELANOUS_ELS_WS: 'w-self' }, '/tmp');
    return registry.classify({ token: env[PANE_ENV] });
  };
  test('a pane spawned without a credentialed parent may report its own pane; another pane may not; no token (operator) may', () => {
    const own = handRole();
    expect(own).toMatchObject({ kind: 'hand', seat: 'unknown', pane: 'p-self' });
    expect(authorizeRequest(own, { op: 'build', pane: 'p-self' }, undefined, undefined).allow).toBe(true);
    expect(authorizeRequest(own, { op: 'build', pane: 'p-other' }, undefined, undefined).allow).toBe(false);
    expect(authorizeRequest({ kind: 'outsider', note: 'no pane credential' }, { op: 'build', pane: 'p-self' }, undefined, undefined).allow).toBe(true);
  });
});

// JUD #39096 must ⓑ (OP #105050·#105177): peer-seat principal at the role door.
const PEER_PID = 4242;
const PEER_PANE = 'herdr:p7';
const PEER_UID = 501;
const PEER_INPUT_RULES: readonly AllowRule[] = [{ principal: 'local:' + PEER_UID, seat: 'OP', workspace: '*', pane: '*', actions: ['input'] } as AllowRule];
const INPUT_LINE_REQ = { op: 'input-line', pane: 'p1', text: 'x', from: 'OP' };

test('JUD #39096 ⓑ — ledger-verified peer seat is a role-door principal; seat-set stays owner-only', () => {
  const peer: ServerRole = { kind: 'peer', pid: PEER_PID, pane: PEER_PANE, seat: 'OP', uid: PEER_UID };
  expect(authorizeRequest(peer, INPUT_LINE_REQ, 'w1', PEER_INPUT_RULES).allow).toBe(true);
  const resInfraPeer: ServerRole = { kind: 'peer', pid: PEER_PID, pane: PEER_PANE, seat: 'RES-INFRA', uid: PEER_UID };
  expect(authorizeRequest(resInfraPeer, INPUT_LINE_REQ, 'w1', PEER_INPUT_RULES).allow).toBe(true);
  expect(authorizeRequest(peer, { op: 'seat-set' }, undefined, undefined).allow).toBe(false);
});

test('coordinator mutations require OP pane, verified OP peer, or the same-uid operator (outsider/owner), never an allow-listed non-OP pane', () => {
  const opPeer: ServerRole = { kind: 'peer', pid: PEER_PID, pane: PEER_PANE, seat: 'OP', uid: PEER_UID };
  const roles: ServerRole[] = [opPeer, { kind: 'op', pane: 'op' },
    { ...opPeer, seat: 'HAND' }, { kind: 'hand', pane: 'p', seat: 'OP', workspaces: ['w'] },
    { kind: 'outsider', note: 'no credential' }, { kind: 'owner', note: 'unregistered' }];
  const expected = [true, true, false, false, true, true];
  for (const op of ['coordinator', 'coordinator-unset']) {
    for (const [index, role] of roles.entries()) {
      expect(authorizeRequest(role, { op }, 'w', PEER_INPUT_RULES).allow).toBe(expected[index]);
    }
  }
});

test('JUD #39096 ⓑ — no-token outsider keeps spawn and (11-23 relaxation) may type into panes', () => {
  const OUTSIDER: ServerRole = { kind: 'outsider', note: 'no pane credential' };
  expect(authorizeRequest(OUTSIDER, { op: 'new' }, undefined, undefined).allow).toBe(true);
  expect(authorizeRequest(OUTSIDER, INPUT_LINE_REQ, 'w1', PEER_INPUT_RULES).allow).toBe(true);
});

// Non-workspace rename remains unmapped and fail-closed for pane roles; the same-uid operator is allowed (11-23).
test('JUD #39096 ⓒ CC-1 — unmapped rename kinds remain fail-closed for pane roles', () => {
  const peer: ServerRole = { kind: 'peer', pid: PEER_PID, pane: PEER_PANE, seat: 'OP', uid: PEER_UID };
  const verdict = authorizeRequest(peer, { op: 'rename', pane: 'p1' }, 'w1', PEER_INPUT_RULES);
  expect(verdict.allow).toBe(false);
  const outsider = { kind: 'outsider', note: 'raw socket' } as ServerRole;
  expect(authorizeRequest(outsider, { op: 'rename' }, undefined, undefined).allow).toBe(true);
  // mapped raw paths stay door actions at authorizeRequest: do/attach/input-line reach the
  // pane-role door below (asserted by the ⓒ attach·input-line tests above) — rename does not.
});

test('workspace rename uses resolved workspace do policy and refuses unresolved targets', () => {
  const request = { op: 'rename', kind: 'workspace', id: 'w-id' };
  const hand: ServerRole = { kind: 'hand', seat: 'HAND-MCP', pane: 'p', workspaces: ['own'] };
  const op: ServerRole = { kind: 'op', pane: 'op' };
  const outsider: ServerRole = { kind: 'outsider', note: 'no credential' };
  expect(isMutating(request)).toBe(true);
  expect(authorizeRequest(op, request, 'own', undefined).allow).toBe(true);
  expect(authorizeRequest(op, request, undefined, undefined).allow).toBe(false);
  expect(authorizeRequest(hand, request, 'own', undefined).allow).toBe(true);
  expect(authorizeRequest(hand, request, 'foreign', undefined).allow).toBe(false);
  expect(authorizeRequest(outsider, request, 'own', undefined).allow).toBe(true);
  expect(authorizeRequest(op, { ...request, kind: 'tab' }, 'own', undefined).allow).toBe(false);
  expect(authorizeRequest(hand, { ...request, kind: 'tab' }, 'own', PEER_INPUT_RULES).allow).toBe(false);
  expect(authorizeRequest(hand, { ...request, kind: 'tab' }, 'foreign', undefined).allow).toBe(false);
  expect(authorizeRequest(op, { ...request, kind: 'tab' }, undefined, undefined).allow).toBe(false);
});

describe('ELS-PTY-RECORD door: snapshot writes a file so it is mutating, judged as `read`; record is judged as `do`', () => {
  test('분류: snapshot·record 모두 mutating', () => {
    expect(isMutating({ op: 'snapshot', pane: 'p' })).toBe(true);
    expect(isMutating({ op: 'record', pane: 'p' })).toBe(true);
  });
  test('snapshot: outsider 허용(11-23) · own-workspace hand 허용 · other workspace hand 거부 · OP 허용 · 미등록 owner 허용', () => {
    const registry = new PaneRegistry();
    expect(authorizeRequest(registry.classify(undefined), { op: 'snapshot', pane: 'p' }, 'w-hand', undefined).allow).toBe(true);
    const handEnv = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-hand', ELANOUS_ELS_WS: 'w-hand' }, '/Users/x/elanous-hq/seats/HAND-MCP', HAND_PARENT);
    const hand = registry.classify({ token: handEnv[PANE_ENV] });
    expect(authorizeRequest(hand, { op: 'snapshot', pane: 'p-hand' }, 'w-hand', undefined).allow).toBe(true);
    expect(authorizeRequest(hand, { op: 'snapshot', pane: 'p-other' }, 'w-other', undefined).allow).toBe(false);
    const opEnv = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-op', ELANOUS_ELS_WS: 'OP' }, '/x', OP_PARENT);
    expect(authorizeRequest(registry.classify({ token: opEnv[PANE_ENV] }), { op: 'snapshot', pane: 'p-other' }, 'w-other', undefined).allow).toBe(true);
    const owner = registry.registerOwner();
    expect(authorizeRequest(registry.classify({ token: owner.token }), { op: 'snapshot', pane: 'p' }, 'w', undefined).allow).toBe(true);
  });
  test('record: outsider 허용(11-23) · own-workspace hand 허용 · other workspace hand 거부', () => {
    const registry = new PaneRegistry();
    expect(authorizeRequest(registry.classify(undefined), { op: 'record', pane: 'p' }, 'w-hand', undefined).allow).toBe(true);
    const handEnv = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-hand', ELANOUS_ELS_WS: 'w-hand' }, '/Users/x/elanous-hq/seats/HAND-MCP', HAND_PARENT);
    const hand = registry.classify({ token: handEnv[PANE_ENV] });
    expect(authorizeRequest(hand, { op: 'record', pane: 'p-hand' }, 'w-hand', undefined).allow).toBe(true);
    expect(authorizeRequest(hand, { op: 'record', pane: 'p-other' }, 'w-other', undefined).allow).toBe(false);
  });
});

// ELS-HERDR-CLI-PARITY ② (tab-close bisect 11-24 · 첫 적록 809b57f70c #39938): a tab no seat owns —
// a plain scratch tab — is closed unconfirmed by no one, the owner terminal and the same-UID
// operator included. A person confirms it (confirm:true), a coordinator still closes a seated tab,
// and the OP tab above stays refused for everyone without a person's yes.
describe('authorizeRequest — ELS-HERDR-CLI-PARITY ② : 무소유 탭 닫기 문', () => {
  const plain = { tabId: 't-plain', workspace: 'w', ownerSeats: [null] };
  const roles: readonly ServerRole[] = [
    { kind: 'owner', note: 'owner terminal' },
    { kind: 'outsider', note: 'same-uid operator' },
    { kind: 'op', pane: 'p-op' },
    { kind: 'peer', pid: 4242, pane: 'herdr:p7', seat: 'OP', uid: 501 },
    { kind: 'hand', seat: 'HAND-MCP', workspaces: ['w'], pane: 'p-hand' },
  ];
  test('① 무소유 탭 무확인 닫기 — owner·같은-UID 연산자·OP 패널·OP peer·손 좌석 전부 거부', () => {
    for (const role of roles) {
      const verdict = authorizeRequest(role, { op: 'close-tab', tab: 't-plain' }, 'w', undefined, plain);
      expect(verdict.allow).toBe(false);
      expect(verdict.allow === false && verdict.reason).toContain('a tab no seat owns');
    }
  });
  test('② 대상 미해결(tabScope 없음)도 같은 무소유 거부 — CLI 가 확인-불가 exit 2 로 통일', () => {
    const verdict = authorizeRequest(roles[0]!, { op: 'close-tab', tab: 'missing' }, 'w', undefined, undefined);
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.reason).toContain('a tab no seat owns');
  });
  test('③ confirm:true(사람)이면 owner 통과 · 좌석 탭은 OP 패널·OP peer 가 사람 없이 닫는다', () => {
    expect(authorizeRequest(roles[0]!, { op: 'close-tab', tab: 't-plain', confirmed: true }, 'w', undefined, plain).allow).toBe(true);
    const seated = { tabId: 't-seat', workspace: 'w', ownerSeats: ['HAND-MCP'] };
    expect(authorizeRequest(roles[2]!, { op: 'close-tab', tab: 't-seat' }, 'w', undefined, seated).allow).toBe(true);
    expect(authorizeRequest(roles[3]!, { op: 'close-tab', tab: 't-seat' }, 'w', undefined, seated).allow).toBe(true);
  });
  test('④ OP 탭 자체는 무확인엔 이 문보다 먼저 모두에게 거부 · 사람(confirm:true)이면 통과', () => {
    const opTab = { tabId: 't-op', workspace: 'w', ownerSeats: [null], opTab: true };
    for (const role of roles) expect(authorizeRequest(role, { op: 'close-tab', tab: 't-op' }, 'w', undefined, opTab).allow).toBe(false);
    const refused = authorizeRequest(roles[0]!, { op: 'close-tab', tab: 't-op' }, 'w', undefined, opTab);
    expect(refused.allow === false && refused.reason).toContain('the OP tab itself');
    expect(authorizeRequest(roles[0]!, { op: 'close-tab', tab: 't-op', confirmed: true }, 'w', undefined, opTab).allow).toBe(true);
  });
});
