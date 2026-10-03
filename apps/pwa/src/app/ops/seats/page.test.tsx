import { expect, test } from 'bun:test';
import { isValidElement } from 'react';
import SeatsPage from './page';
import { SeatBoardView } from '@/components/ops/SeatBoardView';

test('/ops/seats page connects to the seat board view', () => {
  const page = SeatsPage();
  expect(isValidElement(page)).toBe(true);
  if (!isValidElement(page)) return;
  expect(page.type).toBe(SeatBoardView);
});
