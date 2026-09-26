import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { dashboardMatches, readDashboardSources } from './helpers/dashboard-source.js';

function invocationOffenders(identifier: string): string[] {
  return readDashboardSources().flatMap(({ path, text }) => {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const offenders: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === identifier) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        offenders.push(`${path}:${line}  ${node.expression.getText(source)}(`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return offenders;
  });
}

describe('L9 federation guard · dashboard wiring identifier sanity', () => {
  test('dashboard sources do NOT reference `coordinator.X(` (the var is named `display`)', () => {
    const offenders = invocationOffenders('coordinator');
    expect(offenders, `Undefined coordinator.X( references:\n${offenders.join('\n')}`).toEqual([]);
  });

  test('dashboard sources do NOT reference `coord.X(` (the var is named `display`)', () => {
    const offenders = invocationOffenders('coord');
    expect(offenders, `Undefined coord.X( references:\n${offenders.join('\n')}`).toEqual([]);
  });

  test('sanity audit · `display.` reference count stays bounded (typo regression detector)', () => {
    const matches = dashboardMatches(/\bdisplay\.\w+/);
    expect(matches.length, `Found ${matches.length} display references across dashboard sources: ${matches.map(({ path, line }) => `${path}:${line}`).join(', ')}`).toBeGreaterThanOrEqual(20);
  });
});
