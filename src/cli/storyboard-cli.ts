import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { debug } from '../debug/log.js';
import { files, lint, render, STORYBOARD_ROOT, type Storyboard } from '../storyboard/storyboard.js';

export function runStoryboard(cmd: 'lint' | 'render', args: string[], json = false): number {
  const reports: Array<{ file: string; errors: string[]; warnings: string[] }> = [];
  let errorCount = 0, warningCount = 0;
  for (const f of files(args)) {
    const file = relative(STORYBOARD_ROOT, f);
    let sb: Storyboard | undefined;
    let errors: string[], warnings: string[];
    try {
      sb = parse(readFileSync(f, 'utf8')) as Storyboard;
      ({ errors, warnings } = lint(sb, file));
    } catch (cause) {
      errors = [cause instanceof Error ? cause.message : String(cause)];
      warnings = [];
    }
    reports.push({ file, errors, warnings });
    errorCount += errors.length;
    warningCount += warnings.length;
    if (json) continue;
    for (const e of errors) console.log(`✗ ${file}: ${e}`);
    for (const w of warnings) console.log(`⚠ ${file}: ${w}`);
    if (errors.length || !sb) continue;
    if (cmd === 'render') {
      const out = join(STORYBOARD_ROOT, 'docs', 'marketing', `STORYBOARD-${sb.id}-v${sb.version}.md`);
      writeFileSync(out, render(sb, file) + '\n');
      console.log(`✓ ${file} → ${relative(STORYBOARD_ROOT, out)}`);
    } else console.log(`✓ ${file} · v${sb.version} · ${sb.status} · ${sb.kind === 'site' ? `사이트 ${sb.sites?.length ?? 0}` : `샷 ${sb.shots.length}`}`);
  }
  if (cmd === 'lint') debug.log('storyboard.lint', 'checked', { files: reports.length, errorCount, warningCount });
  if (json) console.log(JSON.stringify({ files: reports, errorCount, warningCount }));
  return errorCount ? 1 : 0;
}
