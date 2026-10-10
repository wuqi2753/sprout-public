// REQ-074: execute the actual component callbacks without requiring a camera.
import { readFileSync } from 'node:fs';
import ts from 'typescript';

export function connectionCallbacks(filename, names) {
  const source = ts.createSourceFile(filename, readFileSync(new URL(`../../src/components/${filename}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map();
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && names.includes(node.name.text)) declarations.set(node.name.text, node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  return ts.transpileModule(names.map((name) => {
    if (!declarations.has(name)) throw new Error(`Missing connection callback: ${name}`);
    return declarations.get(name);
  }).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
