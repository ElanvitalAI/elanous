export const SELF_SEND_LOCAL_ONLY_ENV = 'ELANOUS_SELF_SEND_LOCAL_ONLY';

/** A remote child must resolve its own Pod fragment without starting another SSH hop. */
export function mayLookupRemotePodRun(env: NodeJS.ProcessEnv): boolean {
  return env[SELF_SEND_LOCAL_ONLY_ENV] !== '1';
}
