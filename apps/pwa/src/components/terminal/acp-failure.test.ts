import { describe, expect, test } from 'bun:test';
import { classifyAcpFailure, reconnectDelayMs } from './acp-failure';

describe('classifyAcpFailure — 연결이 끊긴 이유', () => {
  test('서버가 토큰을 거절하면(1008 auth_failed) 토큰 문제다 — 다시 붙어도 또 실패한다', () => {
    expect(classifyAcpFailure('socket closed: 1008: auth_failed')).toBe('auth');
    expect(classifyAcpFailure('HTTP 401 Unauthorized')).toBe('auth');
  });
  test('데몬 재시작·네트워크 끊김은 잠깐의 실패다', () => {
    expect(classifyAcpFailure('socket closed: 1006')).toBe('transient');
    expect(classifyAcpFailure('socket error: [object Event]')).toBe('transient');
    expect(classifyAcpFailure(undefined)).toBe('transient');
  });
});

describe('reconnectDelayMs', () => {
  test('1s 부터 두 배씩, 30s 에서 멈춘다', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
