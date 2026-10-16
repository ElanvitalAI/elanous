import { expect, test } from 'bun:test';
import { GATE_POD_ENV_BASELINE, gateTestBaseline, withGateTestEnv } from './gate-test-env.js';

test('self gate receives the release test baseline while preserving explicit provider endpoints and fake-LLM off', () => {
  const env = withGateTestEnv({ TZ: 'Asia/Seoul', LANG: 'C', OPENAI_BASE_URL: 'http://127.0.0.1:9999', ELANOUS_TEST_FAKE_LLM: '0' });
  expect(env).toMatchObject({ TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    OPENAI_BASE_URL: 'http://127.0.0.1:9999', ELANOUS_TEST_FAKE_LLM: '0' });
  expect(withGateTestEnv({}).ELANOUS_TEST_FAKE_LLM).toBe(GATE_POD_ENV_BASELINE.ELANOUS_TEST_FAKE_LLM);
  expect(gateTestBaseline({ ELANOUS_TEST_FAKE_LLM: '0' })).toMatchObject({ TZ: 'UTC', ELANOUS_TEST_FAKE_LLM: '0' });
});
