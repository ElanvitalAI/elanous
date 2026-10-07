import { expect, test } from 'bun:test';
import { DecisionBoard } from '@/components/decisions/DecisionBoard';
import DecisionsPage from './page';

test('/decisions renders the decision board without a dynamic route or server fetch', () => {
  const element = DecisionsPage();
  expect(element.type).toBe(DecisionBoard);
});
