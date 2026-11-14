import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTicketingStarter, TICKETING_STARTER_VERSION } from '../src/self-implement/ticketing-starter.js';
import { validateKnowledgePack } from '../src/knowledge/write.js';

test('new starter runs its own seat and same-origin HTTP contracts without package install', () => {
  const root = mkdtempSync(join(tmpdir(), 'one-line-ticketing-'));
  const target = join(root, 'ticketing-app');
  try {
    const receipt = createTicketingStarter({ target, eventTitle: 'Seoul Concert', seatCount: 4 });
    expect(receipt.starterVersion).toBe(TICKETING_STARTER_VERSION);
    expect(receipt.publicDeployment).toBe(false);
    expect(Object.keys(receipt.files)).toHaveLength(10);
    expect(JSON.parse(readFileSync(join(target, 'config.json'), 'utf8'))).toMatchObject({
      eventTitle: 'Seoul Concert', eventDate: '미정', venue: '미정', seatCount: 4,
      sampleFields: ['공연일', '장소'],
    });
    for (const [relativePath, digest] of Object.entries(receipt.files)) {
      expect(createHash('sha256').update(readFileSync(join(target, relativePath))).digest('hex')).toBe(digest);
    }
    const run = Bun.spawnSync([process.execPath, 'test', 'test'], { cwd: target, stdout: 'pipe', stderr: 'pipe' });
    expect(new TextDecoder().decode(run.stderr)).toContain('6 pass');
    expect(run.exitCode).toBe(0);
    expect(() => createTicketingStarter({ target })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid config cannot create a target; pack contains the short starter contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'one-line-ticketing-invalid-'));
  const target = join(root, 'invalid');
  try {
    expect(() => createTicketingStarter({ target, seatCount: 0 })).toThrow();
    expect(existsSync(target)).toBe(false);
    const { pack } = validateKnowledgePack(join(import.meta.dir, '../packs/ticketing-app-starter-public'));
    expect(pack.cards).toHaveLength(1);
    expect(pack.cards[0]?.body).toContain('ticketing-bun-sqlite@0.1.0');
    expect(pack.cards[0]?.body).toContain('연결 필요');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
