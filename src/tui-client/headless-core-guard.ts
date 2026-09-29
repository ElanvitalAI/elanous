// UI-Core arc Phase U3 — headless core guard.
//
// Codifies the rule: the ACP server path (`src/acp/server.ts` and
// its transitive deps) must stay free of any TUI / dashboard / chat-
// rendering imports. Otherwise "Core runs headless without the TUI"
// becomes aspirational, and the future Web / iPhone client port
// regresses to in-process coupling.
//
// The guard is a pure function: given the source text of a module,
// return the set of forbidden import specifiers it references. A
// test consumer (test/tui-client-headless-guard.test.ts) scans the
// server-side module graph and asserts the set stays empty.
//
// Allowing future callers to tune the forbidden list rather than
// hard-coding keeps `src/llm/**` available to the server (which will
// need it when Phase U2's `runTurn` injection lands real LLM
// streaming) without re-writing the guard later.

import ts from 'typescript';

const DEFAULT_FORBIDDEN_PREFIXES: readonly string[] = [
  // TUI / rendering — core must not depend on these.
  '../dashboard/',
  '../tui.',
  '../tui/',
  '../chat/',
  '../display/',
  '../log-pane/',
  '../browser-cdp/client',
  '../pane',
  '../panes/',
  '../pty-shell/',
  '../shell-runner/',
  '../terminal-matrix/',
  // Input stack — dashboard-owned.
  '../input-core/',
  '../mouse-',
  '../keymap-',
  // Plugins — host-level.
  '../plugin-',
  '../plugins/',
  // Skills UI surfaces.
  '../skill-runner',
  '../skill-view',
];

function stringLiteralText(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

/** Extract every ES import / dynamic import specifier from a module
 *  source blob. Parsed as TypeScript source so import-shaped text
 *  inside strings or comments is ignored while real import syntax is kept.
 *
 *  Captures:
 *    - `import … from "x"`   (default / named)
 *    - `import "x"`          (side-effect only)
 *    - `import("x")`         (dynamic import)
 *    - `export … from "x"`   (re-export) */
export function extractImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  const sourceFile = ts.createSourceFile(
    'headless-core-guard-input.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier) out.push(specifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = stringLiteralText(node.arguments[0]);
      if (specifier) out.push(specifier);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return out;
}

/** Check one module. Returns the forbidden specifiers it references
 *  (empty array if clean). */
export function findForbiddenImports(
  source: string,
  opts: { forbiddenPrefixes?: readonly string[] } = {},
): string[] {
  const forbidden = opts.forbiddenPrefixes ?? DEFAULT_FORBIDDEN_PREFIXES;
  const specs = extractImportSpecifiers(source);
  const hits: string[] = [];
  for (const spec of specs) {
    for (const prefix of forbidden) {
      if (spec.startsWith(prefix)) {
        hits.push(spec);
        break;
      }
    }
  }
  return hits;
}

export const HEADLESS_CORE_DEFAULT_FORBIDDEN = DEFAULT_FORBIDDEN_PREFIXES;
