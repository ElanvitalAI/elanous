import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { validateMsgMirrorState, type MsgMirrorState, type MsgMirrorStateStore } from './msg-mirror-runner.js';

export function defaultMsgMirrorStatePath(): string {
  return join(elanousStateRoot(), 'msg', 'github-mirror-state.json');
}

/** One durable rotation pointer and progress cursor, stored atomically in the active state universe. */
export class JsonMsgMirrorStateStore implements MsgMirrorStateStore {
  constructor(readonly path: string = defaultMsgMirrorStatePath()) {}

  read(): MsgMirrorState | null {
    if (!existsSync(this.path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    return validateMsgMirrorState(parsed);
  }

  write(state: MsgMirrorState): void {
    const normalized = validateMsgMirrorState(state);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temp, this.path);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* preserve the original write error */ }
      throw error;
    }
  }
}
