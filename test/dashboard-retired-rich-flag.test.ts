import { describe, expect, test } from 'bun:test';
import { filterDashboardArgs } from '../src/index.js';

// 루트 `--rich` 는 main() 이 부팅 전에 거부한다(exit 1 · test/dashboard-rich-flag.test.ts).
// 여기서는 걸러내기가 서브커맨드의 인자를 삼키지 않는지만 본다.
describe('retired --rich dashboard flag', () => {
  test('is stripped only on the dashboard path, without swallowing subcommand arguments', () => {
    expect(filterDashboardArgs(['--rich', '--debug'])).toEqual([]);
    expect(filterDashboardArgs(['session', '--rich'])).toEqual(['session', '--rich']);
  });
});
