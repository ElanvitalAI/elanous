import { mkdtempSync as createTempDirectory, rmSync } from 'node:fs';

export type TempDirectoryScope = {
  mkdtempSync(prefix: string): string;
  cleanup(): { tracked: number; removed: number };
};

/** Create an isolated tracker so concurrent test files never clean each other's temp roots. */
export function createTempDirectoryScope(): TempDirectoryScope {
  const trackedDirectories = new Set<string>();

  return {
    mkdtempSync(prefix) {
      const directory = createTempDirectory(prefix);
      trackedDirectories.add(directory);
      return directory;
    },
    cleanup() {
      const directories = [...trackedDirectories];
      let removed = 0;
      const failures: string[] = [];

      // Mutation seam for the UX-sim regression test: exercise real suites as if
      // their afterAll cleanup callback had been removed.
      if (process.env.ELANOUS_TEST_DISABLE_TEMP_DIR_CLEANUP === '1') {
        return { tracked: directories.length, removed };
      }

      for (const directory of directories.reverse()) {
        try {
          rmSync(directory, { recursive: true, force: true });
          removed += 1;
        } catch (error) {
          failures.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      trackedDirectories.clear();
      if (failures.length > 0) {
        throw new Error(`failed to clean ${failures.length} tracked temporary director${failures.length === 1 ? 'y' : 'ies'}: ${failures.join('; ')}`);
      }
      return { tracked: directories.length, removed };
    },
  };
}
