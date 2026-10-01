import { initialize } from './initialize.mjs';
import { startProdServer } from 'vinext/server/prod-server';
import { resolve } from 'node:path';
const { env } = await initialize();
const { server } = await startProdServer({
  host: '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  outDir: resolve('dist-yandex'),
});
server.requestTimeout = 90000;
server.headersTimeout = 15000;
function stop() {
  server.close(() => {
    env.DB.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
