import type { SecretCliDeps } from './secret-cli.js';

/** Fresh, empty in-memory secrets fixture. It has no OS, key-cache, or network path. */
export function createEmptySecretCliMock() {
  const values = new Map<string, string>();
  const output: string[] = [];
  const errors: string[] = [];
  const parserErrors: string[] = [];
  const exitCodes: number[] = [];
  const verified: string[] = [];
  const deps: SecretCliDeps = {
    isInteractive: () => true,
    isStdoutTTY: () => false,
    promptSecret: async () => 'mock-secret-value',
    saveSecret: async (id, value) => { values.set(id, value); },
    revokeAppSecrets: async (app, name) => {
      const prefix = `app/${app}/`;
      const targets = name === undefined ? [...values.keys()].filter((id) => id.startsWith(prefix)) : [`${prefix}${name}`];
      let count = 0;
      for (const id of targets) if (values.delete(id)) count += 1;
      return { revoked: count, alreadyAbsent: targets.length === 0 && count === 0 };
    },
    getSecret: async (id) => values.get(id),
    listSecrets: async () => [...values.keys()].sort(),
    removeSecret: async (id) => values.delete(id),
    importSecrets: async (secrets, overwrite, expectedConflicts) => {
      const conflicts = Object.keys(secrets).filter((id) => values.has(id)).sort();
      if (expectedConflicts && (conflicts.length !== expectedConflicts.length || conflicts.some((id, index) => id !== [...expectedConflicts].sort()[index]))) {
        return { imported: false, conflicts, changedSinceConfirmation: true };
      }
      if (conflicts.length && !overwrite) return { imported: false, conflicts, changedSinceConfirmation: false };
      for (const [id, value] of Object.entries(secrets)) values.set(id, value);
      return { imported: true, conflicts, changedSinceConfirmation: false };
    },
    verifySecret: async (serviceId) => { verified.push(serviceId); return { result: 'verified', httpStatus: 200 }; },
    storageBackend: () => 'mock-empty',
    initializeBackend: () => {},
    output: { log: (line) => output.push(line), error: (line) => errors.push(line) },
    setExitCode: (code) => exitCodes.push(code),
  };
  return { deps, values, output, errors, parserErrors, exitCodes, verified };
}
