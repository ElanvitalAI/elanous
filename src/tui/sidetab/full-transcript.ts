import { redactSecretText } from '../../debug/secret-redaction.js';

const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const ANSI_CONTROL = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[PX^_].*?\x1b\\|.)/gs;
const NON_TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Raw PTY output from spawn, with an explicit completeness boundary. */
export function createFullTranscriptCapture(maxBytes = MAX_TRANSCRIPT_BYTES) {
  let raw = '';
  let bytes = 0;
  let complete = true;
  return {
    append(chunk: string): void {
      const size = Buffer.byteLength(chunk, 'utf8');
      bytes += size;
      if (!complete) return;
      if (Buffer.byteLength(raw, 'utf8') + size > maxBytes) {
        raw = '';
        complete = false;
        return;
      }
      raw += chunk;
    },
    bytes: () => bytes,
    transcript(): string | undefined {
      if (!complete) return undefined;
      return redactSecretText(raw.replace(ANSI_CONTROL, '').replace(NON_TEXT_CONTROL, '').replace(/\r\n?/g, '\n'));
    },
  };
}
