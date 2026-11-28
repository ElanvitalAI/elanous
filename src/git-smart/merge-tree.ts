/** Execute a virtual merge without changing the working tree. Callers interpret Git's status and output. */
export function mergeTree<T>(run: (args: string[]) => T, base: string, head: string, config: readonly string[] = [], options: readonly string[] = ['--name-only', '-z']): T {
  return run([...config, 'merge-tree', '--write-tree', ...options, base, head]);
}
