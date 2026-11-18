// els wire — one JSON object per line over the Unix socket. Bytes are decoded as a stream, so a multi-byte UTF-8
// character split across two socket chunks is joined, never replaced.

import { StringDecoder } from 'node:string_decoder';

/** Feed raw socket chunks; `onLine` gets each complete line (without the newline). */
export function createLineDecoder(onLine: (line: string) => void): { push: (chunk: Buffer | string) => void; pending: () => number } {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        onLine(line);
      }
    },
    /** Characters received after the last newline (a request still arriving). */
    pending: () => buffer.length,
  };
}
