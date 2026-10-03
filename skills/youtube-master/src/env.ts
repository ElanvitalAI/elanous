import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = resolve(__dirname, '..');

export function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf-8');
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

export function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`필수 환경변수 누락: ${key}`);
  return val;
}

export function env(key: string, fallback = ''): string {
  return process.env[key] || fallback;
}

/** Load the single .env from skill root */
export function initEnv(): void {
  loadEnvFile(resolve(SKILL_DIR, '.env'));
}
