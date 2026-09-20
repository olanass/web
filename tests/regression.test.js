const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const vm = require('vm');
const projectRoot = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-regression-'));
process.env.X402_DATA_DIR = dataDir;
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.X402_DEMO_MODE = 'true';
process.env.NODE_ENV = 'test';
process.env.X402_TEST_ALLOW_PRIVATE_ENDPOINTS = 'true';
process.env.VAULT_MASTER_SECRET = crypto.randomBytes(32).toString('hex');
process.env.PINATA_JWT = '';
const { ethers } = require('ethers');
const { ROBINHOOD_CHAIN_CONFIG: config } = require('../src/server/config/chain');
const { parseAmount } = require('../src/server/facilitator/amount');
const { verifyPayment, claimMessage, EIP712_DOMAIN, EIP712_TYPES } = require('../src/server/facilitator/verifier');
const { settlePayment } = require('../src/server/facilitator/settler');
const vault = require('../src/server/vault/storage');
const app = require('../src/server/app');
const { serviceCreationMessage, managementMessage } = require('../src/server/services/routes');
const { serviceStore } = require('../src/server/services/store');
const { isPrivateAddress } = require('../src/server/services/endpoint-security');
const { OlanasAgent, safeSuffix } = require('../sdk');
const payer = ethers.Wallet.createRandom();
const creator = ethers.Wallet.createRandom();
let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await serviceStore.close();
  const target = path.resolve(dataDir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('x402-regression-'));
  fs.rmSync(target, { recursive: true });
});
const requirement = { price: '1.5', token: 'ETH', recipient: creator.address, resource: '/api/paywalls/example/download' };
async function chainFixture(overrides = {}) {
  const txHash = '0x' + crypto.randomBytes(32).toString('hex');
  const proof = { scheme: 'onchain-tx', txHash, payer: payer.address, signature: await payer.signMessage(claimMessage(txHash, payer.address, requirement.resource)) };
  const tx = { hash: txHash, from: payer.address, to: creator.address, value: ethers.parseEther('1.5'), ...overrides.tx };
  const receipt = { hash: txHash, status: 1, blockNumber: 10, logs: [], ...overrides.receipt };
  const provider = {
    getNetwork: async () => ({ chainId: overrides.chainId || 4663 }),
    getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => overrides.head || 11
  };
  return { proof, provider };
}
test('production: rejects malformed prices without floating point coercion', () => {
  for (const price of ['NaN', 'Infinity', '1abc', '-1', '0', '1e5', '', '0.0000001']) assert.throws(() => parseAmount(price, 'USDC'));
  assert.equal(parseAmount('1.000001', 'USDC'), 1000001n);
  for (const token of ['__proto__', 'constructor', 'toString']) assert.throws(() => parseAmount('1', token));
});
test('production: agent paths reject absolute URLs and traversal', () => {
  assert.equal(safeSuffix('/forecast?city=Delhi'), '/forecast?city=Delhi');
  for (const value of ['https://evil.example', '//evil.example', '../admin', '/a/../admin']) assert.throws(() => safeSuffix(value));
});
test('production: agent payments fail closed on price and approval policy', async () => {
  const fetchConfig = async () => ({
    ok: true,
    json: async () => ({ networks: [{ caip2: config.caip2, chainId: config.chainId, tokens: [config.supportedTokens.USDG] }] })
  });
  const requirement = { token: 'USDG', network: config.caip2, amount: '2000', payTo: creator.address, asset: config.supportedTokens.USDG.address };
  const expensive = new OlanasAgent({ signer: {}, fetch: fetchConfig, allowedTokens: ['USDG'], maxPricePerCall: { USDG: '0.001' }, dailyBudget: { USDG: '1' }, autoApprove: true });
  await assert.rejects(expensive.authorize('weather-ai', requirement), /maxPricePerCall/);
  const unapproved = new OlanasAgent({ signer: {}, fetch: fetchConfig, allowedTokens: ['USDG'], maxPricePerCall: { USDG: '0.01' }, dailyBudget: { USDG: '1' } });
  assert.equal(await unapproved.authorize('weather-ai', requirement), false);
});
test('production: simulated proofs remain disabled even when demo flag is set', () => {
  const child = spawnSync(process.execPath, ['-e', "const c=require('./src/server/config/chain').ROBINHOOD_CHAIN_CONFIG;if(c.demoMode)process.exit(1)"], { cwd: projectRoot, env: { ...process.env, NODE_ENV: 'production' } });
  assert.equal(child.status, 0, child.stderr.toString());
});
test('production: testnet configuration is isolated from mainnet data and token addresses', () => {
  const script = `
    const config = require('./src/server/config/chain').ROBINHOOD_CHAIN_CONFIG;
    const paths = require('./src/server/config/paths');
    console.log(JSON.stringify({ config, dataDir: paths.DATA_DIR }));
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      X402_DEMO_MODE: 'false',
      X402_DATA_DIR: '',
      ROBINHOOD_TESTNET_DATA_DIR: '',
      ROBINHOOD_NETWORK: 'testnet',
      ROBINHOOD_RPC_URL: '',
      USDC_CONTRACT_ADDRESS: '0x0000000000000000000000000000000000000002'
    }
  });
  assert.equal(child.status, 0, child.stderr.toString());
  const { config: testnet, dataDir } = JSON.parse(child.stdout.toString());
  assert.equal(testnet.chainId, 46630);
  assert.equal(testnet.caip2, 'eip155:46630');
  assert.equal(testnet.networkId, 'robinhood-chain-testnet');
  assert.equal(testnet.rpcUrl, 'https://rpc.testnet.chain.robinhood.com');
  assert.equal(testnet.explorerUrl, 'https://explorer.testnet.chain.robinhood.com');
  assert.equal(testnet.testnet, true);
  assert.equal(testnet.supportedTokens.USDC, undefined);
  assert.equal(path.basename(dataDir), 'uploads-testnet');
});
test('production: real mode rejects sandbox and unfunded signed vouchers', async () => {
  config.demoMode = false;
  try {
    for (const scheme of ['sandbox', 'exact']) assert.equal((await verifyPayment({ scheme }, requirement)).valid, false);
  } finally { config.demoMode = true; }
});
test('production: fake hashes and malformed payer claims are rejected', async () => {
  for (const txHash of ['0xsim_123', '0xtest_123', 'bad']) assert.equal((await verifyPayment({ scheme: 'onchain-tx', txHash }, requirement)).valid, false);
  const f = await chainFixture();
  f.proof.signature = await creator.signMessage(claimMessage(f.proof.txHash, payer.address, requirement.resource));
  assert.equal((await verifyPayment(f.proof, requirement, f)).valid, false);
});
for (const [name, change] of Object.entries({
  'wrong recipient': { tx: { to: payer.address } }, 'underpayment': { tx: { value: 1n } },
  'wrong payer': { tx: { from: creator.address } }, 'wrong chain': { chainId: 1 },
  'reverted transaction': { receipt: { status: 0 } }
})) test('production: rejects ' + name, async () => {
  const f = await chainFixture(change);
  assert.equal((await verifyPayment(f.proof, requirement, f)).valid, false);
});
test('production: accepts a successful mined transaction without waiting for a second L2 block', async () => {
  const f = await chainFixture({ head: 10 });
  assert.equal((await verifyPayment(f.proof, requirement, f)).valid, true);
});
test('production: verification is read-only, settlement is durable and single use', async () => {
  const f = await chainFixture();
  const first = await verifyPayment(f.proof, requirement, f);
  const second = await verifyPayment(f.proof, requirement, f);
  assert.equal(first.valid, true); assert.equal(second.valid, true);
  const receipt = settlePayment(first, { endpoint: requirement.resource });
  assert.equal(receipt.txHash, f.proof.txHash);
  assert.equal(receipt.facilitatorFee, '0');
  assert.equal(settlePayment(second, { endpoint: requirement.resource }).receiptId, receipt.receiptId);
  const retry = await verifyPayment(f.proof, requirement, f);
  assert.equal(settlePayment(retry).replayed, true);
  assert.equal((await verifyPayment(f.proof, { ...requirement, price: '2' }, f)).valid, false);
  const child = spawnSync(process.execPath, ['-e', "if(!require('./src/server/facilitator/redemptions').isRedeemed(process.argv[1]))process.exit(1)", first.redemptionKey], { cwd: projectRoot, env: process.env });
  assert.equal(child.status, 0, child.stderr.toString());
});
test('production: token verification matches contract, transfer sender, recipient and amount', async () => {
  const req = { ...requirement, token: 'USDC' };
  const f = await chainFixture();
  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const event = iface.encodeEventLog('Transfer', [payer.address, creator.address, 1500000n]);
  let log = { ...event, address: config.supportedTokens.USDC.address };
  f.provider.getTransactionReceipt = async () => ({ hash: f.proof.txHash, status: 1, blockNumber: 10, logs: [log] });
  assert.equal((await verifyPayment(f.proof, req, f)).valid, true);
  log = { ...log, address: creator.address };
  assert.equal((await verifyPayment(f.proof, req, f)).valid, false);
  log = { ...iface.encodeEventLog('Transfer', [payer.address, creator.address, 1n]), address: config.supportedTokens.USDC.address };
  assert.equal((await verifyPayment(f.proof, req, f)).valid, false);
});
test('production: claim cannot be reused for another resource', async () => {
  const f = await chainFixture();
  assert.equal((await verifyPayment(f.proof, { ...requirement, resource: '/another-file' }, f)).valid, false);
});
test('production: vault encrypts content and does not disclose previews', () => {
  const secret = 'short paid secret';
  const asset = vault.storeTextAsset('alpha', secret);
  assert.equal(vault.getDecryptedAssetBuffer(asset).toString(), secret);
  assert.ok(!fs.readFileSync(asset.filePath).includes(secret));
  assert.ok(!asset.preview.includes(secret));
  assert.equal(vault.getAssetPath('../package.json'), null);
  assert.throws(() => vault.decryptBuffer(fs.readFileSync(asset.filePath), asset.iv, '00'.repeat(16)));
});
test('handshake: agent challenge, demo receipt, POST and analytics', async () => {
  const { AgentClient } = require('../src/server/agent/client');
  const agent = new AgentClient({ baseUrl: base });
  const challenge = await fetch(base + '/api/v1/market/robinhood-pulse');
  assert.equal(challenge.status, 402);
  const result = await agent.fetchWith402('/api/v1/market/robinhood-pulse');
  assert.equal(result.status, 200);
  assert.equal(result.receipt.status, 'simulated');
  assert.equal(result.receipt.txHash, null);
  const post = await agent.fetchWith402('/api/v1/agent/inference', { method: 'POST', body: JSON.stringify({ prompt: 'test' }) });
  assert.equal(post.status, 200);
});
test('handshake: agent does not consume a text response twice', async () => {
  const { AgentClient } = require('../src/server/agent/client');
  const result = await new AgentClient({ baseUrl: base }).fetchWith402('/');
  assert.match(result.data.raw, /<!DOCTYPE html>/i);
});
test('handshake: invalid token voucher, expired signatures and nonce replays fail', async () => {
  const authorization = { payer: payer.address, recipient: creator.address, amount: '1.5', token: 'ETH', nonce: crypto.randomUUID(), deadline: Math.floor(Date.now() / 1000) + 60, chainId: 4663 };
  const proof = { scheme: 'exact', authorization, signature: await payer.signTypedData(EIP712_DOMAIN, EIP712_TYPES, authorization) };
  const valid = await verifyPayment(proof, requirement);
  assert.equal(valid.valid, true);
  settlePayment(valid);
  assert.equal((await verifyPayment(proof, requirement)).valid, false);
  authorization.nonce = crypto.randomUUID(); authorization.deadline = 1;
  proof.signature = await payer.signTypedData(EIP712_DOMAIN, EIP712_TYPES, authorization);
  assert.equal((await verifyPayment(proof, requirement)).valid, false);
});
async function createForm(secret = 'paid secret', overrides = {}) {
  const fields = { title: 'Private file', description: '', price: '1.5', currency: 'ETH', creatorAddress: creator.address, creatorTimestamp: String(Date.now()), textContent: secret, ...overrides };
  const message = 'x402 create paywall\n' + JSON.stringify({ title: fields.title, description: fields.description, price: fields.price, currency: fields.currency, creatorAddress: fields.creatorAddress.toLowerCase(), contentHash: crypto.createHash('sha256').update(secret).digest('hex'), timestamp: fields.creatorTimestamp });
  fields.creatorSignature = await creator.signMessage(message);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}
test('paywall: signed creation, private metadata, download gating, replay prevention', async () => {
  const content = 'paid content which must never appear in a preview';
  const created = await fetch(base + '/api/paywalls/create', { method: 'POST', body: await createForm(content) });
  assert.equal(created.status, 201, await created.clone().text());
  const { paywall } = await created.json();
  const preview = await fetch(base + '/api/paywalls/' + paywall.paywallId).then(r => r.json());
  const list = await fetch(base + '/api/paywalls/creator/' + creator.address).then(r => r.json());
  for (const result of [paywall, preview, list]) {
    const raw = JSON.stringify(result);
    for (const sensitive of [content, 'storedFilename', 'authTag', 'creatorSignature', 'sha256']) assert.ok(!raw.includes(sensitive), sensitive);
  }
  const url = base + '/api/paywalls/' + paywall.paywallId + '/download';
  const unpaid = await fetch(url);
  assert.equal(unpaid.status, 402);
  const challenge = JSON.parse(Buffer.from(unpaid.headers.get('payment-required'), 'base64'));
  assert.equal(new URL(challenge.resource.url).pathname, new URL(url).pathname);
  const proof = { scheme: 'sandbox', payer: payer.address, recipient: creator.address, amount: '1.5', token: 'ETH', chainId: 4663, nonce: crypto.randomUUID() };
  const options = { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(proof)).toString('base64') } };
  const paid = await fetch(url, options);
  assert.equal(paid.status, 200); assert.equal(await paid.text(), content);
  assert.equal((await fetch(url, options)).status, 402);
  const stats = await fetch(base + '/api/paywalls/creator/' + creator.address).then(r => r.json());
  assert.equal(stats.paywalls.find(p => p.paywallId === paywall.paywallId).totalEarned, '1.5');
});
test('paywall: invalid creation and content tampering leave no vault files', async () => {
  const before = fs.readdirSync(dataDir).filter(f => f.endsWith('.enc')).length;
  for (const value of ['NaN', '-1', 'Infinity', '1oops']) {
    const response = await fetch(base + '/api/paywalls/create', { method: 'POST', body: await createForm('secret', { price: value }) });
    assert.equal(response.status, 400);
  }
  const form = await createForm('secret'); form.set('textContent', 'tampered');
  const response = await fetch(base + '/api/paywalls/create', { method: 'POST', body: form });
  assert.equal(response.status, 400);
  assert.equal(fs.readdirSync(dataDir).filter(f => f.endsWith('.enc')).length, before);
});
test('paywall: multipart upload round trips binary bytes', async () => {
  const bytes = Buffer.from([0, 255, 1, 128, 34]);
  const fields = { title: 'Binary file', description: '', price: '1', currency: 'ETH', creatorAddress: creator.address, creatorTimestamp: String(Date.now()) };
  const message = 'x402 create paywall\n' + JSON.stringify({ title: fields.title, description: '', price: '1', currency: 'ETH', creatorAddress: creator.address.toLowerCase(), contentHash: crypto.createHash('sha256').update(bytes).digest('hex'), timestamp: fields.creatorTimestamp });
  const form = new FormData(); for (const [k,v] of Object.entries(fields)) form.append(k,v);
  form.append('creatorSignature', await creator.signMessage(message)); form.append('file', new Blob([bytes]), 'data.bin');
  const result = await fetch(base + '/api/paywalls/create', { method: 'POST', body: form });
  assert.equal(result.status, 201);
  const { paywall } = await result.json();
  const proof = { scheme: 'sandbox', payer: payer.address, recipient: creator.address, amount: '1', token: 'ETH', chainId: 4663, nonce: crypto.randomUUID() };
  const download = await fetch(base + '/api/paywalls/' + paywall.paywallId + '/download', { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(proof)).toString('base64') } });
  assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});
test('services: signed launch, private metadata, paid proxy and analytics', async () => {
  let flakyCalls = 0;
  const upstream = require('http').createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.url.includes('/flaky') && flakyCalls++ === 0) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: 'temporary failure' }));
      }
      if (req.url.includes('/always-fails')) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: 'no such thing' }));
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await new Promise(resolve => upstream.once('listening', resolve));
  try {
    const timestamp = String(Date.now());
    const logoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64');
    const payload = {
      name: 'Weather AI', description: 'AI-ready weather data API', category: 'Data', videoUrl: 'https://video.example.com/weather-demo',
      logoHash: crypto.createHash('sha256').update(logoBytes).digest('hex'),
      logoDataUrl: `data:image/png;base64,${logoBytes.toString('base64')}`,
      endpointUrl: `http://127.0.0.1:${upstream.address().port}/origin`,
      allowedMethods: ['POST'], price: '0.002', currency: 'USDC',
      creatorAddress: creator.address, payoutAddress: creator.address, creatorTimestamp: timestamp
    };
    payload.openapiDocument = {
      openapi: '3.1.0', info: { title: 'Weather AI', version: '1.0.0' },
      servers: [{ url: payload.endpointUrl }],
      paths: { '/forecast': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { city: { type: 'string' } } } } } } } } }
    };
    payload.openapiHash = crypto.createHash('sha256').update(JSON.stringify(payload.openapiDocument)).digest('hex');
    payload.creatorSignature = await creator.signMessage(serviceCreationMessage(payload));
    const created = await fetch(base + '/api/services', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    assert.equal(created.status, 201, await created.clone().text());
    const service = (await created.json()).service;
    assert.equal(service.network, config.networkId);
    assert.equal(service.requests, 0);
    assert.equal(service.videoUrl, payload.videoUrl);
    assert.match(service.logoUrl, /\/api\/services\/weather-ai\/logo$/);
    assert.match(service.openapiUrl, /\/api\/services\/weather-ai\/openapi\.json$/);
    const logoResponse = await fetch(service.logoUrl);
    assert.equal(logoResponse.status, 200);
    assert.deepEqual(Buffer.from(await logoResponse.arrayBuffer()), logoBytes);
    assert.ok(!JSON.stringify(service).includes(payload.endpointUrl));
    const openapi = await fetch(service.openapiUrl).then(response => response.json());
    assert.equal(openapi.servers[0].url, `${base}/x402/${service.slug}`);
    assert.equal(openapi['x-olanas-payment'].currency, 'USDC');
    assert.ok(!JSON.stringify(openapi).includes(payload.endpointUrl));

    const unpaid = await fetch(`${base}/x402/${service.slug}/forecast?city=Delhi`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: 3 })
    });
    assert.equal(unpaid.status, 402);
    const challenge = JSON.parse(Buffer.from(unpaid.headers.get('payment-required'), 'base64'));
    assert.equal(challenge.price, '0.002');
    assert.equal(challenge.network, config.networkId);
    assert.equal(challenge.x402Version, 2);
    const discovery = await fetch(base + '/discovery/resources').then(result => result.json());
    assert.equal(discovery.items.some(item => item.resource.endsWith('/x402/' + service.slug)), true);
    const discovered = discovery.items.find(item => item.resource.endsWith('/x402/' + service.slug));
    assert.equal(discovered.metadata.openapi, service.openapiUrl);
    assert.equal(discovered.metadata.input.path, '/forecast');

    const proof = {
      scheme: 'sandbox', payer: payer.address, recipient: creator.address,
      amount: '0.002', token: 'USDC', chainId: config.chainId, nonce: crypto.randomUUID()
    };
    const paid = await fetch(`${base}/x402/${service.slug}/forecast?city=Delhi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from(JSON.stringify(proof)).toString('base64') },
      body: JSON.stringify({ days: 3 })
    });
    assert.equal(paid.status, 200, await paid.clone().text());
    const settledReceipt = JSON.parse(Buffer.from(paid.headers.get('payment-response'), 'base64').toString('utf8'));
    assert.equal((await serviceStore.getReceiptById(settledReceipt.receiptId)).receiptId, settledReceipt.receiptId);
    const response = await paid.json();
    assert.equal(response.method, 'POST');
    assert.equal(response.url, '/origin/forecast?city=Delhi');
    assert.deepEqual(JSON.parse(response.body), { days: 3 });

    const replay = await fetch(`${base}/x402/${service.slug}/forecast?city=Delhi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from(JSON.stringify(proof)).toString('base64') },
      body: JSON.stringify({ days: 7 })
    });
    assert.equal(replay.status, 409);

    const retryProof = {
      scheme: 'sandbox', payer: payer.address, recipient: creator.address,
      amount: '0.002', token: 'USDC', chainId: config.chainId, nonce: crypto.randomUUID()
    };
    const retryHeaders = { 'payment-signature': Buffer.from(JSON.stringify(retryProof)).toString('base64') };
    assert.equal((await fetch(`${base}/x402/${service.slug}/flaky`, { method: 'POST', headers: retryHeaders })).status, 503);
    assert.equal((await fetch(`${base}/x402/${service.slug}/flaky`, { method: 'POST', headers: retryHeaders })).status, 200);

    const detail = await fetch(base + '/api/services/' + service.slug).then(result => result.json());
    assert.equal(detail.service.requests, 2);
    assert.equal(detail.service.revenue, '0.004');
    assert.equal(detail.service.successfulResponses, 2);
    assert.equal(detail.service.failedResponses, 1);
    assert.ok(!JSON.stringify(detail).includes(payload.endpointUrl));
    const creatorList = await fetch(base + '/api/services/creator/' + creator.address).then(result => result.json());
    assert.equal(creatorList.services.some(item => item.serviceId === service.serviceId), true);
    assert.ok(!JSON.stringify(creatorList).includes('creatorSignature'));

    // A payment whose upstream keeps failing may be retried, but not without end: otherwise one
    // payment buys unlimited proxied calls against the creator's origin.
    const failingProof = {
      scheme: 'sandbox', payer: payer.address, recipient: creator.address,
      amount: '0.002', token: 'USDC', chainId: config.chainId, nonce: crypto.randomUUID()
    };
    const failingHeaders = { 'payment-signature': Buffer.from(JSON.stringify(failingProof)).toString('base64') };
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await fetch(`${base}/x402/${service.slug}/always-fails`, { method: 'POST', headers: failingHeaders })).status);
    }
    assert.deepEqual(statuses, [404, 404, 404, 409, 409]);

    const changes = { status: 'paused' };
    const creatorTimestamp = String(Date.now());
    const creatorSignature = await creator.signMessage(managementMessage('update', service.slug, changes, creatorTimestamp));
    const paused = await fetch(base + '/api/services/' + service.slug, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes, creatorTimestamp, creatorSignature })
    });
    assert.equal(paused.status, 200, await paused.clone().text());
    assert.equal((await paused.json()).service.status, 'paused');
    const replayedManagement = await fetch(base + '/api/services/' + service.slug, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes, creatorTimestamp, creatorSignature })
    });
    assert.equal(replayedManagement.status, 409);
    assert.equal((await fetch(`${base}/x402/${service.slug}`, { method: 'POST' })).status, 503);
  } finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
test('services: endpoint security identifies private and reserved addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1']) assert.equal(isPrivateAddress(address), true);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(address), false);
});
test('production: unknown APIs, malformed JSON and legacy wallet APIs return JSON errors', async () => {
  assert.equal((await fetch(base + '/api/nonexistent')).status, 404);
  const malformed = await fetch(base + '/api/paywalls/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400); assert.ok((await malformed.json()).error);
  for (const endpoint of ['login-email', 'create-embedded-wallet']) assert.equal((await fetch(base + '/api/privy/' + endpoint, { method: 'POST' })).status, 410);
});
test('production: MCP endpoint completes a stateless protocol initialization', async () => {
  const response = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'regression-test', version: '1.0.0' } } })
  });
  assert.equal(response.status, 200, await response.clone().text());
  const initialized = await response.json();
  assert.equal(initialized.result.serverInfo.name, 'olanas-api-launchpad');
  assert.ok(initialized.result.capabilities.tools);
  assert.equal((await fetch(base + '/mcp')).status, 405);
});
test('production: network selector config advertises isolated mainnet and testnet targets', async () => {
  const response = await fetch(base + '/api/privy/config').then(r => r.json());
  assert.equal(response.chain.networkKey, 'mainnet');
  assert.deepEqual(response.networks.map(network => [network.networkKey, network.chainId]), [
    ['mainnet', 4663],
    ['testnet', 46630]
  ]);
  assert.ok(response.networks.every(network => network.appUrl));
  assert.match(await fetch(base).then(r => r.text()), /id="networkSelector"/);
});
test('production: agent runner cannot request arbitrary URLs', async () => {
  const result = await fetch(base + '/agent-runner/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: 'http://127.0.0.1/private' }) });
  assert.equal(result.status, 400);
});
function browserFixture(provider, fetchImpl) {
  const elements = new Map();
  const document = {
    addEventListener() {}, querySelectorAll() { return []; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', style: {}, classList: { add() {}, remove() {} }, click() {}, remove() {}, scrollIntoView() {} });
      return elements.get(id);
    },
    createElement() { return { click() {}, remove() {} }; }, body: { appendChild() {}, dataset: {} }, title: 'x402 Paywall'
  };
  const saved = new Map();
  const storage = { getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v), removeItem: k => saved.delete(k) };
  const sandbox = { window: { ethereum: provider, URL, location: { origin: 'http://local', pathname: '/' } },
    document, localStorage: storage, sessionStorage: storage, console: { warn() {}, error() {} },
    fetch: fetchImpl, crypto: crypto.webcrypto, TextEncoder, FormData, Blob, URL, setTimeout, clearTimeout,
    btoa: value => Buffer.from(value).toString('base64') };
  const context = vm.createContext(sandbox);
  for (const script of ['app', 'navigation', 'network', 'wallet', 'gas', 'creator', 'checkout', 'dashboard']) {
    const source = fs.readFileSync(path.join(projectRoot, 'src', 'client', 'scripts', `${script}.js`), 'utf8');
    vm.runInContext(source, context, { filename: `${script}.js` });
  }
  return { context, elements, document, saved };
}
test('browser: rejecting a creator signature never publishes a file', async () => {
  let posted = false;
  const browser = browserFixture({ request: async ({ method }) => {
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_requestAccounts') return [creator.address];
    if (method === 'personal_sign') throw new Error('User rejected');
  } }, async () => { posted = true; throw new Error('Unexpected publication'); });
  for (const [id,value] of Object.entries({ assetTitle: 'Private', assetDesc: '', assetPrice: '1', assetCurrency: 'ETH', textContentInput: 'secret' })) browser.document.getElementById(id).value = value;
  vm.runInContext('state.currentWallet = ' + JSON.stringify({ address: creator.address, isRealWeb3: true }), browser.context);
  await vm.runInContext('handlePublishPaywall()', browser.context);
  assert.equal(posted, false);
  assert.equal(browser.document.getElementById('btnPublishPaywall').disabled, false);
});
test('browser: loads and switches to the server-selected Robinhood testnet', async () => {
  const provider = { request: async ({ method }) => {
    if (method === 'eth_chainId') return '0xb626';
    throw new Error('Unexpected provider method ' + method);
  } };
  const browser = browserFixture(provider, async url => {
    assert.equal(url, '/api/privy/config');
    return {
      ok: true,
      json: async () => ({
        chain: {
          networkKey: 'testnet',
          networkId: 'robinhood-chain-testnet',
          chainId: 46630,
          name: 'Robinhood Chain Testnet',
          rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
          explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          testnet: true
        }
      })
    };
  });
  await vm.runInContext('loadNetworkConfig()', browser.context);
  assert.equal(vm.runInContext('ROBINHOOD_CHAIN_ID_DEC', browser.context), 46630);
  assert.equal(vm.runInContext('ROBINHOOD_CHAIN_ID_HEX', browser.context), '0xb626');
  assert.equal(await vm.runInContext('ensureRobinhoodNetwork()', browser.context), true);
  assert.equal(browser.document.body.dataset.network, 'testnet');
  assert.equal(browser.document.getElementById('testnetBanner').hidden, false);
});
test('browser: USDC checkout sends the exact token amount and retries the same transaction', async () => {
  const transactions = [];
  const txHash = '0x' + 'ab'.repeat(32);
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts') return [payer.address];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_sendTransaction') { transactions.push(params[0]); return txHash; }
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_call') return '0x6';
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0xa' };
    if (method === 'eth_blockNumber') return '0xb';
    if (method === 'personal_sign') return payer.signMessage(params[0]);
    throw new Error('Unexpected provider method ' + method);
  } };
  const browser = browserFixture(provider, async (url, options) => {
    if (url === '/api/paywalls/chain-readiness') return { ok: true, json: async () => ({ ready: true }) };
    if (url.endsWith('/download') && !options) return { status: 402, json: async () => ({ challenge: { price: '1.500001', token: 'USDC', recipient: creator.address, chainId: 4663 } }) };
    if (url === '/facilitator/supported') return { json: async () => ({ demoMode: false, supportedTokens: [config.supportedTokens.USDC] }) };
    return { status: 200, ok: true, blob: async () => new Blob(['paid']) };
  });
  vm.runInContext('state.currentWallet = ' + JSON.stringify({ address: payer.address, isRealWeb3: true }) + ';state.currentPaywall = ' + JSON.stringify({ paywallId: 'test', price: '1.500001', currency: 'USDC', creatorAddress: creator.address, asset: { originalName: 'test.txt' } }), browser.context);
  await vm.runInContext('handleUnlockPayment()', browser.context);
  await vm.runInContext('handleUnlockPayment()', browser.context);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].to, config.supportedTokens.USDC.address);
  assert.equal(transactions[0].value, '0x0');
  assert.equal(BigInt('0x' + transactions[0].data.slice(-64)), 1500001n);
  assert.equal(transactions[0].data.slice(10,74), creator.address.slice(2).toLowerCase().padStart(64, '0'));
  URL.revokeObjectURL(vm.runInContext('state.downloadBlobUrl', browser.context));
});

test('browser: unavailable content never sends a transaction', async () => {
  let transfers = 0;
  const browser = browserFixture({ request: async ({ method }) => {
    if (method === 'eth_requestAccounts') return [payer.address];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_sendTransaction') transfers++;
  } }, async url => {
    if (url === '/api/paywalls/chain-readiness') return { ok: true, json: async () => ({ ready: true }) };
    return { status: 500 };
  });
  vm.runInContext('state.currentWallet = { isRealWeb3: true }; state.currentPaywall = { paywallId: "unavailable" }', browser.context);
  await vm.runInContext('handleUnlockPayment()', browser.context);
  assert.equal(transfers, 0);
  assert.equal(browser.document.getElementById('appNoticeMsg').textContent, 'Content is unavailable; no payment was sent');
});

test('browser: an unavailable Privy bridge falls back to the browser wallet', async () => {
  let connections = 0;
  const browser = browserFixture({ request: async ({ method }) => {
    if (method === 'eth_requestAccounts') { connections++; return [payer.address]; }
    if (method === 'eth_chainId') return '0x1237';
  } }, async () => ({ json: async () => ({}) }));
  vm.runInContext('window.initPrivyBridge = async () => {}; updateWalletUI = () => {};', browser.context);
  await vm.runInContext('triggerPrivyLogin()', browser.context);
  assert.equal(connections, 1);
  assert.equal(vm.runInContext('state.currentWallet.address', browser.context), payer.address);
});

test('browser: adding a chain without switching to it fails closed', async () => {
  const browser = browserFixture({ request: async ({ method }) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'wallet_switchEthereumChain') throw Object.assign(new Error('Unknown chain'), { code: 4902 });
    if (method === 'wallet_addEthereumChain') return null;
  } }, async () => {});
  assert.equal(await vm.runInContext('ensureRobinhoodNetwork()', browser.context), false);
});

for (const invalidToken of ['undeployed', 'wrong decimals']) {
  test('browser: ' + invalidToken + ' token cannot send a transfer', async () => {
    let transfers = 0;
    const browser = browserFixture({ request: async ({ method }) => {
      if (method === 'eth_requestAccounts') return [payer.address];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getCode') return invalidToken === 'undeployed' ? '0x' : '0x6000';
      if (method === 'eth_call') return '0x12';
      if (method === 'eth_sendTransaction') transfers++;
    } }, async url => {
      if (url === '/facilitator/supported') return { json: async () => ({ demoMode: false, supportedTokens: [config.supportedTokens.USDC] }) };
      return { status: 402, json: async () => ({ challenge: { price: '1', token: 'USDC', recipient: creator.address, chainId: 4663 } }) };
    });
    vm.runInContext('state.currentWallet = { isRealWeb3: true }; state.currentPaywall = ' + JSON.stringify({ paywallId: 'bad-token', price: '1', currency: 'USDC', creatorAddress: creator.address }), browser.context);
    await vm.runInContext('handleUnlockPayment()', browser.context);
    assert.equal(transfers, 0);
    assert.match(browser.document.getElementById('appNoticeMsg').textContent, /no payment was sent/);
  });
}
