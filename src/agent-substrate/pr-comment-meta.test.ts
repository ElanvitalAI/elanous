import { describe, expect, test } from 'bun:test';
import { expandRecords, format, parse, type PrCommentMeta } from './pr-comment-meta.js';

describe('PR comment metadata', () => {
  test('format → parse round-trip encodes spaces, newlines, and closing angle brackets without early comment closure', () => {
    const meta: PrCommentMeta = {
      role: 'reviewer', round: 2, run: 'run one\nline>', model: 'model > one',
      mf: '3', replyTo: 'round 1', answered: '2', unanswered: '1',
    };
    const header = format(meta);
    expect(header).toContain('run=run%20one%0Aline%3E');
    expect(header).toContain('model=model%20%3E%20one');
    expect((header.match(/-->/g) ?? []).length).toBe(1);
    expect(parse(`${header}\nHuman-readable body`)).toEqual(meta);
  });

  test('ignores unknown keys for forward compatibility while retaining all v1 fields', () => {
    expect(parse('<!-- elanous-pr-comment v1 role=author future=value run=run-1 mf=2 replyTo=1 answered=2 unanswered=0 -->'))
      .toEqual({ role: 'author', run: 'run-1', mf: '2', replyTo: '1', answered: '2', unanswered: '0' });
  });

  test('rejects an unknown role and duplicate keys', () => {
    expect(parse('<!-- elanous-pr-comment v1 role=robot -->')).toBeNull();
    expect(parse('<!-- elanous-pr-comment v1 role=author run=one run=two -->')).toBeNull();
  });

  test('drops only malformed or negative round values', () => {
    expect(parse('<!-- elanous-pr-comment v1 role=judge round=two run=run-1 -->')).toEqual({ role: 'judge', run: 'run-1' });
    expect(parse('<!-- elanous-pr-comment v1 role=judge round=-1 run=run-1 -->')).toEqual({ role: 'judge', run: 'run-1' });
  });

  test('returns null, without throwing, for ordinary human comments without a header', () => {
    expect(() => parse('평범한 사람이 손으로 쓴 코멘트')).not.toThrow();
    expect(parse('평범한 사람이 손으로 쓴 코멘트')).toBeNull();
  });

  test('rejects a header not on the first line, missing role or close, and an unknown version', () => {
    expect(parse('intro\n<!-- elanous-pr-comment v1 role=author -->')).toBeNull();
    expect(parse('<!-- elanous-pr-comment v1 run=run-1 -->')).toBeNull();
    expect(parse('<!-- elanous-pr-comment v1 role=author')).toBeNull();
    expect(parse('<!-- elanous-pr-comment v2 role=author -->')).toBeNull();
  });

  test('expands each round-headed record in a run-status details without including the summary', () => {
    const first = `${format({ role: 'author', round: 0, run: 'run-1' })}\nRound 0\n\n- created`;
    const second = `${format({ role: 'reviewer', round: 1, run: 'run-1' })}\nRound 1\n\n- fixed`;
    const body = `<!-- elanous:run-status -->\n<details>\n<summary>Round history</summary>\n\n${first}\n\n${second}\n</details>`;
    expect(expandRecords(body)).toEqual([first, second]);
    expect(expandRecords(body).map(parse)).toEqual([
      { role: 'author', round: 0, run: 'run-1' },
      { role: 'reviewer', round: 1, run: 'run-1' },
    ]);
    expect(expandRecords(body.replaceAll('\n', '\r\n'))).toEqual([first.replaceAll('\n', '\r\n'), second.replaceAll('\n', '\r\n')]);
  });

  test('expands records across details blocks but ignores invalid or roundless headers', () => {
    const first = `${format({ role: 'author', round: 0 })}\nFirst round`;
    const second = `${format({ role: 'judge', round: 3 })}\nThird round`;
    const body = [
      '<!-- elanous:run-status -->',
      '<details open>', '<summary>First</summary>',
      '<!-- elanous-pr-comment v1 role=reviewer -->', first, '</details>',
      '<details>', '<summary>Second</summary>',
      '<!-- elanous-pr-comment v1 role=robot round=2 -->', second, '</details>',
    ].join('\n');
    expect(expandRecords(body)).toEqual([first, second]);
  });

  test('roundless author record after reviewer ends the reviewer body without being returned', () => {
    const reviewer = `${format({ role: 'reviewer', round: 2 })}\n- reviewer must-fix`;
    const author = `${format({ role: 'author' })}\n- author response is not a must-fix`;
    const judge = `${format({ role: 'judge', round: 3 })}\nJudge conclusion`;
    const body = `<!-- elanous:run-status -->\n<details>\n<summary>Round history</summary>\n${reviewer}\n\n${author}\n\n${judge}\n</details>`;
    expect(expandRecords(body)).toEqual([reviewer, judge]);
  });

  test('leaves ordinary comments and status comments without round-headed records intact', () => {
    const ordinary = `${format({ role: 'author', round: 0 })}\nIndividual comment`;
    const human = 'A human comment with <details>\n<!-- elanous-pr-comment v1 role=reviewer round=2 -->\n</details>';
    const similarMarker = '<!-- elanous:run-status --> extra\n<details>\n<!-- elanous-pr-comment v1 role=author round=1 -->\n</details>';
    const emptyStatus = '<!-- elanous:run-status -->\n<details>\n<summary>Round history</summary>\n</details>';
    expect(expandRecords(ordinary)).toEqual([ordinary]);
    expect(expandRecords(human)).toEqual([human]);
    expect(expandRecords(similarMarker)).toEqual([similarMarker]);
    expect(expandRecords(emptyStatus)).toEqual([emptyStatus]);
  });
});
