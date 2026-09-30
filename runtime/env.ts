// Populated once before the Node server starts. No Cloudflare runtime is imported.
export const env = new Proxy({} as Cloudflare.Env, {
  get(_target, name) {
    const value = (globalThis as typeof globalThis & { __taskbattleRuntime?: Cloudflare.Env })
      .__taskbattleRuntime;
    if (!value) throw new Error('TaskBattle runtime has not been initialized');
    return value[name as keyof Cloudflare.Env];
  },
});
