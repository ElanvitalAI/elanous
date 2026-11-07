// Pure ULID generation shared by identity, trace, and URI modules.
import { randomBytes } from 'crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** ULID encoder — pure function, no I/O. Exported so PR #3 URI builder can
 *  share the Crockford table without duplicating. */
export function newUlid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

function encodeTime(ms: number, len: number): string {
  let n = ms;
  const out: string[] = new Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = CROCKFORD[n % 32]!;
    n = Math.floor(n / 32);
  }
  return out.join('');
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(Math.ceil((len * 5) / 8));
  const out: string[] = [];
  let bitBuf = 0;
  let bitCnt = 0;
  let idx = 0;
  while (out.length < len) {
    if (bitCnt < 5) {
      bitBuf = (bitBuf << 8) | (bytes[idx++] ?? 0);
      bitCnt += 8;
    }
    out.push(CROCKFORD[(bitBuf >> (bitCnt - 5)) & 0x1f]!);
    bitCnt -= 5;
  }
  return out.join('');
}
