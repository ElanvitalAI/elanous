/** Lazy runtime boundary for consumers that use the gate API without owning the gate CLI. */
import { createRequire } from 'node:module';
import { GATE_ISOLATED_TIMEOUT_MS } from './gate-constants.js';

const require = createRequire(import.meta.url);
type GateNodeRuntime = typeof import('./gate-runtime.js');

function gateNode(): GateNodeRuntime {
  return require('./gate-runtime.js') as GateNodeRuntime;
}

export const createGateRunner: GateNodeRuntime['createGateRunner'] = (...args) => gateNode().createGateRunner(...args);
export const judgeGate: GateNodeRuntime['judgeGate'] = (...args) => gateNode().judgeGate(...args);
export const mismatchedGateRosterImagePools: GateNodeRuntime['mismatchedGateRosterImagePools'] = (...args) =>
  gateNode().mismatchedGateRosterImagePools(...args);
export const graphGateResult: GateNodeRuntime['graphGateResult'] = (...args) => gateNode().graphGateResult(...args);
export { GATE_ISOLATED_TIMEOUT_MS };
export const readBaselineFileCache: GateNodeRuntime['readBaselineFileCache'] = (...args) => gateNode().readBaselineFileCache(...args);
export const saveBaselineFileCache: GateNodeRuntime['saveBaselineFileCache'] = (...args) => gateNode().saveBaselineFileCache(...args);
