import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('native composer microphone boundary', () => {
  it('allows only audio in the trusted main frame at both permission boundaries', () => {
    const source = readFileSync(path.join(__dirname, '../../../src/main/index.ts'), 'utf8');
    const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
    const statements: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
        && /^session\.defaultSession\.setPermission(?:Check|Request)Handler$/.test(node.expression.expression.getText(tree))) statements.push(node.getText(tree));
      ts.forEachChild(node, visit);
    }
    visit(tree);
    const handlers: Record<string, Function> = {};
    const main = {}, foreign = {};
    vm.runInNewContext(ts.transpileModule(statements.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      session: { defaultSession: {
        setPermissionCheckHandler: (fn: Function) => { handlers.check = fn; },
        setPermissionRequestHandler: (fn: Function) => { handlers.request = fn; },
      } }, BrowserWindow: { fromWebContents: (wc: unknown) => wc }, mainWindows: new Set([main]),
    });
    expect(handlers.check).toBeTypeOf('function');
    for (const [window, isMainFrame, mediaType, allowed] of [
      [main, true, 'audio', true], [main, true, 'video', false],
      [main, false, 'audio', false], [foreign, true, 'audio', false],
    ] as const) {
      expect(handlers.check(window, 'media', '', { isMainFrame, mediaType })).toBe(allowed);
      let result;
      handlers.request(window, 'media', (value: boolean) => { result = value; }, { isMainFrame, mediaTypes: [mediaType] });
      expect(result).toBe(allowed);
    }
  });
});
