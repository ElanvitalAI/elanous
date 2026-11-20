import { describe, expect, test } from 'bun:test';
import { PaneRegistry, authorizeRequest, isMutating, spawnParentOf, type ServerRole } from './server-auth.js'; import type { AllowRule } from './control.js';

const OWNER_ENV = 'ELANOUS_ELS_OWNER_TOKEN';
const PANE_ENV = 'ELANOUS_ELS_PANE_TOKEN';
const HAND_PARENT = { kind: 'hand', seat: 'HAND-MCP', workspaces: ['w-hand'] } as const;
const OP_PARENT = { kind: 'op' } as const;

describe('PaneRegistry.registerOwner + classify — owner 등록 절차', () => {
  test('owner 토큰: 등록 전 owner(new 스폰·seat-set 만 허용, 그 밖 변형 거부) · `els seat set OP` 후 op', () => {
    const registry = new PaneRegistry();
    const owner = registry.registerOwner();
    const before = registry.classify({ token: owner.token });
    expect(before.kind).toBe('owner');
    const spawn = authorizeRequest(before, { op: 'new', ws: 'w' }, undefined, undefined);
    expect(spawn.allow).toBe(true);
    const denied = authorizeRequest(before, { op: 'close', pane: 'w:p' }, undefined, undefined);
    expect(denied.allow).toBe(false);
    const seatSet = authorizeRequest(before, { op: 'seat-set', seat: 'OP' }, undefined, undefined);
    expect(seatSet.allow).toBe(true);
    expect(registry.registerSeat('OP')).toBe(true);
    expect(registry.classify({ token: owner.token })).toEqual({ kind: 'op', pane: 'server-owner' });
    expect(authorizeRequest(registry.classify({ token: owner.token }), { op: 'new', ws: 'w' }, undefined, undefined).allow).toBe(true);
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

  test('② 소켓 직통 위장(무토큰·가짜 토큰) = outsider: 변형 연산 전면 거부', () => {
    const outsider = registry.classify(undefined);
    expect(outsider.kind).toBe('outsider');
    const verdict = authorizeRequest(outsider, { op: 'do', pane: 'p-op' }, 'w-op', undefined);
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.reason).toContain('no pane credential');
  });

  test('③ 진짜 OP pane: 모든 pane 허용', () => {
    expect(authorizeRequest(opRole, { op: 'do', pane: 'p-hand' }, 'w-hand', undefined)).toEqual({ allow: true });
    expect(authorizeRequest(opRole, { op: 'new', ws: 'w-x' }, undefined, undefined).allow).toBe(true);
  });

  test('④ 손은 자기 workspace 만', () => {
    expect(authorizeRequest(handRole, { op: 'do', pane: 'p-hand' }, 'w-hand', undefined)).toEqual({ allow: true });
    expect(authorizeRequest(handRole, { op: 'send', pane: 'p-op' }, 'w-op', undefined).allow).toBe(false);
  });

  test('close 는 confirm 필요 — 역할 무관', () => {
    const verdict = authorizeRequest(opRole, { op: 'close', pane: 'p-x' }, 'w-x', undefined);
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.reason).toContain('confirm');
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
  test('② outsider → OP pane input-line 원천 거부', () => {
    const registry = new PaneRegistry();
    const outsider = registry.classify(undefined);
    const verdict = authorizeRequest(outsider, { op: 'input-line', pane: 'p-op', text: 'x', from: 'y' }, 'w-op', undefined);
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.reason).toContain('mutating ops need a pane of this els server');
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
  test('a pane spawned without a credentialed parent may report its own pane; another pane or no token may not', () => {
    const own = handRole();
    expect(own).toMatchObject({ kind: 'hand', seat: 'unknown', pane: 'p-self' });
    expect(authorizeRequest(own, { op: 'build', pane: 'p-self' }, undefined, undefined).allow).toBe(true);
    expect(authorizeRequest(own, { op: 'build', pane: 'p-other' }, undefined, undefined).allow).toBe(false);
    expect(authorizeRequest({ kind: 'outsider', note: 'no pane credential' }, { op: 'build', pane: 'p-self' }, undefined, undefined).allow).toBe(false);
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

test('JUD #39096 ⓑ — no-token outsider keeps spawn (main behavior) but cannot type into panes', () => {
  const OUTSIDER: ServerRole = { kind: 'outsider', note: 'no pane credential' };
  expect(authorizeRequest(OUTSIDER, { op: 'new' }, undefined, undefined).allow).toBe(true);
  expect(authorizeRequest(OUTSIDER, INPUT_LINE_REQ, 'w1', PEER_INPUT_RULES).allow).toBe(false);
});

// JUD #39096 must ⓒ + CC-1 (OP #105970·#106123 턴3): raw paths (do/input-line/attach) are mapped
// door actions; an unmapped mutating op (rename — door-struct ops land in #102111) is fail-closed.
test('JUD #39096 ⓒ CC-1 — unmapped mutating op (rename) is fail-closed at the door for every role', () => {
  const peer: ServerRole = { kind: 'peer', pid: PEER_PID, pane: PEER_PANE, seat: 'OP', uid: PEER_UID };
  const verdict = authorizeRequest(peer, { op: 'rename', pane: 'p1' }, 'w1', PEER_INPUT_RULES);
  expect(verdict.allow).toBe(false);
  const outsider = { kind: 'outsider', note: 'raw socket' } as ServerRole;
  expect(authorizeRequest(outsider, { op: 'rename' }, undefined, undefined).allow).toBe(false);
  // mapped raw paths stay door actions at authorizeRequest: do/attach/input-line reach the
  // pane-role door below (asserted by the ⓒ attach·input-line tests above) — rename does not.
});

describe('ELS-PTY-RECORD door: snapshot writes a file so it is mutating, judged as `read`; record is judged as `do`', () => {
  test('분류: snapshot·record 모두 mutating (outsider 불가)', () => {
    expect(isMutating({ op: 'snapshot', pane: 'p' })).toBe(true);
    expect(isMutating({ op: 'record', pane: 'p' })).toBe(true);
  });
  test('snapshot: outsider 거부 · own-workspace hand 허용 · other workspace hand 거부 · OP 허용 · 미등록 owner 허용', () => {
    const registry = new PaneRegistry();
    expect(authorizeRequest(registry.classify(undefined), { op: 'snapshot', pane: 'p' }, 'w-hand', undefined).allow).toBe(false);
    const handEnv = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-hand', ELANOUS_ELS_WS: 'w-hand' }, '/Users/x/elanous-hq/seats/HAND-MCP', HAND_PARENT);
    const hand = registry.classify({ token: handEnv[PANE_ENV] });
    expect(authorizeRequest(hand, { op: 'snapshot', pane: 'p-hand' }, 'w-hand', undefined).allow).toBe(true);
    expect(authorizeRequest(hand, { op: 'snapshot', pane: 'p-other' }, 'w-other', undefined).allow).toBe(false);
    const opEnv = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-op', ELANOUS_ELS_WS: 'OP' }, '/x', OP_PARENT);
    expect(authorizeRequest(registry.classify({ token: opEnv[PANE_ENV] }), { op: 'snapshot', pane: 'p-other' }, 'w-other', undefined).allow).toBe(true);
    const owner = registry.registerOwner();
    expect(authorizeRequest(registry.classify({ token: owner.token }), { op: 'snapshot', pane: 'p' }, 'w', undefined).allow).toBe(true);
  });
  test('record: outsider 거부 · own-workspace hand 허용 · other workspace hand 거부', () => {
    const registry = new PaneRegistry();
    expect(authorizeRequest(registry.classify(undefined), { op: 'record', pane: 'p' }, 'w-hand', undefined).allow).toBe(false);
    const handEnv = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-hand', ELANOUS_ELS_WS: 'w-hand' }, '/Users/x/elanous-hq/seats/HAND-MCP', HAND_PARENT);
    const hand = registry.classify({ token: handEnv[PANE_ENV] });
    expect(authorizeRequest(hand, { op: 'record', pane: 'p-hand' }, 'w-hand', undefined).allow).toBe(true);
    expect(authorizeRequest(hand, { op: 'record', pane: 'p-other' }, 'w-other', undefined).allow).toBe(false);
  });
});
