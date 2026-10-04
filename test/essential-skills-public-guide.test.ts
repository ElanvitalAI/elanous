import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LEAK_MARKERS, scanLeaks } from '../scripts/public-export.js';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const guidePath = 'release/public/docs/essential-skills.md';
const guide = read(guidePath);
const plugins = read('release/public/docs/plugins.md');
const pages = JSON.parse(read('website/pages.json')) as {
  pages: Array<{ id: string; source?: string; since?: string; read_when?: string[] }>;
};
// Match the five real bundle entries checked by essential-skill-pack.test.ts.
const bundle = JSON.parse(read('packs/elanous-essentials/plugin.json')) as {
  extensions: { 'ai.elanous': { bundle: string[] } };
};
const skillNames = bundle.extensions['ai.elanous'].bundle.map(path => path.split('/').at(-1)!);
const notice = 'The pack is listed but not published to the marketplace yet — the install lines work once it is published.';

describe('essential skills public guide', () => {
  test('the first reader-facing line states the unpublished status and the guide describes every bundled skill', () => {
    expect(guide.split('\n')[0]).toBe(notice);
    expect(skillNames).toEqual(['youtube-master', 'omni-crawl', 'omni-digest', 'diagram-master', 'lecture-note-digitizer']);
    for (const skill of skillNames) {
      expect(guide).toContain('`' + skill + '`');
      expect(guide).toMatch(new RegExp('^\\| `' + skill + '` \\|[^\\n]+\\|[^\\n]+\\|[^\\n]+\\|$', 'm'));
      const rows = guide.split('\n').filter(line => line.startsWith('| `' + skill + '` |'));
      expect(rows.length).toBeGreaterThanOrEqual(3); // description, key paths, and at least one tool
      expect(rows[1]).toMatch(/\|[^|]+\|[^|]+\|$/); // distinct key-free and own-key cells
    }
    expect(guide).toContain('No API key: available path');
    expect(guide).toContain('Bring your own key: additional path');
    expect(guide).toContain('each provider\'s pricing page');
    expect(guide).toContain('Which tools do I need on my machine?');
    for (const tool of ['npx tsx', 'yt-dlp', 'ffmpeg', 'pdftotext', 'whisper', 'uv', 'Playwright Chromium']) expect(guide).toContain(tool);
    for (const key of ['YOUTUBE_API_KEY', 'SUPADATA_API_KEY', 'XAI_API_KEY', 'TAVILY_KEY', 'FIRECRAWL_API_KEY', 'GEMINI_API_KEY', 'UPSTAGE_API_KEY']) expect(guide).toContain('`' + key + '`');
  });

  test('installation instructions are future-tense and cover local agents and the sandboxed app', () => {
    expect(guide).toContain('elanous plugin add elanous-essentials@elanous');
    expect(guide).toContain('codex plugin marketplace add ElanvitalAI/elanous-plugins');
    expect(guide).toContain('codex plugin add elanous-essentials@elanous');
    expect(guide).toContain('**Not yet:**');
    for (const agent of ['Claude Code', 'Codex CLI', 'Claude desktop or web app']) expect(guide).toContain(agent);
    expect(guide).toContain('sandbox');
    expect(guide).toContain('local tools');
  });

  test('the public page contains no private paths, internal names, Korean or numerical free limits', () => {
    expect(guide).not.toMatch(/[\uac00-\ud7a3\u3131-\u318e\u1100-\u11ff]/);
    expect(guide).not.toMatch(/\/Users\/|elanous-agent|monad|~\/\.elanous/i);
    expect(guide).not.toMatch(/(?:free (?:tier|allowance|limit|quota)[^\n.]*?\d|\d+\s*(?:free (?:calls|credits|requests)|(?:calls|credits|requests)\s*(?:per|\/)))/i);
    expect(scanLeaks(root, [guidePath], LEAK_MARKERS)).toEqual([]);
  });

  test('the official pack table has exactly one unpublished row linked to the guide', () => {
    const rows = plugins.split('\n').filter(line => /^\|.*elanous-essentials.*\|/.test(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('[`elanous-essentials`](essential-skills.md)');
    for (const skill of skillNames) expect(rows[0]).toContain('`' + skill + '`');
    expect(rows[0]).toMatch(/\| Listed only — not published yet \|$/);
    expect(rows[0]).toContain('[read the guide](essential-skills.md)');
  });

  // The guide ships in the version named by its `since`. Until that version is cut the note line must be in
  // release/next.md; once a later dev version starts, the line has already gone out with that release.
  const baseVersion = (JSON.parse(read('package.json')) as { version: string }).version.replace(/-dev\..*$/, '');
  const guideSince = (): string => pages.pages.find(page => page.source === guidePath)?.since ?? '';
  const versionKey = (v: string) => v.split('.').map(n => n.padStart(4, '0')).join('.');

  test('the release note line is in release/next.md until the guide\'s version is released', () => {
    if (guideSince() === baseVersion) {
      expect(read('release/next.md')).toContain('- New guide page for the five essential skills');
      expect(read('release/next.md')).toMatch(/^## Internal$/m);
    } else {
      expect(versionKey(guideSince()) < versionKey(baseVersion)).toBe(true);
    }
  });

  test('the site has exactly one guide source under using-elanous, introduced in a released or the next version', () => {
    const entries = pages.pages.filter(page => page.source === guidePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('using-elanous/essential-skills');
    expect(entries[0].read_when).toHaveLength(1);
    expect(entries[0].read_when?.[0]).toMatch(/essential skills/);
    expect(entries[0].since).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionKey(entries[0].since!) <= versionKey(baseVersion)).toBe(true);
  });
});
