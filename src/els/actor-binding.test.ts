import { expect, test } from 'bun:test';
import { ActorBindings } from './actor-binding.js';

test('issue pins the supplied primary PID and generation to trusted live observations', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  const actors = new ActorBindings(() => binding, () => primary);
  expect(actors.issue('OP', 'p1', 201, 'a')).toBe(false);
  expect(actors.issue('OP', 'p1', 200, 'wrong')).toBe(false);
  expect(actors.resolve(200, primary)).toBeUndefined();
  expect(actors.issue('OP', 'p1', 200, 'a')).toBe(true);
  expect(actors.resolve(200, primary)).toEqual({ pane: 'p1', seat: 'OP' });
  actors.revoke('p1');
  expect(actors.resolve(200, primary)).toBeUndefined();
});

test('owner binding admits only exact live primary and revokes on replacement or release', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  let binding: any = { pid: 200, start: '1:1', generation: 'a' };
  let current: any = primary;
  const actors = new ActorBindings(() => binding, () => current);
  expect(actors.resolve(200, primary)).toBeUndefined();
  expect(actors.issue('OP', 'p1', 200, 'a')).toBe(true);
  expect(actors.resolve(200, primary)).toEqual({ pane: 'p1', seat: 'OP' });
  expect(actors.resolve(201, { ...primary, pid: 201 })).toBeUndefined();
  current = { ...primary, tty: 13 };
  expect(actors.resolve(200, primary)).toBeUndefined();
  current = primary;
  binding = { ...binding, generation: 'b' };
  expect(actors.resolve(200, primary)).toBeUndefined();
  binding = { ...binding, generation: 'a' };
  expect(actors.resolve(200, primary)).toBeUndefined();
  expect(actors.issue('OP', 'p1', 200, 'a')).toBe(true);
  actors.revoke('p1');
  expect(actors.resolve(200, primary)).toBeUndefined();
});

test('queued authority expires after unbind and reissue for the same pane and process', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  const actors = new ActorBindings(() => binding, () => primary);
  expect(actors.issue('OP', 'p1', 200, 'a')).toBe(true);
  const issued = actors.capture(200, primary);
  expect(issued).toBeDefined();
  expect(actors.isCurrent(issued!)).toBe(true);
  actors.revoke('p1');
  expect(actors.isCurrent(issued!)).toBe(false);
  expect(actors.issue('OP', 'p1', 200, 'a')).toBe(true);
  expect(actors.isCurrent(issued!)).toBe(false);
  const renewed = actors.capture(200, primary);
  expect(renewed).toBeDefined();
  expect(actors.isCurrent(renewed!)).toBe(true);
});

test('bind rejects missing, mismatched, changing and throwing trusted observations', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  expect(new ActorBindings(() => undefined, () => primary).issue('OP', 'p', 200, 'a')).toBe(false);
  expect(new ActorBindings(() => binding, () => ({ ...primary, start: '2:1' })).issue('OP', 'p', 200, 'a')).toBe(false);
  expect(new ActorBindings(() => binding, () => { throw Error('unavailable'); }).issue('OP', 'p', 200, 'a')).toBe(false);
  let calls = 0;
  const actors = new ActorBindings(() => ++calls === 1 ? binding : { ...binding, generation: 'b' }, () => primary);
  expect(actors.issue('OP', 'p', 200, 'a')).toBe(false);
  expect(actors.resolve(200, primary)).toBeUndefined();
});

test('peer baseline cannot impersonate or revoke; failed rebind and release revoke', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  let binding: { pid: number; start: string; generation: string } | undefined = { pid: 200, start: '1:1', generation: 'a' };
  const actors = new ActorBindings(() => binding, () => primary);
  expect(actors.issue('OP', 'p', 200, 'a')).toBe(true);
  expect(actors.resolve(200, { ...primary, start: '2:1' })).toBeUndefined();
  expect(actors.resolve(200, primary)).toEqual({ pane: 'p', seat: 'OP' });
  binding = undefined;
  expect(actors.issue('OP', 'p', 200, 'a')).toBe(false);
  binding = { pid: 200, start: '1:1', generation: 'a' };
  expect(actors.resolve(200, primary)).toBeUndefined();
  expect(actors.issue('OP', 'p', 200, 'a')).toBe(true);
  actors.revoke('p');
  expect(actors.resolve(200, primary)).toBeUndefined();
});

test('a lookup exception on an ambiguous peer denies the entire resolution', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  let fail = false;
  const actors = new ActorBindings((pane) => { if (fail && pane === 'p2') throw Error('lookup failed'); return binding; }, () => primary);
  expect(actors.issue('OP', 'p1', 200, 'a')).toBe(true);
  expect(actors.issue('RES', 'p2', 200, 'a')).toBe(true);
  fail = true;
  expect(actors.resolve(200, primary)).toBeUndefined();
});

test('mutable lookup objects cannot rewrite captured identity and ambiguous panes deny', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  const actors = new ActorBindings(() => binding, () => primary);
  expect(actors.issue('OP', 'p1', 200, 'a')).toBe(true);
  expect(actors.issue('RES', 'p2', 200, 'a')).toBe(true);
  expect(actors.resolve(200, primary)).toBeUndefined();
  actors.revoke('p2');
  expect(actors.resolve(200, primary)).toEqual({ pane: 'p1', seat: 'OP' });
  binding.generation = 'b';
  expect(actors.resolve(200, primary)).toBeUndefined();
  binding.generation = 'a';
  expect(actors.resolve(200, primary)).toBeUndefined();
});

test('child capture pins peer ancestry and expires on reparent, replacement or revocation', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const child = { pid: 201, ppid: 200, start: '2:1', startedMs: 2, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  const processes = new Map([[200, primary], [201, child]]);
  const actors = new ActorBindings(() => binding, pid => processes.get(pid), () => [{ pane: 'p', pid: 200 }]);
  expect(actors.issue('OP', 'p', 200, 'a', { pid: 201, start: '2:1' })).toBe(true);
  expect(actors.capture(201, { ...child, start: 'forged' })).toBeUndefined();
  const captured = actors.capture(201, child)!;
  expect(captured).toEqual({ pane: 'p', seat: 'OP' });
  expect(actors.isCurrent(captured)).toBe(true);
  processes.set(201, { ...child, ppid: 1 });
  expect(actors.isCurrent(captured)).toBe(false);
  processes.set(201, child);
  expect(actors.isCurrent(captured)).toBe(true);
  actors.revoke('p');
  expect(actors.isCurrent(captured)).toBe(false);
  expect(actors.issue('OP', 'p', 200, 'a')).toBe(true);
  expect(actors.isCurrent(captured)).toBe(false);
});

test('grandchild and pid-reuse impostors are rejected — only the direct child may act (JUD #39484 ①②)', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const child = { pid: 201, ppid: 200, start: '2:1', startedMs: 2, session: 200, tty: 12 };
  const grandchild = { pid: 202, ppid: 201, start: '3:1', startedMs: 3, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  const processes = new Map([[200, primary], [201, child], [202, grandchild]]);
  const actors = new ActorBindings(() => binding, pid => processes.get(pid), () => [{ pane: 'p', pid: 200 }]);
  expect(actors.issue('OP', 'p', 200, 'a', { pid: 201, start: '2:1' })).toBe(true);
  // grandchild (ancestor walk of 2) must be denied — direct child only
  expect(actors.capture(202, grandchild)).toBeUndefined();
  expect(actors.resolve(202, grandchild)).toBeUndefined();
  // direct child passes
  expect(actors.capture(201, child)).toEqual({ pane: 'p', seat: 'OP' });
  // pid reuse: same pid 201, different birth → denied
  processes.set(201, { ...child, start: '9:9', startedMs: 9 });
  expect(actors.resolve(201, processes.get(201))).toBeUndefined();
  expect(actors.capture(201, processes.get(201))).toBeUndefined();
  // the impostor probe is over: the original child is still the live process at pid 201
  processes.set(201, child);
  // revoked-pane delayed message on the same socket → isCurrent false
  const recaptured = actors.capture(201, { ...child });
  expect(recaptured).toBeDefined();
  actors.revoke('p');
  expect(actors.isCurrent(recaptured!)).toBe(false);
});

test('same-shell direct children: only the issue-approved child may act (JUD #128532)', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const approved = { pid: 201, ppid: 200, start: '2:1', startedMs: 2, session: 200, tty: 12 };
  const sibling = { pid: 203, ppid: 200, start: '4:1', startedMs: 4, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  const processes = new Map([[200, primary], [201, approved], [203, sibling]]);
  const actors = new ActorBindings(() => binding, pid => processes.get(pid), () => [{ pane: 'p', pid: 200 }]);
  expect(actors.issue('OP', 'p', 200, 'a', { pid: 201, start: '2:1' })).toBe(true);
  // the unapproved sibling is a direct child of the same shell; first arrival must not elect it
  expect(actors.resolve(203, sibling)).toBeUndefined();
  expect(actors.capture(203, sibling)).toBeUndefined();
  expect(actors.resolve(201, approved)).toEqual({ pane: 'p', seat: 'OP' });
  // without an issue-approved child no child gains authority at all
  const bare = new ActorBindings(() => binding, pid => processes.get(pid), () => [{ pane: 'p', pid: 200 }]);
  expect(bare.issue('OP', 'p', 200, 'a')).toBe(true);
  expect(bare.resolve(201, approved)).toBeUndefined();
  expect(bare.resolve(203, sibling)).toBeUndefined();
});

test('issuance pins the approved child pid and birth from live observation — never the first actor (JUD #39561)', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const approved = { pid: 201, ppid: 200, start: '2:1', startedMs: 2, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  const processes = new Map([[200, primary], [201, approved]]);
  const actors = new ActorBindings(() => binding, pid => processes.get(pid), () => [{ pane: 'p', pid: 200 }]);
  // the approved child must be a live direct child of the pane primary — not any pid, not the primary itself
  expect(actors.issue('OP', 'p', 200, 'a', 999)).toBe(false);
  expect(actors.issue('OP', 'p', 200, 'a', 200)).toBe(false);
  processes.set(201, { ...approved, ppid: 1 });
  expect(actors.issue('OP', 'p', 200, 'a', 201)).toBe(false);
  processes.set(201, approved);
  // an unstable child observation (the birth moves between the issuance's own reads) refuses
  let childLooks = 0;
  const flaky = new ActorBindings(() => binding, pid => pid === 201
    ? (++childLooks === 1 ? approved : { ...approved, start: '5:5' }) : processes.get(pid),
    () => [{ pane: 'p', pid: 200 }]);
  expect(flaky.issue('OP', 'p', 200, 'a', 201)).toBe(false);
  expect(actors.issue('OP', 'p', 200, 'a', 201)).toBe(true);
  // proof of the issuance-time pin: an unapproved sibling acting FIRST is still rejected
  const sibling = { pid: 203, ppid: 200, start: '4:1', startedMs: 4, session: 200, tty: 12 };
  processes.set(203, sibling);
  expect(actors.resolve(203, sibling)).toBeUndefined();
  expect(actors.capture(203, sibling)).toBeUndefined();
  // the pane primary stays a resolvable actor beside the issuance-bound child
  expect(actors.resolve(200, primary)).toEqual({ pane: 'p', seat: 'OP' });
});

test('resolve admits only the issuance-approved child among the same shell direct children (JUD #39561)', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const approved = { pid: 201, ppid: 200, start: '2:1', startedMs: 2, session: 200, tty: 12 };
  const sibling = { pid: 203, ppid: 200, start: '4:1', startedMs: 4, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  const processes = new Map([[200, primary], [201, approved], [203, sibling]]);
  const actors = new ActorBindings(() => binding, pid => processes.get(pid), () => [{ pane: 'p', pid: 200 }]);
  expect(actors.issue('OP', 'p', 200, 'a', 201)).toBe(true);
  // the approved child alone passes — exact pid and birth
  expect(actors.resolve(201, approved)).toEqual({ pane: 'p', seat: 'OP' });
  expect(actors.resolve(201, { ...approved, start: 'forged' })).toBeUndefined();
  // a different direct child of the same shell is rejected, before or after the approved child acts
  expect(actors.resolve(203, sibling)).toBeUndefined();
  // re-issue switches the approved child at once; the previous one loses the authority
  expect(actors.issue('OP', 'p', 200, 'a', 203)).toBe(true);
  expect(actors.resolve(201, approved)).toBeUndefined();
  expect(actors.resolve(203, sibling)).toEqual({ pane: 'p', seat: 'OP' });
});

test('a pid reused with a different birth is refused even as the first actor after issuance (JUD #39561)', () => {
  const primary = { pid: 200, ppid: 1, start: '1:1', startedMs: 1, session: 200, tty: 12 };
  const approved = { pid: 201, ppid: 200, start: '2:1', startedMs: 2, session: 200, tty: 12 };
  const binding = { pid: 200, start: '1:1', generation: 'a' };
  const processes = new Map([[200, primary], [201, approved]]);
  const actors = new ActorBindings(() => binding, pid => processes.get(pid), () => [{ pane: 'p', pid: 200 }]);
  expect(actors.issue('OP', 'p', 200, 'a', 201)).toBe(true);
  // the approved child never acted; its pid was reused with a new birth — the impostor acts first
  const reused = { ...approved, start: '9:9', startedMs: 9 };
  processes.set(201, reused);
  expect(actors.resolve(201, reused)).toBeUndefined();
  expect(actors.capture(201, reused)).toBeUndefined();
  // the original child still holds the authority once it is the live process again
  processes.set(201, approved);
  expect(actors.resolve(201, approved)).toEqual({ pane: 'p', seat: 'OP' });
});
