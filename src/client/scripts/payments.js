'use strict';

const PAYMENT_HISTORY_KEY = 'olanas_browser_payment_history_v1';
const PAYMENT_PENDING_KEY = 'olanas_browser_pending_payment_v1';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const paymentConsoleState = {
  services: [], network: null, loading: null, selected: null,
  prepared: null, pending: null, requestedSlug: ''
};

function paymentEscape(value) {
  const element = document.createElement('span');
  element.textContent = String(value ?? '');
  return element.innerHTML;
}

function paymentShortAddress(value) {
  const address = String(value || '');
  return address.length === 42 ? `${address.slice(0, 8)}...${address.slice(-6)}` : address;
}

function paymentSafePath(value = '') {
  const path = String(value || '').trim();
  if (!path) return '';
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.includes('..')) {
    throw new Error('The API path must be relative and cannot contain traversal');
  }
  return '/' + path.replace(/^\/+/, '');
}

function paymentDecimalToUnits(value, decimals) {
  const match = String(value).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2] || '').length > decimals) throw new Error('The service price has invalid precision');
  return BigInt(match[1] + (match[2] || '').padEnd(decimals, '0'));
}

function paymentFormatUnits(value, decimals) {
  if (!decimals) return BigInt(value).toString();
  const digits = BigInt(value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals) || '0';
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return fraction ? `${whole}.${fraction}` : whole;
}

function paymentDecodeHeader(value) {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) { return null; }
}

function paymentEncodeProof(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function normalizePaymentRequirement(challenge, network, service) {
  const accepted = challenge?.accepts?.find(option => option?.scheme === 'onchain-tx');
  if (!accepted) throw new Error('This API did not offer a supported on-chain payment');
  if (!network || accepted.network !== network.caip2) throw new Error('The payment challenge uses an unexpected network');
  const tokenName = String(accepted.extra?.name || '').toUpperCase();
  const token = network.tokens?.find(item => String(item.symbol).toUpperCase() === tokenName);
  if (!token || tokenName !== String(service.currency).toUpperCase()) throw new Error('The payment challenge uses an unexpected token');
  if (!/^\d+$/.test(String(accepted.amount || '')) || BigInt(accepted.amount) <= 0n) throw new Error('The payment challenge has an invalid amount');
  if (!/^0x[0-9a-f]{40}$/i.test(accepted.payTo || '') || accepted.payTo.toLowerCase() !== service.payoutAddress.toLowerCase()) {
    throw new Error('The payment recipient does not match the selected API');
  }
  const expectedAsset = token.address || ZERO_ADDRESS;
  if (!/^0x[0-9a-f]{40}$/i.test(accepted.asset || '') || accepted.asset.toLowerCase() !== expectedAsset.toLowerCase()) {
    throw new Error('The payment asset does not match the selected API');
  }
  const expectedAmount = paymentDecimalToUnits(service.price, token.decimals);
  if (BigInt(accepted.amount) !== expectedAmount) throw new Error('The payment amount does not match the listed API price');
  return {
    token: token.symbol, tokenAddress: token.address || '', decimals: token.decimals,
    amount: String(accepted.amount), formattedAmount: paymentFormatUnits(accepted.amount, token.decimals),
    payTo: accepted.payTo, network: accepted.network, chainId: network.chainId
  };
}

function createPaymentTransaction(requirement, payer) {
  const base = { from: payer };
  if (!requirement.tokenAddress) return { ...base, to: requirement.payTo, value: '0x' + BigInt(requirement.amount).toString(16) };
  const recipient = requirement.payTo.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const amount = BigInt(requirement.amount).toString(16).padStart(64, '0');
  return { ...base, to: requirement.tokenAddress, value: '0x0', data: '0xa9059cbb' + recipient + amount };
}

function paymentRequestFromForm() {
  const service = paymentConsoleState.services.find(item => item.slug === document.getElementById('paymentService')?.value);
  if (!service) throw new Error('Choose a live API first');
  const method = String(document.getElementById('paymentMethod')?.value || 'POST').toUpperCase();
  if (!service.allowedMethods.includes(method)) throw new Error('That method is not enabled for this API');
  const path = paymentSafePath(document.getElementById('paymentPath')?.value || '');
  const rawBody = document.getElementById('paymentBody')?.value.trim() || '';
  let body;
  if (!['GET', 'HEAD'].includes(method) && rawBody) {
    try { body = JSON.parse(rawBody); }
    catch (_) { throw new Error('Request body must be valid JSON'); }
  }
  const fingerprint = JSON.stringify({ slug: service.slug, method, path, body: body ?? null });
  return { service, method, path, body, rawBody, fingerprint };
}

function paymentRequestOptions(request, proof) {
  const headers = { accept: 'application/json' };
  let body;
  if (request.body !== undefined && !['GET', 'HEAD'].includes(request.method)) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(request.body);
  }
  if (proof) headers['payment-signature'] = paymentEncodeProof(proof);
  return { method: request.method, headers, body };
}

function paymentEndpoint(request) {
  return `/x402/${encodeURIComponent(request.service.slug)}${request.path}`;
}

function paymentSetStatus(label, stateName = 'idle') {
  const badge = document.getElementById('paymentStatusBadge');
  if (!badge) return;
  badge.textContent = label;
  badge.dataset.state = stateName;
}

function paymentSetStep(step, stateName) {
  document.querySelector(`#paymentSteps [data-step="${step}"]`)?.setAttribute('data-state', stateName);
}

function paymentResetSteps() {
  document.querySelectorAll('#paymentSteps li').forEach(item => item.removeAttribute('data-state'));
}

function paymentShowResult(value, metadata = '') {
  const target = document.getElementById('paymentResultBody');
  if (target) target.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const meta = document.getElementById('paymentResultMeta');
  if (meta) meta.textContent = metadata;
}

function paymentButton(label, disabled = false) {
  const button = document.getElementById('btnRunPayment');
  if (!button) return;
  button.disabled = disabled;
  const text = button.querySelector('span');
  if (text) text.textContent = label;
}

function paymentPersistPending(pending) {
  paymentConsoleState.pending = pending;
  if (pending) sessionStorage.setItem(PAYMENT_PENDING_KEY, JSON.stringify(pending));
  else sessionStorage.removeItem(PAYMENT_PENDING_KEY);
  const retry = document.getElementById('btnRetryPayment');
  if (retry) retry.hidden = !pending;
}

function paymentReadHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(PAYMENT_HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, 20) : [];
  } catch (_) { return []; }
}

function paymentRenderHistory() {
  const container = document.getElementById('paymentHistory');
  if (!container) return;
  const historyItems = paymentReadHistory();
  if (!historyItems.length) {
    container.innerHTML = '<p>No paid API calls from this browser yet.</p>';
    return;
  }
  container.innerHTML = historyItems.map(item => `
    <article>
      <div><span>${paymentEscape(item.serviceName)}</span><small>${paymentEscape(new Date(item.createdAt).toLocaleString())}</small></div>
      <strong>${paymentEscape(item.amount)} ${paymentEscape(item.token)}</strong>
      <code title="${paymentEscape(item.txHash)}">${paymentEscape(paymentShortAddress(item.txHash))}</code>
      <b data-state="${paymentEscape(item.ok ? 'success' : 'error')}">${paymentEscape(item.status)}</b>
    </article>`).join('');
}

function paymentRecordHistory(entry) {
  const historyItems = paymentReadHistory().filter(item => item.txHash !== entry.txHash);
  historyItems.unshift(entry);
  localStorage.setItem(PAYMENT_HISTORY_KEY, JSON.stringify(historyItems.slice(0, 20)));
  paymentRenderHistory();
}

function updatePaymentSelection() {
  const select = document.getElementById('paymentService');
  const service = paymentConsoleState.services.find(item => item.slug === select?.value) || null;
  paymentConsoleState.selected = service;
  paymentConsoleState.prepared = null;
  paymentResetSteps();
  paymentSetStatus('Ready', 'idle');
  paymentButton(state.currentWallet ? 'Review payment' : 'Connect wallet & review');
  const methods = document.getElementById('paymentMethod');
  if (methods) methods.innerHTML = service
    ? service.allowedMethods.map(method => `<option value="${paymentEscape(method)}">${paymentEscape(method)}</option>`).join('')
    : '<option value="POST">POST</option>';
  document.getElementById('paymentQuotePrice').textContent = service ? `${service.price} ${service.currency}` : 'Select an API';
  document.getElementById('paymentQuoteToken').textContent = service ? ROBINHOOD_CHAIN_NAME : '--';
  document.getElementById('paymentQuoteRecipient').textContent = service ? paymentShortAddress(service.payoutAddress) : '--';
  if (service && paymentConsoleState.pending?.slug === service.slug) {
    if (methods && service.allowedMethods.includes(paymentConsoleState.pending.method)) methods.value = paymentConsoleState.pending.method;
    paymentSetStatus('Payment pending', 'review');
    paymentButton('Retry same payment');
    const retry = document.getElementById('btnRetryPayment');
    if (retry) retry.hidden = false;
  }
}

function selectPaymentService(slug) {
  paymentConsoleState.requestedSlug = slug;
  const select = document.getElementById('paymentService');
  if (!select || !paymentConsoleState.services.some(item => item.slug === slug)) return;
  select.value = slug;
  updatePaymentSelection();
}

async function loadPaymentServices() {
  if (paymentConsoleState.loading) return paymentConsoleState.loading;
  if (paymentConsoleState.services.length) return paymentConsoleState.services;
  paymentConsoleState.loading = (async () => {
    const [serviceResponse, networkResponse] = await Promise.all([
      fetch('/api/services?status=live&limit=100', { cache: 'no-store' }),
      fetch('/api/services/networks', { cache: 'no-store' })
    ]);
    const services = await serviceResponse.json();
    const networks = await networkResponse.json();
    if (!serviceResponse.ok || !services.services) throw new Error(services.error || 'Could not load live APIs');
    if (!networkResponse.ok || !networks.networks?.[0]) throw new Error(networks.error || 'Could not load the payment network');
    services.services = services.services.filter(service => service.billingMode !== 'metered');
    paymentConsoleState.services = services.services;
    paymentConsoleState.network = networks.networks[0];
    const select = document.getElementById('paymentService');
    if (select) {
      select.innerHTML = services.services.length
        ? services.services.map(service => `<option value="${paymentEscape(service.slug)}">${paymentEscape(service.name)} - ${paymentEscape(service.price)} ${paymentEscape(service.currency)}</option>`).join('')
        : '<option value="">No live APIs available</option>';
    }
    const runnerNetwork = document.getElementById('paymentRunnerNetwork');
    if (runnerNetwork) runnerNetwork.textContent = `${paymentConsoleState.network.name} (${paymentConsoleState.network.chainId})`;
    let requested = paymentConsoleState.requestedSlug;
    try { requested ||= new URLSearchParams(window.location.search || '').get('service') || ''; } catch (_) {}
    if (requested && services.services.some(service => service.slug === requested)) select.value = requested;
    updatePaymentSelection();
    return services.services;
  })().catch(error => {
    const select = document.getElementById('paymentService');
    if (select) select.innerHTML = `<option value="">${paymentEscape(error.message)}</option>`;
    paymentSetStatus('Unavailable', 'error');
    paymentShowResult(error.message);
    return [];
  }).finally(() => { paymentConsoleState.loading = null; });
  return paymentConsoleState.loading;
}

function paymentInvalidateQuote() {
  if (!paymentConsoleState.prepared) return;
  paymentConsoleState.prepared = null;
  paymentResetSteps();
  paymentSetStatus('Changed', 'idle');
  paymentButton(state.currentWallet ? 'Review updated payment' : 'Connect wallet & review');
}

async function paymentReadResponse(response) {
  const text = (await response.text()).slice(0, 100000);
  if (!text) return '';
  try { return JSON.parse(text); } catch (_) { return text; }
}

async function prepareBrowserPayment(request) {
  paymentSetStatus('Getting quote', 'working');
  paymentSetStep('quote', 'working');
  paymentShowResult('Requesting canonical x402 payment requirements...');
  const response = await fetch(paymentEndpoint(request), paymentRequestOptions(request));
  if (response.status !== 402) {
    const body = await paymentReadResponse(response);
    paymentSetStep('quote', response.ok ? 'done' : 'error');
    paymentSetStatus(response.ok ? 'No payment needed' : `HTTP ${response.status}`, response.ok ? 'success' : 'error');
    paymentShowResult(body, `HTTP ${response.status} - the endpoint did not request a payment`);
    return null;
  }
  const body = await response.clone().json().catch(() => null);
  const challenge = paymentDecodeHeader(response.headers.get('payment-required')) || body;
  const requirement = normalizePaymentRequirement(challenge, paymentConsoleState.network, request.service);
  paymentConsoleState.prepared = { request, requirement };
  document.getElementById('paymentQuotePrice').textContent = `${requirement.formattedAmount} ${requirement.token}`;
  document.getElementById('paymentQuoteToken').textContent = paymentConsoleState.network.name;
  document.getElementById('paymentQuoteRecipient').textContent = paymentShortAddress(requirement.payTo);
  paymentSetStep('quote', 'done');
  paymentSetStatus('Review quote', 'review');
  paymentShowResult({
    service: request.service.name, method: request.method, path: request.path || '/',
    amount: requirement.formattedAmount, token: requirement.token,
    recipient: requirement.payTo, network: paymentConsoleState.network.name
  }, 'Review these details, then approve the transaction in your wallet.');
  paymentButton(`Approve ${requirement.formattedAmount} ${requirement.token} in wallet`);
  return paymentConsoleState.prepared;
}

async function paymentWaitForReceipt(provider, txHash) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
    if (receipt) {
      if (BigInt(receipt.status || '0x0') !== 1n) throw new Error('The payment transaction reverted');
      return receipt;
    }
    await new Promise(resolve => setTimeout(resolve, 1800));
  }
  throw new Error('The transaction is still pending. Retry verification after it confirms; do not pay again.');
}

async function submitPaymentProof(pending) {
  const request = {
    service: paymentConsoleState.services.find(item => item.slug === pending.slug),
    method: pending.method, path: pending.path, body: pending.body, fingerprint: pending.fingerprint
  };
  if (!request.service) throw new Error('The paid API is no longer available');
  paymentSetStatus('Verifying', 'working');
  paymentSetStep('verify', 'working');
  paymentButton('Verifying payment...', true);
  const proof = { scheme: 'onchain-tx', txHash: pending.txHash, payer: pending.payer };
  const response = await fetch(paymentEndpoint(request), paymentRequestOptions(request, proof));
  const body = await paymentReadResponse(response);
  if (response.status === 402 || response.status >= 500) {
    paymentSetStep('verify', 'error');
    paymentSetStatus(response.status === 402 ? 'Awaiting indexer' : 'Verification delayed', 'review');
    paymentShowResult(body, `Payment ${paymentShortAddress(pending.txHash)} was already sent. Retry with the same payment; do not pay again.`);
    paymentButton('Retry same payment');
    document.getElementById('btnRetryPayment').hidden = false;
    return false;
  }
  const receipt = paymentDecodeHeader(response.headers.get('payment-response'));
  paymentSetStep('verify', response.ok ? 'done' : 'error');
  paymentSetStatus(response.ok ? 'Complete' : `API HTTP ${response.status}`, response.ok ? 'success' : 'error');
  paymentShowResult(body, `HTTP ${response.status} - transaction ${paymentShortAddress(pending.txHash)}${receipt?.receiptId ? ` - receipt ${receipt.receiptId}` : ''}`);
  paymentRecordHistory({
    serviceName: request.service.name, slug: request.service.slug, amount: pending.amount, token: pending.token,
    txHash: pending.txHash, receiptId: receipt?.receiptId || '', status: response.ok ? 'Completed' : `HTTP ${response.status}`,
    ok: response.ok, createdAt: new Date().toISOString()
  });
  paymentPersistPending(null);
  paymentConsoleState.prepared = null;
  paymentButton('Run another request');
  return true;
}

async function sendBrowserPayment(prepared) {
  let provider = await serviceSigningProvider();
  if (!provider) {
    await triggerPrivyLogin();
    provider = await serviceSigningProvider();
  }
  if (!provider) throw new Error('Connect an EVM wallet to continue');
  if (!await ensureRobinhoodNetwork(provider)) throw new Error(`Switch to ${ROBINHOOD_CHAIN_NAME} to continue`);
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const payer = accounts?.[0] || state.currentWallet?.address;
  if (!/^0x[0-9a-f]{40}$/i.test(payer || '')) throw new Error('The connected wallet did not provide an address');
  if (!state.currentWallet || state.currentWallet.address.toLowerCase() !== payer.toLowerCase()) await setConnectedWallet(payer, 'Web3 Wallet', true);
  paymentSetStatus('Wallet approval', 'working');
  paymentSetStep('approve', 'working');
  paymentButton('Confirm in your wallet...', true);
  const txHash = await provider.request({ method: 'eth_sendTransaction', params: [createPaymentTransaction(prepared.requirement, payer)] });
  if (!/^0x[0-9a-f]{64}$/i.test(txHash || '')) throw new Error('The wallet returned an invalid transaction hash');
  const pending = {
    fingerprint: prepared.request.fingerprint, slug: prepared.request.service.slug,
    method: prepared.request.method, path: prepared.request.path, body: prepared.request.body ?? null,
    txHash, payer, amount: prepared.requirement.formattedAmount, token: prepared.requirement.token,
    createdAt: new Date().toISOString()
  };
  paymentPersistPending(pending);
  paymentShowResult({ transaction: txHash, status: 'Waiting for confirmation' }, 'The payment was submitted. This page will not request a second transfer.');
  await paymentWaitForReceipt(provider, txHash);
  paymentSetStep('approve', 'done');
  return submitPaymentProof(pending);
}

async function handleBrowserPayment(event) {
  event?.preventDefault();
  paymentButton('Checking request...', true);
  try {
    const request = paymentRequestFromForm();
    if (paymentConsoleState.pending) {
      if (paymentConsoleState.pending.fingerprint !== request.fingerprint) {
        throw new Error('A previous payment is awaiting verification. Retry it before starting a different request.');
      }
      await submitPaymentProof(paymentConsoleState.pending);
      return;
    }
    if (!paymentConsoleState.prepared || paymentConsoleState.prepared.request.fingerprint !== request.fingerprint) {
      const prepared = await prepareBrowserPayment(request);
      if (!prepared) paymentButton('Review payment');
      return;
    }
    await sendBrowserPayment(paymentConsoleState.prepared);
  } catch (error) {
    paymentSetStatus('Action needed', 'error');
    paymentShowResult(error.message, paymentConsoleState.pending ? 'A payment may already exist. Use retry; do not create another transfer.' : 'No payment was sent unless your wallet displayed a transaction hash.');
    paymentButton(paymentConsoleState.pending ? 'Retry same payment' : 'Review payment');
    const retry = document.getElementById('btnRetryPayment');
    if (retry) retry.hidden = !paymentConsoleState.pending;
  }
}

function paymentRestorePending() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(PAYMENT_PENDING_KEY) || 'null');
    if (!pending?.txHash || !pending?.slug) return;
    paymentConsoleState.pending = pending;
    paymentConsoleState.requestedSlug = pending.slug;
    document.getElementById('paymentPath').value = pending.path || '';
    document.getElementById('paymentBody').value = pending.body == null ? '' : JSON.stringify(pending.body, null, 2);
    paymentSetStatus('Payment pending', 'review');
    paymentShowResult({ transaction: pending.txHash, status: 'Awaiting verification' }, 'Retry with this payment. Do not send another transaction.');
    document.getElementById('btnRetryPayment').hidden = false;
    paymentButton('Retry same payment');
  } catch (_) { sessionStorage.removeItem(PAYMENT_PENDING_KEY); }
}

function agentWalletInstallCommand(client) {
  if (!['codex', 'claude', 'claude-code'].includes(client)) throw new Error('Choose a supported local AI client');
  return 'npx --yes github:olanass/web#olanas-payments-mcp install --client ' + client + ' --auto-config --network mainnet --launchpad https://olanas.xyz';
}

function initAgentWalletGuide() {
  const client = document.getElementById('agentGuideClient');
  if (!client) return;
  const command = document.getElementById('agentGuideInstall');
  const help = document.getElementById('agentGuideClientHelp');
  const feedback = document.getElementById('agentGuideFeedback');
  const update = () => {
    command.textContent = agentWalletInstallCommand(client.value);
    help.textContent = {
      codex: 'Have the Codex CLI available for automatic registration. If it is not found, the installer prints a manual MCP configuration.',
      claude: 'Install and open Claude Desktop once before setup. The installer updates its local MCP configuration. Fully quit and reopen Claude Desktop afterwards.',
      'claude-code': 'Have the Claude Code CLI available for automatic registration. The installer uses user scope. Start a new Claude Code session afterwards.'
    }[client.value];
  };
  const copy = async (text, success) => {
    try { await navigator.clipboard.writeText(text); feedback.textContent = success; }
    catch (_) { feedback.textContent = 'Clipboard access was blocked. Select and copy the text above manually.'; }
  };
  client.addEventListener('change', update);
  document.getElementById('btnCopyAgentInstall').addEventListener('click', () => copy(command.textContent, 'Install command copied. Review it and run it in your own terminal.'));
  document.getElementById('btnCopyAgentPrompt').addEventListener('click', () => copy(document.getElementById('agentGuidePrompt').textContent, 'Example prompt copied. Review it before asking the agent to purchase.'));
  document.getElementById('btnShareAgentGuide').addEventListener('click', () => copy(new URL('/payments#agent-wallet-guide', location.origin).href, 'Public guide link copied. No private wallet or order token is included.'));
  if (location.hash === '#agent-wallet-guide') {
    document.getElementById('agentGuideInstructions').open = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => document.getElementById('agent-wallet-guide')?.scrollIntoView({ block: 'start' }));
  }
  update();
}

function initPaymentConsole() {
  initAgentWalletGuide();
  const runner = document.getElementById('paymentRunner');
  if (!runner) return;
  runner.addEventListener('submit', handleBrowserPayment);
  document.getElementById('paymentService')?.addEventListener('change', updatePaymentSelection);
  document.getElementById('paymentMethod')?.addEventListener('change', paymentInvalidateQuote);
  document.getElementById('paymentPath')?.addEventListener('input', paymentInvalidateQuote);
  document.getElementById('paymentBody')?.addEventListener('input', paymentInvalidateQuote);
  document.getElementById('btnRetryPayment')?.addEventListener('click', handleBrowserPayment);
  document.getElementById('btnClearPaymentHistory')?.addEventListener('click', () => {
    localStorage.removeItem(PAYMENT_HISTORY_KEY);
    paymentRenderHistory();
  });
  paymentRestorePending();
  paymentRenderHistory();
  loadPaymentServices();
}
