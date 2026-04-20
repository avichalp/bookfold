import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerApp, loadServerConfig } from '../src/api.js';

test('GET /healthz and /v1/openapi.json work without runtime payment env', async () => {
  const app = createServerApp({
    config: loadServerConfig({
      env: {
        NODE_ENV: 'test',
        BOOKFOLD_BASE_URL: 'https://bookfold.test'
      }
    })
  });

  const healthResponse = await app.fetch(new Request('https://bookfold.test/healthz'));
  const healthPayload = await healthResponse.json();

  assert.equal(healthResponse.status, 200);
  assert.equal(healthPayload.ok, true);
  assert.equal(healthPayload.service, 'bookfold-mpp-server');

  const openApiResponse = await app.fetch(new Request('https://bookfold.test/v1/openapi.json'));
  const openApiPayload = await openApiResponse.json();

  assert.equal(openApiResponse.status, 200);
  assert.equal(openApiPayload.info.title, 'BookFold MPP Server');
  assert.equal(openApiPayload.paths['/v1/jobs'].post.summary, 'Create or resume a paid summary job');
});
