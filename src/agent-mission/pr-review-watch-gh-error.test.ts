import { describe, expect, test } from 'bun:test';
import { classifyReviewWatchGhError, ReviewWatchGhError } from './pr-review-watch.js';

describe('classifyReviewWatchGhError', () => {
  test('401와 gh 인증 안내를 auth로 분류한다', () => {
    for (const error of [
      { message: 'Command failed: gh pr list', stderr: Buffer.from('HTTP 401: Bad credentials') },
      new Error('To get started with GitHub CLI, please run: gh auth login'),
    ]) {
      const classified = classifyReviewWatchGhError(error);
      expect(classified).toBeInstanceOf(ReviewWatchGhError);
      expect(classified.kind).toBe('auth');
      expect(classified.cause).toBe(error);
    }
  });

  test('404와 Not Found를 not-found로 분류한다', () => {
    expect(classifyReviewWatchGhError(new Error('HTTP 404: Not Found')).kind).toBe('not-found');
    expect(classifyReviewWatchGhError({ stderr: 'GraphQL: Not Found', message: 'gh pr view failed' }).kind).toBe('not-found');
  });

  test('gh 실행 파일이 없으면 missing-binary로 분류한다', () => {
    expect(classifyReviewWatchGhError(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })).kind).toBe('missing-binary');
    expect(classifyReviewWatchGhError(new Error('gh: command not found')).kind).toBe('missing-binary');
    expect(classifyReviewWatchGhError(new Error('exec: "gh": executable file not found in $PATH')).kind).toBe('missing-binary');
  });

  test('그 밖의 오류는 other로 분류하고 이미 분류된 오류를 보존한다', () => {
    const error = new Error('network timeout');
    const classified = classifyReviewWatchGhError(error);
    expect(classified.kind).toBe('other');
    expect(classified.message).toBe('network timeout');
    expect(classifyReviewWatchGhError(classified)).toBe(classified);
  });
});
