import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadPluginManifestFromDir } from '../core/manifest.js';
import type { PluginDraft } from './plugin-maker.js';

export interface MakeSkillOptions {
  dir: string;
  gap: PluginDraft['skills'][number];
  id: string;
}

/** Write one researched skill as the wizard's SKILL.md draft, without altering the plugin manifest. */
export function makeSkill({ dir: inputDir, gap, id }: MakeSkillOptions): string {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id) || !gap || !gap.name.trim() || gap.name === '미확인'
    || !gap.use.trim() || !Array.isArray(gap.evidence) || !gap.evidence.every(source => typeof source === 'string')) {
    throw new Error('invalid skill gap or id');
  }
  const dir = resolve(inputDir);
  const manifestPath = join(dir, 'plugin.json');
  const manifestEntry = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestEntry?.isFile() || manifestEntry.isSymbolicLink()) {
    throw new Error('plugin.json missing or unsafe');
  }
  loadPluginManifestFromDir(dir, { id: 'local-plugin' });
  const skillsDir = join(dir, 'skills');
  const skillDir = join(skillsDir, id);
  const path = join(skillDir, 'SKILL.md');
  // An ancestor can be a platform alias (macOS /var -> /private/var); the plugin directory itself cannot be a link.
  if (lstatSync(dir).isSymbolicLink()
    || realpathSync(dir) !== join(realpathSync(dirname(dir)), basename(dir))) {
    throw new Error('unsafe plugin directory');
  }
  const skillsEntry = lstatSync(skillsDir, { throwIfNoEntry: false });
  if (skillsEntry && !skillsEntry.isDirectory()) throw new Error('unsafe skills directory');
  if (lstatSync(skillDir, { throwIfNoEntry: false })) throw new Error(`skill already exists: ${id}`);
  const instructions = gap.use + (gap.evidence.length ? `\n\nResearch sources:\n${gap.evidence.join(', ')}` : '');
  const content = `---\n${stringifyYaml({ name: id, description: gap.use, requires: [] })}---\n\n${instructions}\n`;
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path, content, { flag: 'wx' });
  return path;
}
