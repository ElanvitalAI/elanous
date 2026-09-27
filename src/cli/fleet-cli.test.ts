import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerFleetCommands } from './fleet-cli.js';

test('registerFleetCommands preserves fleet subcommands, default list, and option flags', () => {
  const program = new Command();
  registerFleetCommands(program);
  const fleet = program.commands.find((command) => command.name() === 'fleet');
  expect(fleet).toBeDefined();
  expect(fleet!.description()).toBe('멀티 elanous 인스턴스 통합 뷰(READ-ONLY 연합) — 등록 인스턴스·보유 스토어 매트릭스. `logs instances` 일반화(kubectl get nodes 등가). 연합 조회는 `session list --all-instances` 등.');
  expect(fleet!.commands.map((command) => command.name())).toEqual(['list', 'screen']);
  const [list, screen] = fleet!.commands;
  expect((fleet as Command & { _defaultCommandName?: string })._defaultCommandName).toBe('list');
  expect(list!.description()).toBe('등록 인스턴스 나열 — name·alive·repo·state-dir·보유 스토어(logs/sessions/tasks/memory)');
  expect(list!.options.map((option) => option.flags)).toEqual(['--json']);
  expect(screen!.description()).toBe('등록 elanous 인스턴스의 PTY 화면 프레임을 read-only로 조회한다');
  expect(screen!.options.map((option) => option.flags)).toEqual(['--all', '--include-test', '--json']);
});
