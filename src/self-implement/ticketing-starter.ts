import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TICKETING_STARTER_VERSION = 'ticketing-bun-sqlite@0.1.0';

const templateRoot = fileURLToPath(new URL('../../templates/ticketing-starter/', import.meta.url));
const files = [
  'package.json', 'config.json', 'backend/db.ts', 'backend/server.ts',
  'frontend/index.html', 'frontend/app.js', 'frontend/styles.css',
  'test/seat.test.ts', 'test/http.test.ts', 'README.md',
] as const;

export interface TicketingStarterInput {
  target: string;
  eventTitle?: string;
  eventDate?: string;
  venue?: string;
  seatCount?: number;
}

export interface TicketingStarterReceipt {
  starterVersion: typeof TICKETING_STARTER_VERSION;
  target: string;
  files: Record<string, string>;
  publicDeployment: false;
}

function assertInside(path: string, root: string): void {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('starter path escapes target');
}

export function createTicketingStarter(input: TicketingStarterInput): TicketingStarterReceipt {
  if (!isAbsolute(input.target)) throw new Error('starter target must be absolute');
  if (input.seatCount !== undefined && (!Number.isInteger(input.seatCount) || input.seatCount < 1 || input.seatCount > 480))
    throw new Error('seatCount must be an integer from 1 through 480');
  const normalized = resolve(input.target);
  const parent = realpathSync(dirname(normalized));
  const target = join(parent, basename(normalized));
  const config = {
    eventTitle: input.eventTitle?.trim() || '샘플 공연',
    eventDate: input.eventDate?.trim() || '미정',
    venue: input.venue?.trim() || '미정',
    seatCount: input.seatCount ?? 24,
    sampleFields: [
      ...(!input.eventTitle?.trim() ? ['공연명'] : []),
      ...(!input.eventDate?.trim() ? ['공연일'] : []),
      ...(!input.venue?.trim() ? ['장소'] : []),
      ...(input.seatCount === undefined ? ['좌석 수'] : []),
    ],
  };
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && (value.length > 120 || /[\x00-\x1f]/u.test(value)))
      throw new Error('invalid starter config: ' + key);
  }
  for (const rel of files) {
    const source = join(templateRoot, rel);
    if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error('unsafe starter template: ' + rel);
  }
  mkdirSync(target);
  const digests: Record<string, string> = {};
  for (const rel of files) {
    const source = join(templateRoot, rel);
    const destination = join(target, rel);
    assertInside(destination, target);
    mkdirSync(dirname(destination), { recursive: true });
    const bytes = rel === 'config.json'
      ? Buffer.from(JSON.stringify(config, null, 2) + '\n')
      : readFileSync(source);
    writeFileSync(destination, bytes, { flag: 'wx' });
    digests[rel] = createHash('sha256').update(bytes).digest('hex');
  }
  const receipt: TicketingStarterReceipt = { starterVersion: TICKETING_STARTER_VERSION,
    target, files: digests, publicDeployment: false };
  mkdirSync(join(target, '.elanous'));
  writeFileSync(join(target, '.elanous', 'ticketing-starter.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}
