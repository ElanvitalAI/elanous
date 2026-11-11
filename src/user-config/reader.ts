// Public read API: loading the compatibility façade installs the builder and path callbacks
// before these reader functions can run. Keep state and cache implementation in read.ts.
import '../user-config.js';

export {
  getUserConfig,
  reloadUserConfig,
  resetUserConfig,
  runWithUserConfigSnapshot,
  setUserConfigOverlay,
} from './read.js';
