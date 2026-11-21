import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { connectHolderElsPty, holderSocketPath } from './holder.js';
import { dirname } from 'node:path';
import type { ProcessIdentity } from './peer-seat.js';

test('legacy holder response cannot bind a later-reused PID to a seat', async () => {
  const root = mkdtempSync('/tmp/eh-old-');
  const path = holderSocketPath(root, 'p1');
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer(socket => socket.once('data', () => socket.write(JSON.stringify({ type: 'pong', paneId: 'p1', ptyId: 'pty1', pid: 12345 }) + '\n')));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const identity: ProcessIdentity = { pid: 12345, ppid: 22, session: 12345, tty: 9, start: '100:1', startedMs: 100000 };
  let lookedUp = false;
  const pty = connectHolderElsPty(root, 'p1', undefined, () => { lookedUp = true; return identity; });
  try {
    for (let i = 0; i < 100 && pty.pid === undefined; i++) await new Promise(r => setTimeout(r, 10));
    expect(pty.pid).toBe(12345);
    expect(lookedUp).toBe(true);
    expect(pty.processBinding).toBeUndefined();
  } finally {
    pty.detach?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('holder binding requires a matching birth identity', async () => {
  const root = mkdtempSync('/tmp/eh-bind-');
  const path = holderSocketPath(root, 'p1');
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer(socket => socket.once('data', () => socket.write(JSON.stringify({ type: 'pong', paneId: 'p1', ptyId: 'pty1', pid: 12345, processStart: '100:1' }) + '\n')));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  let birth = '100:1';
  const pty = connectHolderElsPty(root, 'p1', undefined, () => ({ pid: 12345, ppid: 22, session: 12345, tty: 9, start: birth, startedMs: 100000 }));
  try {
    for (let i = 0; i < 100 && pty.pid === undefined; i++) await new Promise(r => setTimeout(r, 10));
    expect(pty.processBinding).toEqual({ pid: 12345, generation: 'pty1', start: '100:1' });
    birth = '200:1';
    const other = connectHolderElsPty(root, 'p1', undefined, () => ({ pid: 12345, ppid: 22, session: 12345, tty: 9, start: birth, startedMs: 200000 }));
    try {
      for (let i = 0; i < 100 && other.pid === undefined; i++) await new Promise(r => setTimeout(r, 10));
      expect(other.pid).toBe(12345);
      expect(other.processBinding).toBeUndefined();
    } finally { other.detach?.(); }
  } finally {
    pty.detach?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('legacy holder cannot add a birth identity after the first response', async () => {
  const root = mkdtempSync('/tmp/eh-promote-');
  const path = holderSocketPath(root, 'p1');
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer(socket => {
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (request.op === 'ping') socket.write(JSON.stringify({ type: 'pong', paneId: 'p1', ptyId: 'pty1', pid: 12345 }) + '\n');
        if (request.op === 'snapshot') socket.write(JSON.stringify({ type: 'snapshot', paneId: 'p1', ptyId: 'pty1', pid: 12345, processStart: '100:1', alive: true, cols: 80, rows: 24, exitCode: null, bracketedPaste: false, lastOutputAt: null, screen: '' }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const pty = connectHolderElsPty(root, 'p1', undefined, () => ({ pid: 12345, ppid: 22, session: 12345, tty: 9, start: '100:1', startedMs: 100000 }));
  try {
    for (let i = 0; i < 100 && pty.pid === undefined; i++) await new Promise(r => setTimeout(r, 10));
    expect(pty.processBinding).toBeUndefined();
    await pty.renderScreen().catch(() => undefined);
    expect(pty.processBinding).toBeUndefined();
  } finally {
    pty.detach?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('holder snapshot from another pane cannot set the adapter PID', async () => {
  const root = mkdtempSync('/tmp/eh-id-');
  const path = holderSocketPath(root, 'p1');
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer(socket => socket.once('data', () => socket.write(JSON.stringify({ type: 'snapshot', paneId: 'p-other', ptyId: 'pty1', pid: 12345, alive: true, cols: 80, rows: 24, exitCode: null, bracketedPaste: false, lastOutputAt: null, screen: '' }) + '\n')));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const pty = connectHolderElsPty(root, 'p1', undefined);
  try {
    await expect(pty.renderScreen()).rejects.toThrow();
    expect(pty.pid).toBeUndefined();
    expect(pty.isAlive()).toBe(false);
  } finally {
    pty.detach?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('holder cannot switch PTY generation on the same socket', async () => {
  const root = mkdtempSync('/tmp/eh-gen-');
  const path = holderSocketPath(root, 'p1');
  mkdirSync(dirname(path), { recursive: true });
  let count = 0;
  const server = createServer(socket => {
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (request.op === 'ping') socket.write(JSON.stringify({ type: 'pong', paneId: 'p1', ptyId: 'pty1', pid: 12345 }) + '\n');
        if (request.op === 'snapshot') socket.write(JSON.stringify({ type: 'snapshot', paneId: 'p1', ptyId: ++count === 1 ? 'pty1' : 'pty2', pid: 12345, alive: true, cols: 80, rows: 24, exitCode: null, bracketedPaste: false, lastOutputAt: null, screen: '' }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const pty = connectHolderElsPty(root, 'p1', undefined);
  try {
    await pty.renderScreen();
    await expect(pty.renderScreen()).rejects.toThrow();
    expect(pty.isAlive()).toBe(false);
  } finally {
    pty.detach?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
