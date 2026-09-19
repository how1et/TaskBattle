import { readFile } from 'node:fs/promises';
import ts from 'typescript';
/** Load real TS modules under Node with only Cloudflare bindings substituted. */
export async function loadModule(path) {
  const memo = new Map();
  async function compile(url) {
    if (memo.has(url.href)) return memo.get(url.href);
    let source = await readFile(url, 'utf8');
    source = source.replace(
      /import\s*\{\s*env\s*\}\s*from\s*['"]cloudflare:workers['"];?/g,
      'const env=globalThis.__taskbattleTestEnv;',
    );
    let code = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const matches = [...code.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)];
    for (const match of matches) {
      const spec = match[1],
        target = new URL(spec.endsWith('.ts') ? spec : spec + '.ts', url);
      code = code
        .replaceAll(`'${spec}'`, JSON.stringify(await compile(target)))
        .replaceAll(`"${spec}"`, JSON.stringify(await compile(target)));
    }
    const data =
      'data:text/javascript;base64,' +
      Buffer.from(code + '\n// ' + crypto.randomUUID()).toString('base64');
    memo.set(url.href, data);
    return data;
  }
  return import(await compile(path instanceof URL ? path : new URL(path, import.meta.url)));
}
