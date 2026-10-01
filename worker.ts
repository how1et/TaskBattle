import handler from 'vinext/server/fetch-handler';
import { handleBridge, type BridgeEnv } from './lib/server/bridge';

type WorkerEnv = Cloudflare.Env &
  BridgeEnv & {
    ASSETS?: { fetch(request: Request): Promise<Response> };
  };

const worker = {
  async fetch(request: Request, env: WorkerEnv, context: ExecutionContext) {
    const bridged = await handleBridge(request, env, {
      // This binding can serve files only. Never pass Vinext as a fallback:
      // the old application must not write its retired database after cutover.
      assetFetch: env.ASSETS ? (assetRequest) => env.ASSETS!.fetch(assetRequest) : undefined,
    });
    if (bridged !== null) return bridged;
    return handler.fetch(request, env, context);
  },
};

export default worker;
