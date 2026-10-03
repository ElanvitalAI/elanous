import { expect, test } from 'bun:test';
import { Suspense, isValidElement } from 'react';
import Page from './page';
import { InsidePage } from '@/components/inside/InsidePage';

test('/inside page connects the client scene to a static-export-safe Suspense boundary', () => {
  const page = Page();
  expect(isValidElement(page)).toBe(true);
  expect(page.type).toBe(Suspense);
  const child = page.props.children;
  expect(isValidElement(child)).toBe(true);
  if (isValidElement(child)) expect(child.type).toBe(InsidePage);
});
