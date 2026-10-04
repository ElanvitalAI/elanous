import { describe, expect, test } from 'bun:test';
import { slashEnterAction } from './ChatInput';
import { assertTuiSeatAskRestartContract } from '../../../../../test/seat-ask-tui-restart-contract';

const COMMANDS = [{ name: 'help' }, { name: 'history' }, { name: 'clear' }];

test('TUI reconnect recovers CTO seat answers and overdue notices', assertTuiSeatAskRestartContract);

describe('slashEnterAction — Enter while the slash menu is open', () => {
  test('an exact command name runs it at once as a meta line', () => {
    expect(slashEnterAction('help', COMMANDS, 0)).toEqual({ kind: 'run', line: ':help' });
    expect(slashEnterAction('HELP', COMMANDS, 1)).toEqual({ kind: 'run', line: ':help' });
  });

  test('a prefix completes the selected item instead of sending', () => {
    expect(slashEnterAction('h', COMMANDS.slice(0, 2), 1)).toEqual({ kind: 'complete', value: ':history ' });
  });

  test('nothing to pick gives no action', () => {
    expect(slashEnterAction('zzz', [], 0)).toBeNull();
  });
});
