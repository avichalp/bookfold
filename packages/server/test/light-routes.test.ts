import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerApp, loadServerConfig } from '../src/api.js';

test('discovery routes work without runtime payment env', async () => {
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

  const homeResponse = await app.fetch(new Request('https://bookfold.test/'));
  const homeHtml = await homeResponse.text();
  const faviconResponse = await app.fetch(new Request('https://bookfold.test/favicon.svg'));
  const faviconText = await faviconResponse.text();
  const openApiResponse = await app.fetch(new Request('https://bookfold.test/openapi.json'));
  const openApiPayload = await openApiResponse.json();
  const openApiAliasResponse = await app.fetch(new Request('https://bookfold.test/v1/openapi.json'));
  const llmsResponse = await app.fetch(new Request('https://bookfold.test/llms.txt'));
  const llmsText = await llmsResponse.text();
  const wellKnownResponse = await app.fetch(new Request('https://bookfold.test/.well-known/x402'));
  const wellKnownPayload = await wellKnownResponse.json();

  assert.equal(homeResponse.status, 200);
  assert.match(homeHtml, /BookFold/);
  assert.equal(faviconResponse.status, 200);
  assert.match(faviconText, /<svg/);
  assert.equal(openApiResponse.status, 200);
  assert.equal(openApiAliasResponse.status, 200);
  assert.equal(openApiPayload.info.title, 'BookFold');
  assert.equal(openApiPayload.paths['/v1/jobs'].post.summary, 'Create or resume a paid summary job');
  assert.equal(llmsResponse.status, 200);
  assert.match(llmsText, /POST \/v1\/uploads/);
  assert.equal(wellKnownResponse.status, 200);
  assert.deepEqual(wellKnownPayload.ownershipProofs, ['mpp-verify=bookfold.test']);
});
