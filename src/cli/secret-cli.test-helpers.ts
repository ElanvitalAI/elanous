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
    promptSecret: async () => 'mock-secret-value',
    saveSecret: async (id, value) => { values.set(id, value); },
    getSecret: async (id) => values.get(id),
    listSecrets: async () => [...values.keys()].sort(),
    removeSecret: async (id) => values.delete(id),
    verifySecret: async (serviceId) => { verified.push(serviceId); return { result: 'verified', httpStatus: 200 }; },
    storageBackend: () => 'mock-empty',
    initializeBackend: () => {},
    output: { log: (line) => output.push(line), error: (line) => errors.push(line) },
    setExitCode: (code) => exitCodes.push(code),
  };
  return { deps, values, output, errors, parserErrors, exitCodes, verified };
}
