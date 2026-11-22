import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bounded incremental OSC parser. Other OSC strings are consumed, never interpreted as nested reports. */
export function osc7CwdParser(report: (cwd: string) => void): (chunk: string) => void {
  let state: 'text' | 'escape' | 'osc' | 'osc-escape' | 'discard' | 'discard-escape' = 'text';
  let payload = '';
  // BEL terminates OSC, but not DCS/SOS/PM/APC control strings.
  let discardOsc = false;
  const local = hostname().toLowerCase();
  const finish = () => {
    if (!payload.startsWith('7;')) return;
    try {
      const raw = payload.slice(2);
      // URL normalisation must not turn a relative URI, credentials, query or fragment into a local path.
      if (!raw.startsWith('file://') || /[?#\x00-\x1f\x7f-\x9f]/.test(raw)) return;
      const url = new URL(raw);
      if (url.protocol !== 'file:' || url.username || url.password || url.port || url.search || url.hash) return;
      if (url.hostname && url.hostname.toLowerCase() !== local && url.hostname.toLowerCase() !== 'localhost') return;
      // fileURLToPath rejects non-local hosts, so strip the validated hostname first.
      url.hostname = '';
      const path = fileURLToPath(url);
      if (isAbsolute(path) && !/[\x00-\x1f\x7f-\x9f]/.test(path)) report(path);
    } catch { /* malformed URI or percent encoding */ }
  };
  return (chunk) => {
    // In text state CAN/SUB are no-ops; only control-string introducers need parsing.
    // Never skip a chunk while a sequence is in progress, even if it looks like text.
    if (state === 'text' && !/[\x1b\x90\x98\x9d\x9e\x9f]/.test(chunk)) return;
    for (const ch of chunk) {
      // CAN and SUB abort any in-progress control sequence, including discarded strings.
      if (ch === '\x18' || ch === '\x1a') { payload = ''; state = 'text'; continue; }
      switch (state) {
        case 'text': if (ch === '\x1b') state = 'escape'; else if (ch === '\x90' || ch === '\x98' || ch === '\x9e' || ch === '\x9f') { discardOsc = false; state = 'discard'; } else if (ch === '\x9d') { payload = ''; state = 'osc'; } break;
        case 'escape': state = ch === ']' ? 'osc' : ch === 'P' || ch === 'X' || ch === '^' || ch === '_' ? 'discard' : ch === '\x1b' ? 'escape' : 'text'; discardOsc = false; payload = ''; break;
        case 'osc':
          if (ch === '\x07' || ch === '\x9c') { finish(); state = 'text'; }
          else if (ch === '\x1b') state = 'osc-escape';
          else if (payload.length >= 8192) { payload = ''; discardOsc = true; state = 'discard'; }
          else payload += ch;
          break;
        case 'osc-escape':
          if (ch === '\\') { finish(); state = 'text'; }
          else { payload = ''; discardOsc = true; state = ch === '\x07' || ch === '\x9c' ? 'text' : 'discard'; }
          break;
        case 'discard': if (ch === '\x9c' || (discardOsc && ch === '\x07')) state = 'text'; else if (ch === '\x1b') state = 'discard-escape'; break;
        case 'discard-escape': state = ch === '\\' || ch === '\x9c' || (discardOsc && ch === '\x07') ? 'text' : ch === '\x1b' ? 'discard-escape' : 'discard'; break;
      }
    }
  };
}
