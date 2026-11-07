import { expect, test } from 'bun:test';
import { baselineUnmeasurableTimeoutIds } from './gate-baseline';

test('timeout baseline measures only the matching skipped or timed-out testcase', () => {
  const target = 'src/a.test.ts > slow';
  expect(baselineUnmeasurableTimeoutIds({ output: 'src/a.test.ts:\n(skip) slow\n1 skip\n0 fail\n' }, [target])).toEqual([target]);
  expect(baselineUnmeasurableTimeoutIds({ output: 'src/a.test.ts:\n(skip) other\n1 skip\n0 fail\n' }, [target])).toEqual([]);
  expect(baselineUnmeasurableTimeoutIds({ output: 'src/a.test.ts:\n(pass) slow\n0 skip\n0 fail\n' }, [target])).toEqual([]);
  expect(baselineUnmeasurableTimeoutIds({ output: 'src/a.test.ts:\n(fail) slow [6040.00ms]\n  ^ this test timed out after 5000ms.\n' }, [target])).toEqual([target]);
  expect(baselineUnmeasurableTimeoutIds({ output: '' }, [target])).toEqual([]);
});
