import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { parseSuggestion, registerQCommands, validateShellSyntax } from './q-cli.js';

afterEach(() => { process.exitCode = 0; });

describe('q command-only contract', () => {
  test('extracts one executable command and rejects non-command labels', () => {
    expect(parseSuggestion('find . -type f\n')).toBe('find . -type f');
    expect(parseSuggestion('```sh\nfind . -type f\n```')).toBe('find . -type f');
    expect(() => parseSuggestion('Command: find .')).toThrow('first line');
    expect(() => parseSuggestion('find . -type f\nLists matching files.')).toThrow('exactly one command line');
    expect(() => parseSuggestion('echo foo \\')).toThrow('incomplete continued command');
  });

  test('configured shell parses without executing and rejects incomplete syntax', async () => {
    for (const command of [
      'echo "unterminated', 'echo foo |', 'if true; then echo hi', 'for x in a; do echo x',
      'echo ${foo', 'echo $(pwd', 'echo foo\\||',
    ]) await expect(validateShellSyntax(command)).rejects.toThrow('invalid shell syntax');
    for (const command of ['echo foo\\|', 'for x in a; do echo x; done', 'case x in x) echo ok;; esac']) {
      await expect(validateShellSyntax(command)).resolves.toBeUndefined();
    }
  });

  test('prints a valid command only and rejects prose without leaking a partial command', async () => {
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
    let suggestionCalls = 0;
    const command = new Command();
    registerQCommands(command, {
      suggest: async () => { suggestionCalls += 1; return 'find . -type f'; },
      log: () => {},
    });
    try {
      await command.parseAsync(['node', 'elanous', 'q', 'list', 'files'], { from: 'node' });
      expect(suggestionCalls).toBe(1);
      expect(output.mock.calls.flat().join('')).toBe('find . -type f\n');
    } finally {
      output.mockRestore();
    }
  });

  test('does not print a partial command when the model adds a second line', async () => {
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const command = new Command();
    registerQCommands(command, { suggest: async () => 'find . -type f\\\nExplanation', log: () => {} });
    try {
      await command.parseAsync(['node', 'elanous', 'q', 'list', 'files'], { from: 'node' });
      expect(output).not.toHaveBeenCalled();
      expect(errors.mock.calls.flat().join(' ')).toContain('exactly one command line');
      expect(process.exitCode).toBe(1);
    } finally {
      output.mockRestore();
      errors.mockRestore();
    }
  });

  test('does not print a command that the configured shell rejects', async () => {
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const command = new Command();
    registerQCommands(command, { suggest: async () => 'if true; then echo hi', log: () => {} });
    try {
      await command.parseAsync(['node', 'elanous', 'q', 'say', 'hello'], { from: 'node' });
      expect(output).not.toHaveBeenCalled();
      expect(errors.mock.calls.flat().join(' ')).toContain('invalid shell syntax');
    } finally {
      output.mockRestore();
      errors.mockRestore();
    }
  });

  test('zsh widget contains live parameter expansions without literal backslashes', async () => {
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const command = new Command();
    registerQCommands(command, { suggest: async () => 'pwd', log: () => {} });
    try {
      await command.parseAsync(['node', 'elanous', 'shell-init', 'zsh'], { from: 'node' });
      const script = output.mock.calls.flat().join('');
      expect(script).toContain('CURSOR=${#BUFFER}');
      expect(script).toContain(': ${ELN_Q_KEY:=^G}');
      expect(script).not.toContain('\\${');
    } finally {
      output.mockRestore();
    }
  });

  test('zsh widget replaces the input buffer and moves the cursor to the command end', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'elanous-q-widget-'));
    const fakeBin = join(temp, 'bin');
    mkdirSync(fakeBin);
    const fakeEln = join(fakeBin, 'eln');
    writeFileSync(fakeEln, '#!/bin/sh\nprintf "ls -la\\n"\n');
    chmodSync(fakeEln, 0o755);
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const command = new Command();
    registerQCommands(command, { suggest: async () => 'pwd', log: () => {} });
    try {
      await command.parseAsync(['node', 'elanous', 'shell-init', 'zsh'], { from: 'node' });
      const widget = output.mock.calls.flat().join('');
      const invocation = [
        'function zle() { : }', 'function bindkey() { print -r -- "BINDKEY:$*" }', widget,
        "BUFFER='natural language'", 'eln-q-widget', 'print -r -- "RESULT:$BUFFER:$CURSOR"',
      ].join('\n');
      const result = spawnSync('zsh', ['-f', '-c', invocation], {
        encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}` },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('RESULT:ls -la:6');
      expect(result.stdout).toContain('BINDKEY:^G eln-q-widget');
    } finally {
      output.mockRestore();
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
