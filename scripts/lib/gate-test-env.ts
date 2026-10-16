/** Shared deterministic environment for release and self gate test children. No process side effects. */
export const GATE_POD_ENV_BASELINE: Readonly<Record<string, string>> = Object.freeze({
  TZ: 'UTC',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  ELANOUS_TEST_FAKE_LLM: '1',
});

/** Preserve an explicit fake-LLM choice (including '0'); pin locale and timezone. */
export function gateTestBaseline(source: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...GATE_POD_ENV_BASELINE,
    ELANOUS_TEST_FAKE_LLM: source.ELANOUS_TEST_FAKE_LLM ?? GATE_POD_ENV_BASELINE.ELANOUS_TEST_FAKE_LLM,
  };
}

export function withGateTestEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...source, ...gateTestBaseline(source) };
}
