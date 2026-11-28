import { expect, test } from 'bun:test';
import { parseFederationPoolPanes } from './els-cli.js';

test('pool panes distinguish an empty pool from a malformed response', () => {
  expect(parseFederationPoolPanes('{"panes":[]}')).toEqual([]);
  expect(parseFederationPoolPanes('{}')).toBeNull();
  expect(parseFederationPoolPanes('null')).toBeNull();
  expect(parseFederationPoolPanes('{')).toBeNull();
  expect(parseFederationPoolPanes('{"panes":{}}')).toBeNull();
  expect(parseFederationPoolPanes('{"panes":[null]}')).toBeNull();
  expect(parseFederationPoolPanes('{"panes":[42]}')).toBeNull();
  expect(parseFederationPoolPanes('{"panes":[{"seat":"TC"}]}')).toEqual([{ seat: 'TC' }]);
});
