/** Real child/PTY test files. This list is shared by release and self gates. */
export const GATE_SPAWN_LANE_FILES = [
  'scripts/lib/tui-runshell-group-e2e.test.ts',
  'scripts/lib/tui-streaming-e2e.test.ts',
  'src/agent-mission/doc-guided-install.test.ts',
  'src/dashboard/first-screen-band-wiring.test.ts',
  'src/git-fs/spawn-discipline.test.ts',
  'src/self-implement/run-ledger.test.ts',
  'src/video-pipeline/recipes/reframe.test.ts',
  'test/ch5730-watch-delivery.test.ts',
  'test/cli-dev-command.test.ts',
  'test/preview-terminal.test.ts',
] as const;

const SPAWN_FILES: ReadonlySet<string> = new Set(GATE_SPAWN_LANE_FILES);

export function isGateSpawnLaneFile(file: string): boolean {
  return SPAWN_FILES.has(file);
}
