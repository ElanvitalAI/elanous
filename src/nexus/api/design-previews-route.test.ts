// GET /v1/design-previews — list and serve HTML under design/previews only.
//
// A symlink that leaves that directory must 404 without returning the target's
// bytes. The repository is harness.defaultRepo, same as design-check.

import { describe, expect, test, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setUserConfigOverlay } from '../../user-config';
import { handleDesignPreviews, PREVIEW_MAX_BYTES } from './design-previews-route';
import { DESIGN_PREVIEWS_PATH } from './rest-route-paths';

const roots: string[] = [];

afterEach(() => {
  setUserConfigOverlay(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitRepo(): { root: string; previews: string } {
  const root = mkdtempSync(join(tmpdir(), 'design-previews-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  const previews = join(root, 'design', 'previews');
  mkdirSync(previews, { recursive: true });
  setUserConfigOverlay((config) => ({ ...config, harness: { ...config.harness, defaultRepo: root } }));
  return { root, previews };
}

describe('GET /v1/design-previews', () => {
  test('lists only matching html files with size and mtime', async () => {
    const { previews } = gitRepo();
    writeFileSync(join(previews, 'paper.html'), '<p>paper</p>');
    writeFileSync(join(previews, 'minimal.html'), '<p>minimal</p>');
    writeFileSync(join(previews, 'README.txt'), 'nope');
    writeFileSync(join(previews, 'Bad_Name.html'), 'nope');
    const res = handleDesignPreviews(DESIGN_PREVIEWS_PATH);
    expect(res.status).toBe(200);
    const body = await res.json() as { repoSource: string; previews: Array<{ system: string; bytes: number; modifiedAt: string }> };
    expect(body.repoSource).toBe('config');
    expect(body.previews.map((p) => p.system)).toEqual(['minimal', 'paper']);
    expect(body.previews.every((p) => p.bytes > 0 && !Number.isNaN(Date.parse(p.modifiedAt)))).toBe(true);
  });

  test('missing previews directory is an empty list', async () => {
    const { previews } = gitRepo();
    rmSync(previews, { recursive: true, force: true });
    const res = handleDesignPreviews(DESIGN_PREVIEWS_PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ previews: [], repoSource: 'config' });
  });

  test('serves the html body for a known system', async () => {
    const { previews } = gitRepo();
    writeFileSync(join(previews, 'paper.html'), '<h1>Paper</h1>');
    const res = handleDesignPreviews(`${DESIGN_PREVIEWS_PATH}/paper`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ system: 'paper', html: '<h1>Paper</h1>' });
  });

  test('a bad system name is 400', async () => {
    gitRepo();
    const bad = handleDesignPreviews(`${DESIGN_PREVIEWS_PATH}/Paper`);
    expect(bad.status).toBe(400);
    const dotted = handleDesignPreviews(`${DESIGN_PREVIEWS_PATH}/../secret`);
    expect(dotted.status).toBe(400);
    const body = await dotted.json() as { html?: string };
    expect(body.html).toBeUndefined();
  });

  test('a missing file is 404', async () => {
    gitRepo();
    const res = handleDesignPreviews(`${DESIGN_PREVIEWS_PATH}/paper`);
    expect(res.status).toBe(404);
    const body = await res.json() as { html?: string };
    expect(body.html).toBeUndefined();
  });

  test('a symlink that leaves design/previews is 404 and does not return the target', async () => {
    const { root, previews } = gitRepo();
    const outside = join(root, 'SECRET.html');
    const secret = 'SECRET-OUTSIDE-PREVIEWS';
    writeFileSync(outside, secret);
    symlinkSync(outside, join(previews, 'paper.html'));
    const res = handleDesignPreviews(`${DESIGN_PREVIEWS_PATH}/paper`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(secret);
  });

  test('the list leaves out a symlink that escapes design/previews — serving refuses it, so listing must too', async () => {
    const { root, previews } = gitRepo();
    writeFileSync(join(root, 'SECRET.html'), 'x'.repeat(4321));
    symlinkSync(join(root, 'SECRET.html'), join(previews, 'escape.html'));
    writeFileSync(join(previews, 'paper.html'), '<p>paper</p>');
    writeFileSync(join(previews, 'inner.html'), '<p>inner</p>');
    symlinkSync(join(previews, 'inner.html'), join(previews, 'alias.html'));
    const body = await handleDesignPreviews(DESIGN_PREVIEWS_PATH).json() as { previews: Array<{ system: string; bytes: number }> };
    expect(body.previews.map((p) => p.system)).toEqual(['alias', 'inner', 'paper']);
    expect(body.previews.some((p) => p.bytes === 4321)).toBe(false);
  });

  test('a document over 512KB is 413', async () => {
    const { previews } = gitRepo();
    writeFileSync(join(previews, 'paper.html'), 'x'.repeat(PREVIEW_MAX_BYTES + 1));
    const res = handleDesignPreviews(`${DESIGN_PREVIEWS_PATH}/paper`);
    expect(res.status).toBe(413);
  });
});
