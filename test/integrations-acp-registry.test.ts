import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dir, '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const entry = JSON.parse(readFileSync(resolve(root, 'integrations/acp-registry/elanous/agent.json'), 'utf8'));
const icon = readFileSync(resolve(root, 'integrations/acp-registry/elanous/icon.svg'), 'utf8');
const v6Mark = readFileSync(resolve(root, 'docs/brand/icon/elanous-mark-mono.svg'), 'utf8');

async function monochromePixels(svg: string): Promise<Uint8Array> {
  return new Uint8Array(await sharp(Buffer.from(svg.replaceAll('currentColor', '#000000')))
    .resize(32, 32)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer());
}

describe('ACP registry submission', () => {
  test('agent entry meets the registry fields and matches the npm release', () => {
    for (const field of ['id', 'name', 'version', 'description', 'license_url', 'distribution']) {
      expect(entry).toHaveProperty(field);
      expect(entry[field]).toBeTruthy();
    }
    expect(entry.id).toBe('elanous');
    expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(entry.name).toBe('Elanous');
    expect(entry.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    expect(entry.version).toBe(packageJson.version);
    expect(entry.description).toMatch(/^[A-Z][^.!?]+[.!?]$/);
    expect(entry.repository).toBe('https://github.com/ElanvitalAI/elanous');
    expect(entry.authors).toEqual(['Elanvital AI']);
    expect(entry.license).toBe('Apache-2.0');
    expect(entry.license_url).toBe('https://github.com/ElanvitalAI/elanous/blob/main/LICENSE');
    expect(entry.distribution.npx.package).toBe(`elanous@${packageJson.version}`);
    expect(entry.distribution.npx.args).toContain('--acp-server');
  });

  test('16px monochrome icon follows the registry color rule and V6 silhouette', async () => {
    expect(icon).toMatch(/<svg\b[^>]*\bwidth="16"/);
    expect(icon).toMatch(/<svg\b[^>]*\bheight="16"/);
    expect(icon).toMatch(/<svg\b[^>]*\bviewBox="0 0 16 16"/);
    expect(icon.match(/<path\b/g)).toHaveLength(3);
    expect(icon.match(/<circle\b/g)).toHaveLength(1);
    const colors = [...icon.matchAll(/\b(?:fill|stroke)\s*=\s*(["'])(.*?)\1/g)].map((match) => match[2]);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) expect(['currentColor', 'none']).toContain(color);
    expect(icon).not.toMatch(/#[\da-fA-F]{3,8}\b|\bstyle\s*=/);

    // Compare the actual rendered three-blade geometry and center dot to the V6 mono master,
    // rather than accepting any SVG with three paths and a circle. Allow 16px simplification.
    const reference = await monochromePixels(v6Mark);
    const submission = await monochromePixels(icon);
    let sharedInk = 0;
    let combinedInk = 0;
    for (let i = 0; i < reference.length; i++) {
      sharedInk += Math.min(255 - reference[i], 255 - submission[i]);
      combinedInk += Math.max(255 - reference[i], 255 - submission[i]);
    }
    expect(sharedInk / combinedInk).toBeGreaterThan(0.7);
  });
});
