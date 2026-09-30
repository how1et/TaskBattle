import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const result = spawnSync(process.execPath, ['node_modules/vinext/dist/cli.js', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, TASKBATTLE_RUNTIME: 'yandex' },
});
if (result.status !== 0) process.exit(result.status || 1);
if (!existsSync('dist/server/index.js')) throw new Error('Missing Node build');
const output = resolve('dist-yandex');
if (dirname(output) !== process.cwd()) throw new Error('Invalid build output');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync('dist', 'dist-yandex', { recursive: true });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(
  'dist-yandex/build.json',
  JSON.stringify({ runtime: 'yandex', app: pkg.name, builtAt: new Date().toISOString() }),
);
