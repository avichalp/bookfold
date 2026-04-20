import { createServerApp, loadServerConfig } from '@bookfold/server/api';

export const runtime = 'nodejs';

let app: ReturnType<typeof createServerApp> | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    app ??= createServerApp({
      config: loadServerConfig()
    });

    return app.fetch(request);
  }
};
