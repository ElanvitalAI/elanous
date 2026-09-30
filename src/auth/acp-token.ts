import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateAuthToken } from '../acp/transport/index.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';

/** Load the persistent ACP bearer token, creating it on first boot. */
export function ensureAuthToken(configDir: string = getElanousConfigDir()): { token: string; path: string } {
  const path = join(configDir, 'acp-token');
  mkdirSync(configDir, { recursive: true });
  if (existsSync(path)) {
    return { token: readFileSync(path, 'utf-8').trim(), path };
  }
  const token = generateAuthToken();
  writeFileSync(path, token, { mode: 0o600 });
  return { token, path };
}
