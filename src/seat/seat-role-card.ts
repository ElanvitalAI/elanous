// SEAT-ROLE-CARD-AND-SELF-RETRO · device 1 — boot injection of `seat-state/<SEAT>/ROLE.md`.
//
// A seat session carries its own role card from the first turn. The card is read once per conversation (the boot
// card cache keeps the bytes stable), capped, and refused when the file is not a plain regular file. When there is
// no card the injected text tells the seat to write one first — the card is the seat's own words, not ours.
//
// The card rides in a system message, so the seat-state parent path is a trust boundary (JUD-B #119921): the
// operational contract for it (only the seat and its supervisor write the state tree) cannot be confirmed from the
// reader, so the reader binds the card to the seat's own directory and fails closed — a path that resolves anywhere
// else injects nothing. Partial reads keep the file position of the bytes already read (JUD-B #119906): the front is
// never repeated and the tail is never lost. The seat dir itself must be a real directory and the opened descriptor
// must name the object the approved path resolves to (JUD #120348): a substituted dir or a swapped-in file is never
// read into the card. Containment, the same-seat binding and the descriptor binding all hang on ONE resolution of
// the card path (JUD 4th HOLD): a second independent resolution could be trusted between the checks, so a path that
// cannot be resolved or stated, or that names anything but this seat's own ROLE.md, is never read. The approved seat
// dir is anchored by its own identity, captured once at the initial check (its resolution plus a dev/ino stat), and
// the card's parent is re-resolved and re-stated against that capture through the open and validation (JUD 5th HOLD):
// a later directory resolution never certifies a different directory than the one initially checked.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { debug } from '../debug/log.js';

export const SEAT_ROLE_CARD_FILE = 'ROLE.md';
/** Largest slice of the card that is injected; a longer card is cut and the seat is told where the rest is. */
export const SEAT_ROLE_CARD_MAX_CHARS = 4_000;
/** A card file bigger than this is not read at all (it is not a card). */
export const SEAT_ROLE_CARD_MAX_FILE_BYTES = 256 * 1024;

type SeatRoleCardState = 'present' | 'missing' | 'empty' | 'unreadable';

interface SeatRoleCardBlock {
  readonly state: SeatRoleCardState;
  readonly text: string;
  readonly truncated: boolean;
}

/** The only file operations the reader needs; a test swaps these to inject a read failure without relying on permissions. */
export interface SeatRoleCardIo {
  open(path: string): number;
  // dev/ino (optional so a narrow test double stays valid): the identity of the object the descriptor opened.
  stat(fd: number): { isFile(): boolean; size: number; dev?: number; ino?: number };
  /** Read `length` bytes at `position` — the reader advances the position by every byte it got. */
  read(fd: number, buffer: Buffer, length: number, position: number): number;
  close(fd: number): void;
  /** Resolve a path to the object it currently names; null when it cannot be resolved (the caller fails closed). */
  realpath?(path: string): string | null;
  /** Identity (dev+ino) of the object a resolved path names; null when it cannot be stated (fail closed). */
  statPath?(path: string): { dev: number; ino: number } | null;
  /** JUD 7th HOLD + TC #123491 ① — the directory check and the identity capture in ONE operation:
   *  the returned anchor is by construction the identity of the object that passed the check. */
  statDir?(path: string): { dev: number; ino: number; isDirectory: boolean; isSymbolicLink: boolean } | null;
  /** JUD #124088 (security HOLD) — open the anchored seat dir itself as a handle (O_DIRECTORY): the
   *  card is then opened THROUGH that handle (openat(2)-equivalent), never by a second path walk
   *  that a swapped-in path could reach. */
  openDir?(path: string): number;
  /** Open `name` relative to the directory handle `dirfd` (openat(2)-equivalent): the opened descriptor
   *  is the object the checked directory names, immune to path swaps above the handle. */
  openAt?(dirfd: number, name: string): number;
}

/** JUD #124088 (security HOLD) — openat(2) through a directory handle. No node or bun API opens
 *  relative to a dirfd, so the one libc call is made directly, following the flock precedent in
 *  src/auth/setup-link-tokens.ts. A failing open reports the C errno (read from the platform's
 *  errno location) so «missing» stays distinguishable from any other failure. r11: the errno
 *  value is memcpy'd out through the same lib — a DataView over a raw ffi pointer (r10) throws,
 *  so every real-io openat failure surfaced as «unreadable» and the honest missing card was lost. */
interface OpenatLib {
  openat(dirfd: number, name: string, flags: number, mode: number): number;
  memcpy(dest: Uint8Array, src: number, bytes: number): number;
  errnoLocation(): number;
}
let openatLibCache: OpenatLib | null | undefined;
function osOpenat(): OpenatLib | null {
  if (openatLibCache !== undefined) return openatLibCache;
  if (process.platform === 'win32') return (openatLibCache = null);
  const darwin = process.platform === 'darwin';
  const lib = dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', darwin
    ? {
        openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        memcpy: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
        __error: { args: [], returns: FFIType.ptr },
      }
    : {
        openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        memcpy: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
        __errno_location: { args: [], returns: FFIType.ptr },
      });
  openatLibCache = {
    openat: lib.symbols.openat as OpenatLib['openat'],
    memcpy: lib.symbols.memcpy as OpenatLib['memcpy'],
    errnoLocation: (darwin ? lib.symbols.__error : lib.symbols.__errno_location) as OpenatLib['errnoLocation'],
  };
  return openatLibCache;
}
const ERRNO_ENOENT = 2;

/** r11 — the 4 errno bytes through a lib memcpy into a local Uint8Array (a ptr argument): no
 *  DataView over a raw pointer, no second dereference path. Little-endian on every supported
 *  gate host (darwin arm64, linux x64/arm64). */
const readErrno = (lib: OpenatLib): number => {
  const bytes = new Uint8Array(4);
  lib.memcpy(bytes, lib.errnoLocation(), 4);
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
};

const defaultIo: SeatRoleCardIo = {
  // O_NOFOLLOW + checking the opened descriptor: a link swapped in after a check can never be followed.
  open: path => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  stat: fd => fstatSync(fd),
  // The position advances with every byte read (JUD-B #119906): a partial read resumes where the last one
  // ended — never at 0, so the front of the card is not repeated into later chunks and the tail is not lost.
  read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position),
  close: fd => closeSync(fd),
  realpath: path => { try { return realpathSync(path); } catch { return null; } },
  statPath: path => { try { const stated = statSync(path); return { dev: stated.dev, ino: stated.ino }; } catch { return null; } },
  // JUD 7th HOLD + TC #123491 ①: the directory check and the identity capture are ONE operation —
  // lstat states the object it checks, so the anchor can only be the checked object's identity.
  statDir: path => { try { const s = lstatSync(path); return { dev: s.dev, ino: s.ino, isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() }; } catch { return null; } },
  // JUD #124088 (security HOLD): the dir handle opens with O_DIRECTORY (a swapped symlink or file
  // is never taken for the dir), and the card opens THROUGH the handle — openat(2), so no second
  // path walk can reach the open. A failing openat reports the C errno (ENOENT keeps the honest
  // «missing»); any other failure stays unreadable.
  openDir: path => openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  openAt: (dirfd, name) => {
    const lib = osOpenat();
    if (lib === null) throw Object.assign(new Error('openat is unavailable on this platform'), { code: 'ENOSYS' });
    const fd = lib.openat(dirfd, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0);
    if (fd >= 0) return fd;
    const errno = readErrno(lib);
    throw Object.assign(new Error(`openat(${dirfd}, ${name}) failed (errno ${errno})`), {
      code: errno === ERRNO_ENOENT ? 'ENOENT' : undefined,
    });
  },
};

/** Author instruction shown when the seat has no card (or an empty one). Kept short and in English (model-facing). */
const seatRoleCardAuthorText = (seat: string, path: string, empty = false): string => [
  `## Role card — ${seat} has none yet`,
  empty ? `${SEAT_ROLE_CARD_FILE} at ${path} exists but is empty.` : `There is no ${SEAT_ROLE_CARD_FILE} at ${path}.`,
  'Unless a human gave you something more urgent, make your first action writing it, from the instructions and mail you',
  'have received and your own cells: mission, the metrics you are judged by, standing work, what you must never do,',
  'and who you escalate to. Keep it under one screen, in your own words. Then carry on with your work.',
].join('\n');

const seatRoleCardUnreadableText = (seat: string, path: string): string => [
  `## Role card — ${seat}: ${SEAT_ROLE_CARD_FILE} could not be read`,
  `${path} exists but is not a readable plain file (or is too large). Do not overwrite or delete it.`,
  'Tell whoever supervises you, and work from your instructions and mail until it is fixed.',
].join('\n');

/** JUD #120348 — the seat dir is the card's direct parent, so it must be a real directory: a symlink swapped in
 *  for the seat's own dir (for example another seat's directory inside the root) is a substitution, not this
 *  seat, and its card is never read. JUD 7th HOLD + TC #123491 ①: the check and the identity capture are ONE
 *  operation — the anchor is by construction the identity of the object that passed the check, never a later
 *  path resolution that could already name a swapped-in directory. */
const captureSeatDirAnchor = (io: SeatRoleCardIo, seatDir: string): { dev: number; ino: number } | null => {
  const stated = io.statDir?.(seatDir) ?? null;
  if (stated !== null) {
    if (!stated.isDirectory || stated.isSymbolicLink) return null;
    return { dev: stated.dev, ino: stated.ino };
  }
  try {
    const stat = lstatSync(seatDir); // one stat is both the check and the capture
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch { return null; }
};

/** Read the card of `seat` from its state directory. Never throws; every failure becomes a stated, non-destructive block. */
export function buildSeatRoleCardBlock(seat: string, seatDir: string, io: SeatRoleCardIo = defaultIo): SeatRoleCardBlock {
  const path = join(seatDir, SEAT_ROLE_CARD_FILE);
  const unreadable = (reason: string, code?: string): SeatRoleCardBlock => {
    debug.log('dashboard.seat-boot', 'role-card-unreadable', { seat, reason, code: code ?? null });
    return { state: 'unreadable', text: seatRoleCardUnreadableText(seat, path), truncated: false };
  };
  // JUD #120348: the seat dir itself must be a real directory — a symlink substituted for the seat's own dir
  // (another seat's directory inside the root) is never read as this seat's card. JUD 7th HOLD: the anchor is
  // captured IN the original check (one operation), so a directory swapped in after the check can only state
  // an identity that differs from the checked object and is never trusted.
  const anchor = captureSeatDirAnchor(io, seatDir);
  if (anchor === null) return unreadable('seat-dir-substituted');
  const realSeat = io.realpath?.(seatDir) ?? null;
  if (realSeat === null) return unreadable('seat-dir-unresolved');
  const seatIdentity = io.statPath?.(realSeat) ?? null;
  if (seatIdentity === null) return unreadable('seat-dir-identity-unverifiable');
  if (seatIdentity.dev !== anchor.dev || seatIdentity.ino !== anchor.ino) {
    return unreadable('seat-dir-identity-mismatch'); // the resolution no longer names the checked object
  }
  // JUD #124088 (security HOLD): the card is opened THROUGH the anchored dir handle, never by a
  // second path walk. openDir is the one walk, and its descriptor is bound to the anchor (the
  // checked identity) before anything is read; openAt then names the card relative to that
  // handle, so a path swapped in above the handle — or the seat dir swapped wholesale — cannot
  // reach the open. An io without handle ops keeps the path open (test doubles).
  let viaHandle: { dirfd: number; openAt: (dirfd: number, name: string) => number } | null = null;
  if (io.openDir !== undefined && io.openAt !== undefined) {
    try {
      const dirfd = io.openDir(realSeat);
      viaHandle = { dirfd, openAt: io.openAt };
      const handleStat = io.stat(dirfd);
      if (handleStat.dev !== anchor.dev || handleStat.ino !== anchor.ino) {
        try { io.close(dirfd); } catch { /* released: the substituted handle never reaches a read */ }
        return unreadable('dir-handle-substituted');
      }
    } catch (error) {
      if (viaHandle !== null) { try { io.close(viaHandle.dirfd); } catch { /* released: the half-open handle never reaches a read */ } }
      return unreadable('dir-handle-open-failed', (error as NodeJS.ErrnoException).code);
    }
  }
  let fd: number;
  try {
    fd = viaHandle === null ? io.open(path) : viaHandle.openAt(viaHandle.dirfd, SEAT_ROLE_CARD_FILE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (viaHandle !== null) { try { io.close(viaHandle.dirfd); } catch { /* released here: this path never reaches the read try */ } }
    if (code === 'ENOENT') {
      // TC #123491 ②: «missing» is trusted only through the anchored seat dir — the ENOENT must still be
      // observed with the checked object in place. A seat dir that swapped before the open, or that cannot
      // be re-resolved or re-stated here, is not this seat reporting a missing card: it fails closed.
      const nowSeat = io.realpath?.(seatDir) ?? null;
      const nowIdentity = nowSeat === null ? null : (io.statPath?.(nowSeat) ?? null);
      if (nowSeat === null || nowIdentity === null || nowIdentity.dev !== anchor.dev || nowIdentity.ino !== anchor.ino) {
        return unreadable('missing-through-untrusted-seat-dir', code);
      }
      return { state: 'missing', text: seatRoleCardAuthorText(seat, path), truncated: false };
    }
    return unreadable('open-failed', code); // includes ELOOP: the path is a symbolic link
  }
  try {
    const stat = io.stat(fd);
    if (!stat.isFile()) return unreadable('not-a-file');
    if (stat.size > SEAT_ROLE_CARD_MAX_FILE_BYTES) return unreadable('too-large');
    // JUD 4th HOLD: containment, the same-seat binding and the descriptor binding all hang on ONE resolution of
    // the card path — a second independent resolution could be trusted between the checks, and a broad root
    // prefix with independent observations does not bind the card to this seat. Unresolvable (io gives no
    // realpath or it returns null) fails closed before a byte is read.
    const resolved = io.realpath?.(path) ?? null;
    if (resolved === null) return unreadable('card-path-unresolved');
    // Inside the trust root is not enough (JUD 4th HOLD): the resolved path must be exactly this seat's own ROLE.md.
    if (resolved !== join(realSeat, SEAT_ROLE_CARD_FILE)) return unreadable('card-path-not-own-card');
    // JUD 5th HOLD: the card's parent is the approved seat dir — re-resolve it and re-state it at validation and
    // hold both to the capture above. A parent that cannot be resolved, or that resolves or states as anything
    // but the approved seat dir, is a substitution: nothing is read through it.
    const cardParent = dirname(resolved);
    const parentReal = io.realpath?.(cardParent) ?? null;
    if (parentReal === null) return unreadable('card-parent-unresolved');
    if (parentReal !== realSeat) return unreadable('card-parent-not-seat-dir');
    const parentIdentity = io.statPath?.(parentReal) ?? null;
    if (parentIdentity === null) return unreadable('card-parent-identity-unverifiable');
    if (parentIdentity.dev !== anchor.dev || parentIdentity.ino !== anchor.ino) {
      return unreadable('seat-dir-identity-mismatch');
    }
    // JUD #120348 + 4th HOLD: the descriptor that was opened must name the object the resolved path names — a
    // swapped-in substitute never reaches the injected text, and a path identity that cannot be stated
    // (statPath missing or returning null) is an unverifiable binding: nothing is read through it.
    const pathIdentity = io.statPath?.(resolved) ?? null;
    if (pathIdentity === null) return unreadable('path-identity-unverifiable');
    if (stat.dev !== pathIdentity.dev || stat.ino !== pathIdentity.ino) {
      return unreadable('descriptor-substitution');
    }
    const buffer = Buffer.alloc(Math.min(stat.size, SEAT_ROLE_CARD_MAX_FILE_BYTES));
    let filled = 0;
    while (filled < buffer.length) {
      // JUD-B #119906: the position advances with the bytes already read, so a short read resumes at its own end.
      const got = io.read(fd, buffer.subarray(filled), buffer.length - filled, filled);
      if (got <= 0) break;
      filled += got;
    }
    const trimmed = buffer.subarray(0, filled).toString('utf8').trim();
    if (!trimmed) return { state: 'empty', text: seatRoleCardAuthorText(seat, path, true), truncated: false };
    const truncated = trimmed.length > SEAT_ROLE_CARD_MAX_CHARS;
    const shown = truncated ? trimmed.slice(0, SEAT_ROLE_CARD_MAX_CHARS) : trimmed;
    return {
      state: 'present',
      truncated,
      text: [
        `## Role card — ${seat} (from ${SEAT_ROLE_CARD_FILE}, read at session start)`,
        shown,
        ...(truncated ? [`(card cut at ${SEAT_ROLE_CARD_MAX_CHARS} characters; read ${path} for the rest)`] : []),
      ].join('\n'),
    };
  } catch (error) {
    return unreadable('read-failed', (error as NodeJS.ErrnoException).code);
  } finally {
    try { io.close(fd); } catch { /* nothing to release */ }
    if (viaHandle !== null) { try { io.close(viaHandle.dirfd); } catch { /* nothing to release */ } }
  }
}
