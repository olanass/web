'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function fixture({ blocked = false, hash = '' } = {}) {
  const html = fs.readFileSync(path.join(root, 'src/client/index.html'), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], { textContent: '', value: '', events: {}, addEventListener(type, fn) { this.events[type] = fn; } }]));
  nodes.get('agentGuideClient').value = 'codex';
  nodes.get('agentGuidePrompt').textContent = 'Example request';
  const copied = [];
  const context = vm.createContext({ URL, location: { origin: 'https://example.test', hash },
    document: { getElementById: id => nodes.get(id) },
    navigator: { clipboard: { writeText: async text => { if (blocked) throw Error('blocked'); copied.push(text); } } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/client/scripts/payments.js'), 'utf8'), context);
  vm.runInContext('initAgentWalletGuide()', context);
  return { context, nodes, copied, html };
}
test('agent guide: client commands match installer flags, copy never installs or pays', async () => {
  const f = fixture();
  for (const client of ['codex', 'claude', 'claude-code']) {
    f.nodes.get('agentGuideClient').value = client; f.nodes.get('agentGuideClient').events.change();
    await f.nodes.get('btnCopyAgentInstall').events.click();
    assert.equal(f.copied.at(-1), 'npx --yes github:olanass/olanas-payments-mcp install --client ' + client + ' --auto-config --network mainnet --launchpad https://olanas.xyz');
  }
  assert.throws(() => vm.runInContext('agentWalletInstallCommand("invalid; command")', f.context), /supported local AI client/);
});
test('agent guide: share link drops private fragments and direct guide link opens instructions', async () => {
  const f = fixture({ hash: '#private-order-token' });
  await f.nodes.get('btnShareAgentGuide').events.click();
  assert.equal(f.copied[0], 'https://example.test/payments#agent-wallet-guide');
  assert.equal(fixture({ hash: '#agent-wallet-guide' }).nodes.get('agentGuideInstructions').open, true);
});
test('agent guide: clipboard denial explains manual copy; release and safety notes remain visible', async () => {
  const f = fixture({ blocked: true });
  await f.nodes.get('btnCopyAgentPrompt').events.click();
  assert.match(f.nodes.get('agentGuideFeedback').textContent, /manually/);
  assert.match(f.html, /Release preview:/); assert.match(f.html, /Never paste a private key/);
  assert.match(f.html, /id="paymentRunner"/); // Existing browser workflow is retained.
  assert.match(f.html, /id="agentGuideInstructions">/); // Collapsed by default.
});
