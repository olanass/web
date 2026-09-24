'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { ethers } = require('ethers');
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.NODE_ENV = 'test';
const { serviceStore, publicService } = require('../src/server/services/store');
const { publicRouter, gatewayRouter, discoveryHandler, serviceCreationMessage } = require('../src/server/services/routes');
const { OrderEngine } = require('../src/server/orders/engine');
const { validateMetered } = require('../src/server/services/metered');
after(() => serviceStore.close());
test('creator signs metered mode; discovery routes directly and fixed-price paths cannot collect funds', async t => {
  t.mock.method(require('node:dns').promises, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  const wallet = ethers.Wallet.createRandom();
  const input = { name: 'Standalone Inference', description: 'Metered test', category: 'AI', videoUrl: '', logoHash: '', openapiHash: '',
    endpointUrl: 'https://inference.example/api/inference/escrow/chat/completions', allowedMethods: ['POST'], price: null, currency: 'USDG',
    billingMode: 'metered', creatorAddress: wallet.address, payoutAddress: wallet.address, creatorTimestamp: String(Date.now()) };
  input.creatorSignature = await wallet.signMessage(serviceCreationMessage(input));
  assert.notEqual(ethers.verifyMessage(serviceCreationMessage({ ...input, billingMode: 'fixed' }), input.creatorSignature), wallet.address);
  const app = express();
  app.use(express.json()); app.use('/api/services', publicRouter); app.use('/x402', gatewayRouter); app.get('/discovery/resources', discoveryHandler);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const registration = await fetch(base + '/api/services', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(registration.status, 201, await registration.clone().text());
    const service = await serviceStore.getBySlug((await registration.json()).service.slug);
    const visible = publicService(service, base);
    assert.equal(visible.price, null);
    assert.equal(visible.billingMode, 'metered');
    assert.equal(visible.gatewayUrl, input.endpointUrl);
    assert.equal(visible.metered.modelsUrl, 'https://inference.example/api/inference/escrow/models');
    const discovery = await (await fetch(base + '/discovery/resources')).json();
    assert.equal(discovery.items[0].metadata.billingMode, 'metered');
    assert.deepEqual(discovery.items[0].accepts, []);
    assert.equal(discovery.items[0].resource, input.endpointUrl);
    assert.equal((await fetch(base + '/x402/' + service.slug, { method: 'POST' })).status, 409);
    await assert.rejects(new OrderEngine().quote(service.slug, 'POST'), /batch-settlement/);
    assert.throws(() => validateMetered({ ...input, price: '0.01' }, input.endpointUrl), /no fixed price/);
    assert.throws(() => validateMetered(input, 'http://inference.example/api/inference/escrow/chat/completions'), /HTTPS/);
    const bad = await fetch(base + '/api/services', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, billingMode: 'anything' }) });
    assert.equal(bad.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
