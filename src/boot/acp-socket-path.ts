import { join as joinPath } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';

/** Default socket path — XDG-ish; `~/.elanous/elanous.sock`. */
export function defaultUnixSocketPath(): string {
  return joinPath(getElanousConfigDir(), 'elanous.sock');
}
