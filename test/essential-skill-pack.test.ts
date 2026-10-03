import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { loadPluginManifestFromDir, parsePluginManifest } from '../src/plugins/core/manifest.js';
import { LEAK_MARKERS, scanLeaks } from '../scripts/public-export.js';

const root = resolve(import.meta.dir, '..');
const manifestPath = resolve(root, 'packs/elanous-essentials/plugin.json');
const skills = [
  'skills/youtube-master',
  'skills/omni-crawl',
  'skills/omni-digest',
  'skills/diagram-master',
  'skills/lecture-note-digitizer',
];
const newSkills = skills.filter(path => !['skills/omni-crawl', 'skills/omni-digest'].includes(path));

function allFilesAndForbiddenEntries(dir: string): { files: string[]; forbidden: string[] } {
  const files: string[] = [];
  const forbidden: string[] = [];
  function walk(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      if (entry.name.startsWith('.env') || entry.name === 'node_modules' || entry.name === '.venv'
        || entry.name === '.elanous' || entry.name === 'data' || entry.name === '.DS_Store'
        || entry.name === '__pycache__' || entry.name === '.pytest_cache' || entry.name === '.cache') {
        forbidden.push(relative(root, full));
      }
      if (entry.isSymbolicLink()) { forbidden.push(relative(root, full)); continue; }
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(root, full));
    }
  }
  walk(dir);
  return { files, forbidden };
}

describe('elanous-essentials public skill bundle', () => {
  test('manifest parser accepts metadata and five real skill paths', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const parsed = parsePluginManifest(raw);
    const loaded = loadPluginManifestFromDir(resolve(root, 'packs/elanous-essentials'), { id: 'elanous-essentials' });
    expect(loaded.inferred).toBe(false);
    expect(loaded.path).toBe(manifestPath);
    expect(loaded.manifest).toEqual(parsed);
    expect(parsed.id).toBe('elanous-essentials');
    expect(parsed.version).toBe('0.1.0');
    expect(raw.extensions['ai.elanous'].pricing.model).toBe('free');
    expect(raw.extensions['ai.elanous'].bundle).toEqual(skills);
    for (const path of skills) expect(existsSync(resolve(root, path, 'SKILL.md'))).toBe(true);
    const connectors = raw.extensions['ai.elanous'].connectors;
    expect(connectors.map((connector: { userConfig: Array<{ key: string }> }) => connector.userConfig.map(field => field.key)).flat()).toEqual([
      'YOUTUBE_API_KEY', 'SUPADATA_API_KEY', 'XAI_API_KEY', 'TAVILY_KEY',
      'FIRECRAWL_API_KEY', 'GEMINI_API_KEY', 'UPSTAGE_API_KEY',
    ]);
    for (const connector of connectors) {
      expect(Object.keys(connector).sort()).toEqual(['id', 'kind', 'userConfig']);
      expect(connector.kind).toBe('api-key');
      for (const field of connector.userConfig) {
        expect(field.key).toMatch(/^[A-Z][A-Z0-9_]+$/);
        expect(field.env).toBe(field.key);
        expect(field.secret).toBe(true);
        expect(Object.keys(field).sort()).toEqual(['env', 'key', 'label', 'secret']);
      }
    }
    expect(parsed.contributes.connectors).toHaveLength(connectors.length);
    expect(JSON.stringify(raw)).not.toMatch(/\/Users\/|\/home\/|~\/|\.env|password|token/i);
  });

  test('all bundled folders have no leak-marker hits, credential files, or dependency caches', () => {
    const allFiles: string[] = [];
    for (const dir of skills) {
      const { files, forbidden } = allFilesAndForbiddenEntries(resolve(root, dir));
      expect(forbidden).toEqual([]);
      allFiles.push(...files);
    }
    expect(scanLeaks(root, allFiles, LEAK_MARKERS)).toEqual([]);
    expect(scanLeaks(root, ['packs/elanous-essentials/plugin.json'], LEAK_MARKERS)).toEqual([]);
  });

  test('the free and bring-your-own-key paths are present in all five skills', () => {
    for (const dir of skills) {
      const markdown = readFileSync(resolve(root, dir, 'SKILL.md'), 'utf8');
      expect(markdown).toMatch(/^## 무료로 쓰는 길 \(키 없이\)$/m);
      expect(markdown).toMatch(/^## 내 키로 쓰는 길$/m);
    }
  });

  test('new skill copies are portable and every lecture diagram reference exists', () => {
    for (const dir of newSkills) {
      const { files } = allFilesAndForbiddenEntries(resolve(root, dir));
      for (const file of files) {
        const full = resolve(root, file);
        if (!/\.(?:md|ts|js|py|json|toml|html|sh|yaml|yml)$/.test(file)) continue;
        const text = readFileSync(full, 'utf8');
        expect(text).not.toMatch(/\/Users\/[^/]+\/|\/home\/[^/]+\/|~\/\.claude\/skills\//);
      }
    }
    expect(existsSync(resolve(root, 'skills/diagram-master/references/uv.lock'))).toBe(true);
    const lectureRoot = resolve(root, 'skills/lecture-note-digitizer');
    const { files } = allFilesAndForbiddenEntries(lectureRoot);
    const referenced = files.flatMap(file => {
      if (!file.endsWith('.md')) return [];
      const text = readFileSync(resolve(root, file), 'utf8');
      return [...text.matchAll(/(?:\.\.\/)*diagram-master\/references(?:\/[\w.-]+)*/g)].map(match => match[0]);
    });
    expect(referenced.length).toBeGreaterThan(0);
    for (const path of referenced) {
      expect(path.startsWith('../diagram-master/references')).toBe(true);
      const target = resolve(lectureRoot, path);
      const referencesRoot = resolve(root, 'skills/diagram-master/references');
      expect(target === referencesRoot || target.startsWith(referencesRoot + sep)).toBe(true);
      expect(existsSync(target)).toBe(true);
      if (target !== referencesRoot) expect(lstatSync(target).isFile()).toBe(true);
    }
  });
});
