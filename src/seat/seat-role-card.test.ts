import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSeatRoleCardBlock,
  SEAT_ROLE_CARD_FILE,
  SEAT_ROLE_CARD_MAX_CHARS,
  SEAT_ROLE_CARD_MAX_FILE_BYTES,
  type SeatRoleCardIo,
} from './seat-role-card.js';
import { buildSeatBootSystemMessages, resetSeatBootCacheForTest, startSeatBootConversation } from './seat-boot-preamble.js';

const roots: string[] = [];
afterEach(() => { resetSeatBootCacheForTest(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'seat-role-card-')); roots.push(dir); return dir; };

describe('role card reading', () => {
  test('a present card is injected with its own words under a heading naming the seat', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), '# Mission\nKeep the reviews moving.\n');
    const block = buildSeatRoleCardBlock('JUD', dir);
    expect(block.state).toBe('present');
    expect(block.truncated).toBe(false);
    expect(block.text).toContain('Role card — JUD');
    expect(block.text).toContain('Keep the reviews moving.');
  });

  test('a missing card becomes the instruction to write one, naming the path', () => {
    const dir = tmp();
    const missing = buildSeatRoleCardBlock('JUD', dir);
    expect(missing.state).toBe('missing');
    expect(missing.text).toContain(join(dir, SEAT_ROLE_CARD_FILE));
    expect(missing.text).toContain('first action');
  });

  test('a card longer than the cap is cut and the seat is told where the rest is', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'x'.repeat(SEAT_ROLE_CARD_MAX_CHARS + SEAT_ROLE_CARD_MAX_CHARS));
    const block = buildSeatRoleCardBlock('JUD', dir);
    expect(block.truncated).toBe(true);
    expect(block.text).toContain(join(dir, SEAT_ROLE_CARD_FILE));
    expect(block.text.length).toBeLessThan(SEAT_ROLE_CARD_MAX_CHARS + SEAT_ROLE_CARD_MAX_CHARS);
  });

  test('a link, a directory or an oversized file is never read as a card and is never to be overwritten', () => {
    const asLink = tmp();
    writeFileSync(join(asLink, 'real.md'), 'secret words');
    symlinkSync(join(asLink, 'real.md'), join(asLink, SEAT_ROLE_CARD_FILE));
    const asDir = tmp();
    mkdirSync(join(asDir, SEAT_ROLE_CARD_FILE));
    const tooBig = tmp();
    writeFileSync(join(tooBig, SEAT_ROLE_CARD_FILE), 'y'.repeat(SEAT_ROLE_CARD_MAX_FILE_BYTES + SEAT_ROLE_CARD_MAX_FILE_BYTES));
    for (const dir of [asLink, asDir, tooBig]) {
      const block = buildSeatRoleCardBlock('JUD', dir);
      expect(block.state).toBe('unreadable');
      expect(block.text).toContain('Do not overwrite or delete it');
      expect(block.text).not.toContain('secret words');
    }
  });

  test('an empty card is said to exist but be empty (not missing)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), '   \n');
    const block = buildSeatRoleCardBlock('JUD', dir);
    expect(block.state).toBe('empty');
    expect(block.text).toContain('exists but is empty');
  });

  test('an open or read failure (injected, independent of file permissions) is stated and the descriptor is released', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'private words');
    const closed: number[] = [];
    const fakeFd = process.pid;
    const someSize = 'private words'.length;
    const failingOpen: SeatRoleCardIo = {
      open: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      stat: () => ({ isFile: () => true, size: someSize }), read: () => Number.NaN, close: fd => { closed.push(fd); },
      realpath: path => realpathSync(path), // the flow reaches the injected open failure (no early unresolved return)
      statDir: () => ({ dev: 41, ino: 97, isDirectory: true, isSymbolicLink: false }),
      statPath: () => ({ dev: 41, ino: 97 }), // the resolved seat dir states as the anchored identity
    };
    const failingRead: SeatRoleCardIo = {
      // dev/ino state the opened descriptor's own identity (the descriptor binding check needs them):
      // without them the read never happens and the descriptor is never released through the failure path.
      open: () => fakeFd, stat: () => ({ isFile: () => true, size: someSize, dev: 41, ino: 97 }),
      read: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); }, close: fd => { closed.push(fd); },
      realpath: path => realpathSync(path), // without it the flow returns before the open and never releases anything
      statDir: () => ({ dev: 41, ino: 97, isDirectory: true, isSymbolicLink: false }),
      statPath: () => ({ dev: 41, ino: 97 }), // matches the descriptor stat and the anchored dir identity
    };
    for (const io of [failingOpen, failingRead]) {
      const block = buildSeatRoleCardBlock('JUD', dir, io);
      expect(block.state).toBe('unreadable');
      expect(block.text).toContain('Do not overwrite or delete it');
      expect(block.text).not.toContain('private words');
    }
    expect(closed).toEqual([fakeFd]);
  });

  test('the size check and the read use the same opened descriptor (a swapped file cannot change what is read)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'ok');
    const seen: string[] = [];
    const fd = process.pid;
    const body = 'ok';
    const io: SeatRoleCardIo = {
      open: () => { seen.push('open'); return fd; },
      stat: used => { seen.push(`stat:${used}`); return { isFile: () => true, size: body.length, dev: 41, ino: 97 }; },
      read: (used, buffer) => { seen.push(`read:${used}`); buffer.write(body); return body.length; },
      close: fd => { seen.push(`close:${fd}`); },
      realpath: path => realpathSync(path),
      statDir: () => ({ dev: 41, ino: 97, isDirectory: true, isSymbolicLink: false }),
      statPath: () => ({ dev: 41, ino: 97 }), // same object the descriptor opened — the binding is verifiable
    };
    expect(buildSeatRoleCardBlock('JUD', dir, io).text).toContain('ok');
    expect(seen).toEqual(['open', `stat:${fd}`, `read:${fd}`, `close:${fd}`]);
  });

  test('a partial-read device advances the file position and the card is assembled whole (JUD-B #119906)', () => {
    const dir = tmp();
    const lines = 90; // many 7-byte reads, still far under the character cap
    const original = `${Array.from({ length: lines }, (_, index) => `role line ${index}`).join('\n')}\n`;
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), original);
    const positions: number[] = [];
    let delivered = 0;
    const io: SeatRoleCardIo = {
      // The device never fills the buffer in one read: every read must start where the last one ended.
      open: () => process.pid,
      stat: () => ({ isFile: () => true, size: original.length, dev: 41, ino: 97 }),
      realpath: path => realpathSync(path),
      statDir: () => ({ dev: 41, ino: 97, isDirectory: true, isSymbolicLink: false }),
      statPath: () => ({ dev: 41, ino: 97 }), // same object the descriptor opened — the binding is verifiable
      read: (_fd, buffer, length, position?: number) => {
        if (position === undefined || position !== delivered) {
          throw Object.assign(new Error(`card device read at ${position ?? 'no file position'}, expected ${delivered}`), { code: 'EIO' });
        }
        positions.push(position);
        const take = Math.min(7, length, original.length - position);
        buffer.write(original.slice(position, position + take));
        delivered += take;
        return take;
      },
      close: () => {},
    };
    const block = buildSeatRoleCardBlock('JUD', dir, io);
    expect(block.state).toBe('present');
    expect(block.truncated).toBe(false);
    // Whole and nothing else: a repeated front or a lost tail both break this.
    expect(block.text.endsWith(original.trim())).toBe(true);
    expect(positions.length).toBeGreaterThan(1);
    expect(positions[0]).toBe(0);
  });

  test('a seat dir symlinked out of the seat-state root is never read into the card (fail closed, JUD-B #119921)', () => {
    const home = tmp();
    const stateRoot = join(home, 'elanous-hq', 'seat-state');
    mkdirSync(stateRoot, { recursive: true });
    const outside = tmp();
    writeFileSync(join(outside, SEAT_ROLE_CARD_FILE), 'poisoned words\n');
    symlinkSync(outside, join(stateRoot, 'JUD')); // the parent path is the trust boundary; this one escapes it
    const escaped = buildSeatRoleCardBlock('JUD', join(stateRoot, 'JUD'));
    expect(escaped.state).toBe('unreadable');
    expect(escaped.text).not.toContain('poisoned words');
    expect(escaped.text).toContain('Do not overwrite or delete it');
    const confined = tmp();
    writeFileSync(join(confined, SEAT_ROLE_CARD_FILE), 'honest words\n');
    expect(buildSeatRoleCardBlock('JUD', confined).state).toBe('present'); // a dir inside the root still reads
  });

  test("a seat dir swapped for another seat's directory inside the root is never read (JUD #120348)", () => {
    const stateRoot = tmp();
    mkdirSync(join(stateRoot, 'MVP-B'), { recursive: true });
    writeFileSync(join(stateRoot, 'MVP-B', SEAT_ROLE_CARD_FILE), "another seat's words\n");
    symlinkSync(join(stateRoot, 'MVP-B'), join(stateRoot, 'JUD')); // inside the root, but it is not this seat's dir
    const block = buildSeatRoleCardBlock('JUD', join(stateRoot, 'JUD'));
    expect(block.state).toBe('unreadable');
    expect(block.text).not.toContain("another seat's words");
  });

  test('the opened descriptor must be the object the approved path resolves to (JUD #120348)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'ok');
    const fd = process.pid;
    const io: SeatRoleCardIo = {
      open: () => fd,
      stat: () => ({ isFile: () => true, size: 2, dev: 41, ino: 97 }),
      read: (_fd, buffer) => { buffer.write('ok'); return 2; },
      close: () => {},
      realpath: path => realpathSync(path),
      // The path names a different object (ino 98) than the descriptor opened (ino 97): a swapped-in substitute.
      statPath: () => ({ dev: 41, ino: 98 }),
    };
    const block = buildSeatRoleCardBlock('JUD', dir, io);
    expect(block.state).toBe('unreadable');
    expect(block.text).not.toContain('ok');
  });

  test('a path identity that cannot be stated is never read — fail closed (JUD 4th HOLD)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'identity words');
    // The descriptor is fine (dev 41, ino 97); the resolved path names an object statPath cannot state.
    let readCalls = 0;
    const unstatable: SeatRoleCardIo = {
      open: () => process.pid,
      stat: () => ({ isFile: () => true, size: 'identity words'.length, dev: 41, ino: 97 }),
      read: (_fd: number, buf: Buffer) => { readCalls++; return buf.write('identity words'); },
      close: () => {},
      realpath: path => realpathSync(path),
      statPath: () => null, // production statPath returns null when the object cannot be stated
    };
    const block = buildSeatRoleCardBlock('JUD', dir, unstatable);
    expect(readCalls).toBe(0); // a read through an unverifiable binding is never attempted (RED on a skip-and-read bug)
    expect(block.state).toBe('unreadable');
    expect(block.text).not.toContain('identity words');
  });

  test('an io with no path identity at all is never read — fail closed (JUD 4th HOLD)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'identity words');
    let readCalls = 0;
    const noIdentity: SeatRoleCardIo = {
      open: () => process.pid,
      stat: () => ({ isFile: () => true, size: 'identity words'.length, dev: 41, ino: 97 }),
      read: (_fd: number, buf: Buffer) => { readCalls++; return buf.write('identity words'); },
      close: () => {},
      realpath: path => realpathSync(path),
      // statPath deliberately absent: the opened object's identity cannot be verified
    };
    const block = buildSeatRoleCardBlock('JUD', dir, noIdentity);
    expect(readCalls).toBe(0); // a read through an unverifiable binding is never attempted (RED on a skip-and-read bug)
    expect(block.state).toBe('unreadable');
    expect(block.text).not.toContain('identity words');
  });

  test('an approved path that cannot be resolved is never read — fail closed (JUD 4th HOLD)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'resolution words');
    let readCalls = 0;
    const unresolvable: SeatRoleCardIo = {
      open: () => process.pid,
      stat: () => ({ isFile: () => true, size: 'resolution words'.length, dev: 41, ino: 97 }),
      read: (_fd: number, buf: Buffer) => { readCalls++; return buf.write('resolution words'); },
      close: () => {},
      realpath: () => null, // the resolution itself is unverifiable
      statPath: () => ({ dev: 41, ino: 97 }),
    };
    const block = buildSeatRoleCardBlock('JUD', dir, unresolvable);
    expect(readCalls).toBe(0); // a read of an unresolved path is never attempted (RED on a skip-and-read bug)
    expect(block.state).toBe('unreadable');
    expect(block.text).not.toContain('resolution words');
  });

  test("a card resolving under the trust root but outside the seat's own ROLE.md is never read (JUD 4th HOLD)", () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'elsewhere words');
    let readCalls = 0;
    const elsewhere: SeatRoleCardIo = {
      open: () => process.pid,
      stat: () => ({ isFile: () => true, size: 'elsewhere words'.length, dev: 41, ino: 97 }),
      read: (_fd: number, buf: Buffer) => { readCalls++; return buf.write('elsewhere words'); },
      close: () => {},
      // Resolved inside the trust root (same parent), but not the seat's own ROLE.md: a broad
      // root prefix alone would pass this; the identity check must bind to the exact expected path.
      realpath: path => `${realpathSync(path).slice(0, -SEAT_ROLE_CARD_FILE.length)}ELSEWHERE.md`,
      statPath: () => ({ dev: 41, ino: 97 }),
    };
    const block = buildSeatRoleCardBlock('JUD', dir, elsewhere);
    expect(readCalls).toBe(0); // a read of a path that is not the seat's own ROLE.md is never attempted (RED on a skip-and-read bug)
    expect(block.state).toBe('unreadable');
    expect(block.text).not.toContain('elsewhere words');
  });

  test('a seat dir stated as another object between the approval check and the card validation is never read (JUD 5th HOLD)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'swapped words');
    const realSeat = realpathSync(dir);
    const fd = process.pid;
    let readCalls = 0;
    let seatDirStats = 0;
    const substituted: SeatRoleCardIo = {
      open: () => fd,
      stat: () => ({ isFile: () => true, size: 'swapped words'.length, dev: 41, ino: 97 }),
      read: (_fd, buffer) => { readCalls++; return buffer.write('swapped words'); },
      close: () => {},
      realpath: path => realpathSync(path),
      // The seat dir is stated as one object when it is approved and as another when the card's
      // parent is validated: the path named a different directory between the two observations.
      statPath: path => {
        if (path !== realSeat) return { dev: 41, ino: 97 }; // the card path: the object the descriptor opened
        seatDirStats += 1;
        return seatDirStats === 1 ? { dev: 41, ino: 501 } : { dev: 41, ino: 502 };
      },
    };
    const block = buildSeatRoleCardBlock('JUD', dir, substituted);
    expect(readCalls).toBe(0); // a read through a seat dir that is not the approved object is never attempted (RED on an approve-anyway bug)
    expect(block.state).toBe('unreadable');
    expect(block.text).not.toContain('swapped words');
  });

  test('a seat dir swapped between the original directory check and the card open is never read (JUD 6th HOLD)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'swapped-in words');
    const realSeat = realpathSync(dir);
    let opened = false;
    let readCalls = 0;
    const calls: string[] = [];
    const swapped: SeatRoleCardIo = {
      open: () => { calls.push('open'); opened = true; return process.pid; },
      stat: () => ({ isFile: () => true, size: 'swapped-in words'.length, dev: 41, ino: 97 }),
      read: (_fd, buffer) => { readCalls++; return buffer.write('swapped-in words'); },
      close: () => {},
      realpath: path => { calls.push('realpath'); return realpathSync(path); },
      // The seat dir states as one object (ino 501) at the original directory check and as another
      // (ino 502) from the card open onward: the directory was swapped in between the check and
      // the open. Only the identity captured AT the check may anchor the card lookup — a later
      // path lookup that re-records the identity certifies the swap itself and is never trusted.
      statPath: path => {
        if (path !== realSeat) return { dev: 41, ino: 97 }; // the card path: the object the descriptor opened
        calls.push(opened ? 'stat:seat:after-open' : 'stat:seat:at-check');
        return opened ? { dev: 41, ino: 502 } : { dev: 41, ino: 501 };
      },
      // JUD 7th HOLD repair: the check itself supplies the anchor — the seat dir that passed the
      // check is stated as ino 501 at check time; the card's parent after the open is 502.
      statDir: () => ({ dev: 41, ino: 501, isDirectory: true, isSymbolicLink: false }),
    };
    const block = buildSeatRoleCardBlock('JUD', dir, swapped);
    expect(readCalls).toBe(0); // a read through a dir that is not the check-time object is never attempted (RED on an anchor-later bug)
    expect(block.state).toBe('unreadable');
    expect(block.text).not.toContain('swapped-in words');
    // The identity is anchored at the original check: the seat-dir stat precedes the card open.
    expect(calls[calls.indexOf('open') - 1]).toBe('stat:seat:at-check');
  });

  test('a seat dir swapped between the original directory check and the identity capture is never read (JUD 7th HOLD)', () => {
    const home = tmp();
    const seatDir = join(home, 'seat');
    mkdirSync(seatDir);
    writeFileSync(join(seatDir, SEAT_ROLE_CARD_FILE), 'honest words');
    const attacker = join(home, 'attacker');
    mkdirSync(attacker);
    writeFileSync(join(attacker, SEAT_ROLE_CARD_FILE), 'swapped-early words');
    let alreadySwapped = false;
    const swapped: SeatRoleCardIo = {
      open: path => openSync(path, 'r'),
      stat: fd => fstatSync(fd),
      read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position),
      close: fd => closeSync(fd),
      // The directory is swapped in the first path operation after the original directory
      // check — between the check and the identity capture. An identity captured through
      // the path at this point certifies the attacker's directory (JUD 7th HOLD): only the
      // identity of the directory that passed the original non-symlink check may anchor
      // the card lookup, and the file lookup must be bound to that opened directory.
      realpath: path => {
        if (!alreadySwapped) {
          alreadySwapped = true;
          renameSync(seatDir, join(home, 'seat-orig'));
          renameSync(attacker, seatDir);
        }
        return realpathSync(path);
      },
      statPath: path => { const stated = statSync(path); return { dev: stated.dev, ino: stated.ino }; },
    };
    const block = buildSeatRoleCardBlock('JUD', seatDir, swapped);
    expect(block.state).toBe('unreadable');
    expect(block.text).not.toContain('swapped-early words');
  });

  test('ENOENT is «missing» only through the anchored seat dir; a swap before the open fails closed (TC #123491 ②)', () => {
    const home = tmp();
    const seatDir = join(home, 'seat');
    mkdirSync(seatDir);
    const attacker = join(home, 'attacker');
    mkdirSync(attacker);
    const honestOpen = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const honestIo: SeatRoleCardIo = {
      open: honestOpen, stat: () => { throw new Error('unreached'); }, read: () => { throw new Error('unreached'); },
      close: () => {}, realpath: path => realpathSync(path),
      statDir: () => ({ dev: 41, ino: 501, isDirectory: true, isSymbolicLink: false }),
      statPath: path => (path === realpathSync(seatDir) ? { dev: 41, ino: 501 } : { dev: 41, ino: 97 }),
    };
    const honest = buildSeatRoleCardBlock('JUD', seatDir, honestIo);
    expect(honest.state).toBe('missing'); // ENOENT with the anchored dir intact is the honest «no card yet»
    let swappedAtOpen = false;
    const swappedIo: SeatRoleCardIo = {
      open: () => { swappedAtOpen = true; renameSync(seatDir, join(home, 'seat-orig')); renameSync(attacker, seatDir); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      stat: () => { throw new Error('unreached'); }, read: () => { throw new Error('unreached'); },
      close: () => {},
      realpath: path => realpathSync(path),
      statDir: () => ({ dev: 41, ino: 501, isDirectory: true, isSymbolicLink: false }),
      // Before the open the seat dir still states as the anchored identity; after the swap
      // inside open() the ENOENT re-check must state a different object — that mismatch is the proof.
      statPath: () => (swappedAtOpen ? { dev: 41, ino: 502 } : { dev: 41, ino: 501 }),
    };
    // read the card through the swapping io: open() swaps the directories and throws ENOENT, so the
    // ENOENT re-check re-states the swapped-in object (502) against the anchored one (501) and fails closed.
    const swapped = buildSeatRoleCardBlock('JUD', seatDir, swappedIo);
    expect(swappedAtOpen).toBe(true); // the open (and therefore the swap) was really reached
    expect(swapped.state).toBe('unreadable'); // the ENOENT no longer comes through the checked object
    expect(swapped.text).not.toContain('has none yet');
  });

  test('the card open rides the anchored dir handle, never a fresh path walk (JUD #124088 보안 HOLD)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'card words');
    const realSeat = realpathSync(dir);
    const cardPath = join(realSeat, SEAT_ROLE_CARD_FILE);
    // The attack: the dir checks stay honest, but the card open walks the path again and lands on
    // the attacker card, and the fd-vs-path identity stat that should prove the descriptor walks the
    // path again too — so every "proof" names the attacker object and agrees with the opened one.
    const attacked: SeatRoleCardIo = {
      open: () => 7, // a fresh path walk: the swapped-in attacker card
      stat: fd => (fd === 7
        ? { isFile: () => true, size: 19, dev: 41, ino: 502 } // the attacker card, path-opened
        : { isFile: () => true, size: 10, dev: 41, ino: 501 }), // the dir handle states the anchored dir
      read: (fd, buffer) => { if (fd === 7) buffer.write('attacker card words', 0, 'utf8'); return fd === 7 ? 19 : 0; },
      close: () => {},
      realpath: path => realpathSync(path),
      statDir: () => ({ dev: 41, ino: 501, isDirectory: true, isSymbolicLink: false }),
      // dir lookups stay honest (501); the card path lookup is scheduled to the attacker (502) —
      // the exact object the path-opened descriptor opened, so the fd binding certifies the attacker.
      statPath: path => (path === cardPath ? { dev: 41, ino: 502 } : { dev: 41, ino: 501 }),
      openDir: () => 9, // the anchored dir opened as a handle
      openAt: fd => (fd === 9 ? 8 : -1), // the card THROUGH the handle: the real card
    };
    const block = buildSeatRoleCardBlock('JUD', dir, attacked);
    expect(block.state).toBe('unreadable'); // the attacker card is never read
    expect(block.text).not.toContain('attacker card words');
  });

  test('the card reads through the anchored dir handle when the io provides it (JUD #124088 repair)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'handle card words');
    const realSeat = realpathSync(dir);
    const realFd = openSync(join(dir, SEAT_ROLE_CARD_FILE), 'r');
    const seatStat = statSync(realSeat);
    let dirOpened = 0;
    let atOpened = 0;
    const viaHandle: SeatRoleCardIo = {
      open: () => { throw new Error('unreached: the path open is never used'); },
      stat: fd => (fd === 9 ? { isFile: () => true, size: 0, dev: seatStat.dev, ino: seatStat.ino } : fstatSync(realFd)),
      read: (fd, buffer, length, position) => (fd === 8 ? readSync(realFd, buffer, 0, length, position) : 0),
      close: () => {},
      realpath: path => realpathSync(path),
      statDir: () => ({ dev: seatStat.dev, ino: seatStat.ino, isDirectory: true, isSymbolicLink: false }),
      statPath: path => { const s = statSync(path); return { dev: s.dev, ino: s.ino }; },
      openDir: () => { dirOpened += 1; return 9; },
      openAt: fd => { if (fd !== 9) throw new Error('bad dirfd'); atOpened += 1; return 8; },
    };
    const block = buildSeatRoleCardBlock('JUD', dir, viaHandle);
    closeSync(realFd);
    expect(block.state).toBe('present');
    expect(block.text).toContain('handle card words');
    expect(dirOpened).toBe(1); // the dir really opened as a handle
    expect(atOpened).toBe(1); // the card really opened through the handle
  });

  test('the real default io reads the card through the dir handle (JUD #124088 repair, real openat(2))', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'real handle card words');
    const block = buildSeatRoleCardBlock('JUD', dir); // no io: the real default, real openat(2)
    expect(block.state).toBe('present');
    expect(block.text).toContain('real handle card words');
    const fresh = buildSeatRoleCardBlock('JUD', tmp()); // no card yet: ENOENT through the handle
    expect(fresh.state).toBe('missing');
    const linked = tmp();
    symlinkSync('elsewhere', join(linked, SEAT_ROLE_CARD_FILE));
    const loop = buildSeatRoleCardBlock('JUD', linked); // O_NOFOLLOW: ELOOP stays unreadable
    expect(loop.state).toBe('unreadable');
  });

  test('a read EIO proves the read was attempted and the descriptor closed (TC #123491 ③)', () => {
    const dir = tmp();
    writeFileSync(join(dir, SEAT_ROLE_CARD_FILE), 'card words');
    const realSeat = realpathSync(dir);
    let readCalls = 0;
    let closeCalls = 0;
    const eio: SeatRoleCardIo = {
      open: () => 7,
      stat: () => ({ isFile: () => true, size: 10, dev: 41, ino: 97 }),
      read: () => { readCalls++; throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
      close: () => { closeCalls++; },
      realpath: path => realpathSync(path),
      statDir: () => ({ dev: 41, ino: 501, isDirectory: true, isSymbolicLink: false }),
      statPath: path => (path === realSeat ? { dev: 41, ino: 501 } : { dev: 41, ino: 97 }),
    };
    const block = buildSeatRoleCardBlock('JUD', dir, eio);
    expect(block.state).toBe('unreadable');
    expect(readCalls).toBe(1); // the failure is a real read failure, not a skipped read
    expect(closeCalls).toBe(1); // the opened descriptor is released on the failure path
    expect(block.text).toContain('could not be read');
  });
});

describe('boot card carries the role card', () => {
  const seatHome = (seat: string) => {
    const home = tmp();
    const cwd = join(home, 'elanous-hq', 'seats', seat);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', seat), { recursive: true });
    return { home, cwd, seatDir: join(home, 'elanous-hq', 'seat-state', seat) };
  };
  const card = (home: string, cwd: string) => buildSeatBootSystemMessages({ cwd }, { home, msgPath: join(home, 'msg.db'), env: {} })
    .map(message => String(message.content)).join('\n');

  test('with a card the boot text includes it; with none it asks the seat to write one', () => {
    const withCard = seatHome('JUD');
    writeFileSync(join(withCard.seatDir, SEAT_ROLE_CARD_FILE), 'Mission: judge landed cells.');
    expect(card(withCard.home, withCard.cwd)).toContain('Mission: judge landed cells.');
    resetSeatBootCacheForTest();
    const without = seatHome('JUD');
    expect(card(without.home, without.cwd)).toContain('has none yet');
  });

  test('the card is read once per conversation: an edit shows in the next conversation, not mid-conversation', () => {
    const { home, cwd, seatDir } = seatHome('JUD');
    writeFileSync(join(seatDir, SEAT_ROLE_CARD_FILE), 'first version');
    const before = card(home, cwd);
    writeFileSync(join(seatDir, SEAT_ROLE_CARD_FILE), 'second version');
    expect(card(home, cwd)).toBe(before);
    startSeatBootConversation({ reason: 'session-new' });
    expect(card(home, cwd)).toContain('second version');
  });

  test('a non-seat directory gets no role card text', () => {
    const home = tmp();
    const cwd = join(home, 'work');
    mkdirSync(cwd, { recursive: true });
    expect(card(home, cwd)).not.toContain('Role card');
  });
});
