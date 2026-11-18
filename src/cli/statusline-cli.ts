// `eln statusline validate | preview | schema` (STATUSLINE-CONTRACT-V1 slice 1). Read-only: nothing here writes the file.
import type { Command } from 'commander';
import {
  formatStatuslineIssue, previewStatusline, STATUSLINE_JSON_SCHEMA, STATUSLINE_PREVIEW_WIDTHS, validateStatuslineFile,
} from '../statusline/contract.js';
import { statuslineUserPath } from '../statusline/next-tui.js';

export interface StatuslineCliDeps {
  readonly out?: (line: string) => void;
  readonly userPath?: () => string;
  readonly build?: () => Promise<import('../statusline/next-tui.js').StatuslineBuild>;
}

function parseWidths(value: string): number[] {
  const widths = value.split(',').map((part) => Number(part.trim()));
  if (widths.length === 0 || widths.some((width) => !Number.isInteger(width) || width < 1)) {
    throw new Error(`--width takes whole numbers, comma separated (got ${value})`);
  }
  return widths;
}

export function registerStatuslineCommands(program: Command, deps: StatuslineCliDeps = {}): void {
  const out = deps.out ?? ((line: string) => console.log(line));
  const userPath = deps.userPath ?? (() => statuslineUserPath());
  const statusline = program.command('statusline').description('Check and preview your status-line definition (statusline.yaml)');
  statusline.command('validate [file]').description('Check a statusline.yaml; errors carry their line number')
    .action((file: string | undefined) => {
      const path = file ?? userPath();
      const issues = validateStatuslineFile(path);
      if (issues.length === 0) { out(`${path}: ok`); return; }
      for (const issue of issues) out(formatStatuslineIssue(path, issue));
      process.exitCode = 1;
    });
  statusline.command('preview [file]').description('Draw the footer with this definition at several widths')
    .option('--width <list>', 'comma-separated widths', STATUSLINE_PREVIEW_WIDTHS.join(','))
    .action(async (file: string | undefined, options: { width: string }) => {
      const build = deps.build ? await deps.build() : (await import('../pty-shell/tui-run-state.js')).runningBuild();
      const preview = previewStatusline({ path: file ?? userPath(), widths: parseWidths(options.width), build });
      if (preview.warning) { out(preview.warning); process.exitCode = 1; }
      for (const { width, line } of preview.lines) out(`${String(width).padStart(4)} │${line}`);
    });
  statusline.command('schema').description('Print the JSON Schema of statusline.yaml (for editors)')
    .action(() => out(JSON.stringify(STATUSLINE_JSON_SCHEMA, null, 2)));
}
