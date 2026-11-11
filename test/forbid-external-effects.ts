import { expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';

/** Run a synchronous decision while observing the external boundaries it must not cross. */
export function withoutExternalEffects<T>(decide: () => T): T {
  const calls: string[] = [];
  const forbidden = (name: string): never => {
    calls.push(name);
    throw new Error(`pure decision called ${name}`);
  };
  const spies = [
    spyOn(fs, 'readFileSync').mockImplementation(() => forbidden('fs.readFileSync')),
    spyOn(fs, 'writeFileSync').mockImplementation(() => forbidden('fs.writeFileSync')),
    spyOn(fs, 'readdirSync').mockImplementation(() => forbidden('fs.readdirSync')),
    spyOn(fs, 'statSync').mockImplementation(() => forbidden('fs.statSync')),
    spyOn(childProcess, 'spawn').mockImplementation(() => forbidden('child_process.spawn')),
    spyOn(childProcess, 'spawnSync').mockImplementation(() => forbidden('child_process.spawnSync')),
    spyOn(childProcess, 'execFile').mockImplementation(() => forbidden('child_process.execFile')),
    spyOn(childProcess, 'execFileSync').mockImplementation(() => forbidden('child_process.execFileSync')),
    spyOn(globalThis, 'fetch').mockImplementation(() => forbidden('fetch')),
    spyOn(Bun, 'spawn').mockImplementation(() => forbidden('Bun.spawn')),
    spyOn(Bun, 'spawnSync').mockImplementation(() => forbidden('Bun.spawnSync')),
    spyOn(Bun, 'file').mockImplementation(() => forbidden('Bun.file')),
  ];
  try {
    const result = decide();
    expect(calls).toEqual([]);
    return result;
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
  }
}
