import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import * as ts from 'typescript';
import { parse as parseYaml } from 'yaml';

export const PLUGIN_ONLY_BASELINE = 'scripts/plugin-only-ratchet-baseline.json';
const CODE_FILE = /\.(?:ts|js|py|sh)$/i; // SYNTHESIS §2c measurement set.
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx)$/i;
const FEATURE_ID = /^(?:graph|feature|workflow|plugin|node)(?:Id|_id)$/i;
const FEATURE_MAP = /(?:^(?:graph|node|feature|workflow|plugin|loop|release)(?:Ids|Names|Map|Table|Commands|Status|Handlers|Routes|ById|ByName)$|(?:GRAPH|NODE|FEATURE|WORKFLOW|PLUGIN|LOOP|RELEASE).*(?:IDS|NAMES|MAP|TABLE|COMMANDS|STATUS|HANDLERS|ROUTES|BY_ID|BY_NAME))$/;
// A lexical sieve only: match the identity token or named-map token anywhere in source,
// then let TypeScript AST decide whether it is executable structure (comments/prose are ignored).
const FEATURE_SOURCE_CANDIDATE = /\b(?:(?:graph|feature|workflow|plugin|node)(?:Id|_id)|(?:graph|node|feature|workflow|plugin|loop|release)(?:Ids|Names|Map|Table|Commands|Status|Handlers|Routes|ById|ByName)|(?:GRAPH|NODE|FEATURE|WORKFLOW|PLUGIN|LOOP|RELEASE)\w*(?:IDS|NAMES|MAP|TABLE|COMMANDS|STATUS|HANDLERS|ROUTES|BY_ID|BY_NAME))\b/i;

export interface PluginOnlyBaseline {
  schema: 1;
  sourceRef: string;
  pluginCodeFiles: string[];
  coreFeatureIdentifiers: string[];
}

function walkFiles(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  if (lstatSync(absolute).isSymbolicLink()) throw new Error(`plugin-only inventory does not allow symlinks: ${dir}`);
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, child));
    else if (entry.isFile()) files.push(child.split(sep).join('/'));
    else if (entry.isSymbolicLink()) throw new Error(`plugin-only inventory does not allow symlinks: ${child}`);
  }
  return files.sort();
}

function literalText(node: ts.Expression | ts.PropertyName): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function mapKeyText(node: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(node)) return literalText(node.expression);
  return literalText(node) ?? (ts.isIdentifier(node) ? node.text : undefined);
}

function isFeatureIdentity(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return FEATURE_ID.test(node.text);
  if (ts.isPropertyAccessExpression(node)) return FEATURE_ID.test(node.name.text);
  return ts.isElementAccessExpression(node)
    && !!node.argumentExpression
    && ts.isStringLiteralLike(node.argumentExpression)
    && FEATURE_ID.test(node.argumentExpression.text);
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Only graph/feature identity comparisons and explicitly named feature maps are inventoried. */
export function scanCoreFeatureIdentifiers(source: string, file: string): string[] {
  if (!FEATURE_SOURCE_CANDIDATE.test(source)) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
      const leftNode = unwrapExpression(node.left);
      const rightNode = unwrapExpression(node.right);
      const left = literalText(leftNode);
      const right = literalText(rightNode);
      if (left !== undefined && isFeatureIdentity(rightNode)) found.add(`${file}:comparison:${rightNode.getText(tree)}:${left}`);
      if (right !== undefined && isFeatureIdentity(leftNode)) found.add(`${file}:comparison:${leftNode.getText(tree)}:${right}`);
    }
    const fieldName = (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node))
      ? (ts.isIdentifier(node.name) ? node.name.text : literalText(node.name))
      : undefined;
    if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && fieldName && FEATURE_ID.test(fieldName)
      && node.initializer) {
      const value = literalText(node.initializer);
      if (value !== undefined) found.add(`${file}:identity-field:${fieldName}:${value}`);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && FEATURE_MAP.test(node.name.text)
      && node.initializer && ts.isObjectLiteralExpression(unwrapExpression(node.initializer))) {
      for (const property of (unwrapExpression(node.initializer) as ts.ObjectLiteralExpression).properties) {
        const key = ts.isPropertyAssignment(property)
          ? mapKeyText(property.name)
          : ts.isShorthandPropertyAssignment(property) ? property.name.text
          : ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)
            ? mapKeyText(property.name) : undefined;
        if (key !== undefined) found.add(`${file}:map:${node.name.text}:${key}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...found].sort();
}

export function inventoryFromTree(root: string): Pick<PluginOnlyBaseline, 'pluginCodeFiles' | 'coreFeatureIdentifiers'> {
  const pluginCodeFiles = walkFiles(root, 'plugins').filter((file) => CODE_FILE.test(file)).sort();
  const coreFeatureIdentifiers = walkFiles(root, 'src')
    .filter((file) => SOURCE_FILE.test(file) && !/\.test\.[^.]+$/.test(file))
    .flatMap((file) => scanCoreFeatureIdentifiers(readFileSync(join(root, file), 'utf8'), file))
    .sort();
  return { pluginCodeFiles, coreFeatureIdentifiers };
}

export function compareInventory(current: Pick<PluginOnlyBaseline, 'pluginCodeFiles' | 'coreFeatureIdentifiers'>,
  baseline: Pick<PluginOnlyBaseline, 'pluginCodeFiles' | 'coreFeatureIdentifiers'>): string[] {
  const extras = (now: string[], frozen: string[]) => now.filter((item) => !new Set(frozen).has(item));
  return [
    ...extras(current.pluginCodeFiles, baseline.pluginCodeFiles).map((item) => `plugin-code-added:${item}`),
    ...extras(current.coreFeatureIdentifiers, baseline.coreFeatureIdentifiers).map((item) => `core-feature-hardcode-added:${item}`),
  ];
}

/** A new handler is plugin code only when its manifest names both its module and owning skill. */
export function declaredPluginHandlers(root: string): Set<string> {
  const allowed = new Set<string>();
  const pluginsDir = join(root, 'plugins');
  if (!existsSync(pluginsDir)) return allowed;
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(pluginsDir, entry.name, 'plugin.yaml');
    if (!existsSync(manifestPath)) continue;
    let manifest: unknown;
    try { manifest = parseYaml(readFileSync(manifestPath, 'utf8')); } catch { continue; }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    const record = manifest as Record<string, unknown>;
    const skills = new Set((Array.isArray(record.skills) ? record.skills : [])
      .flatMap(value => value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
        ? [(value as { id: string }).id] : []));
    const handlers = record.handlers;
    if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) continue;
    for (const handler of Object.values(handlers)) {
      if (!handler || typeof handler !== 'object' || Array.isArray(handler)) continue;
      const { module, skill } = handler as { module?: unknown; skill?: unknown };
      const exportName = (handler as { export?: unknown }).export;
      if (typeof module !== 'string' || !/^handlers\/[A-Za-z0-9_-]+\.ts$/.test(module)
        || typeof exportName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)
        || typeof skill !== 'string' || !skills.has(skill)) continue;
      const relativePath = `plugins/${entry.name}/${module}`;
      if (existsSync(join(root, relativePath))) allowed.add(relativePath);
    }
  }
  return allowed;
}

/** A JSON package's executable main is owned by its declared skill and route. */
export function declaredPluginEntrypoints(root: string): Set<string> {
  const allowed = new Set<string>();
  const pluginsDir = join(root, 'plugins');
  if (!existsSync(pluginsDir)) return allowed;
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(pluginsDir, entry.name, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      const main = manifest.main;
      const contributes = manifest.contributes as { skills?: unknown } | undefined;
      if (manifest.id !== entry.name || typeof main !== 'string' || !/^\.\/[A-Za-z0-9_-]+\.ts$/.test(main)
        || !Array.isArray(manifest.activationEvents) || !manifest.activationEvents.includes('onRoute')
        || !Array.isArray(contributes?.skills) || !contributes.skills.some(skill => skill && typeof skill === 'object'
          && typeof (skill as { path?: unknown }).path === 'string'
          && /^\.\/skills\/[A-Za-z0-9_-]+\/SKILL\.md$/.test((skill as { path: string }).path)
          && existsSync(join(pluginsDir, entry.name, (skill as { path: string }).path)))) continue;
      const relativePath = `plugins/${entry.name}/${main.slice(2)}`;
      if (existsSync(join(root, relativePath))) allowed.add(relativePath);
    } catch { /* malformed manifests never grant an exception */ }
  }
  return allowed;
}

function inventoryAtRef(root: string, ref: string): Pick<PluginOnlyBaseline, 'pluginCodeFiles' | 'coreFeatureIdentifiers'> {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-only-ratchet-'));
  try {
    const archive = execFileSync('git', ['archive', ref, 'plugins', 'src'], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
    const extracted = spawnSync('tar', ['-x', '-C', dir], { input: archive, maxBuffer: 128 * 1024 * 1024 });
    if (extracted.status !== 0) throw new Error(`tar extraction failed: ${extracted.stderr.toString()}`);
    return inventoryFromTree(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function regenerateBaseline(root: string, ref: string): PluginOnlyBaseline {
  const sourceRef = execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim();
  return { schema: 1, sourceRef, ...inventoryAtRef(root, ref) };
}

function isUnchangedMainBaselineInShallowCheckout(root: string): boolean {
  try {
    const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
    if (!shallow) return false;

    const baselinePath = join(root, PLUGIN_ONLY_BASELINE);
    const workingBaselineBlob = execFileSync('git', ['hash-object', baselinePath], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const mainBaselineBlob = execFileSync('git', ['rev-parse', `origin/main:${PLUGIN_ONLY_BASELINE}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return workingBaselineBlob === mainBaselineBlob;
  } catch {
    return false;
  }
}

export function checkPluginOnlyRatchet(root: string): string[] {
  const baseline = JSON.parse(readFileSync(join(root, PLUGIN_ONLY_BASELINE), 'utf8')) as PluginOnlyBaseline;
  if (baseline.schema !== 1) throw new Error(`unsupported plugin-only baseline schema: ${baseline.schema}`);
  // Shallow test checkouts may not contain the old sourceRef object even though
  // this unchanged baseline is already part of origin/main. Trust only that
  // exact main blob; PR edits to the frozen baseline still require full ancestry.
  if (!isUnchangedMainBaselineInShallowCheckout(root)) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', baseline.sourceRef, 'HEAD'], { cwd: root, stdio: 'ignore' });
    } catch {
      throw new Error(`plugin-only baseline sourceRef is not an ancestor of HEAD: ${baseline.sourceRef}`);
    }
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', baseline.sourceRef, 'origin/main'], { cwd: root, stdio: 'ignore' });
    } catch {
      throw new Error(`plugin-only baseline sourceRef must come from origin/main: ${baseline.sourceRef}`);
    }
    const sourceInventory = inventoryAtRef(root, baseline.sourceRef);
    if (JSON.stringify(sourceInventory.pluginCodeFiles) !== JSON.stringify(baseline.pluginCodeFiles)
      || JSON.stringify(sourceInventory.coreFeatureIdentifiers) !== JSON.stringify(baseline.coreFeatureIdentifiers)) {
      throw new Error(`plugin-only baseline does not match sourceRef inventory: ${baseline.sourceRef}`);
    }
  }
  const declared = new Set([...declaredPluginHandlers(root), ...declaredPluginEntrypoints(root)]);
  return compareInventory(inventoryFromTree(root), baseline)
    .filter(violation => !violation.startsWith('plugin-code-added:') || !declared.has(violation.slice('plugin-code-added:'.length)));
}

if (import.meta.main) {
  const root = process.cwd();
  const args = process.argv.slice(2);
  if (args[0] === '--write-baseline') {
    const ref = args[1] ?? 'origin/main';
    const baseline = regenerateBaseline(root, ref);
    writeFileSync(join(root, PLUGIN_ONLY_BASELINE), `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`wrote ${PLUGIN_ONLY_BASELINE} from ${ref} (${baseline.pluginCodeFiles.length} plugin code files; ${baseline.coreFeatureIdentifiers.length} frozen core identifiers)`);
  } else {
    const violations = checkPluginOnlyRatchet(root);
    if (violations.length) {
      console.error(violations.join('\n'));
      process.exitCode = 1;
    } else console.log('PLUGIN-ONLY-RATCHET pass: no new plugin code files or core feature identifiers');
  }
}
