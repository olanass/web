const serviceUiState = {
  network: null, category: '', searchTimer: null, currentService: null,
  logoDataUrl: '', logoHash: '', openapiDocument: null, openapiHash: ''
};

function escapeServiceHtml(value) {
  const element = document.createElement('span');
  element.textContent = String(value ?? '');
  return element.innerHTML;
}

function shortNumber(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat(undefined, { notation: number >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(number);
}

function serviceInitial(name) { return (String(name || 'A').trim()[0] || 'A').toUpperCase(); }

async function copyServiceText(value, button) {
  await navigator.clipboard.writeText(value);
  if (!button) return;
  const original = button.textContent;
  button.textContent = 'Copied!';
  setTimeout(() => { button.textContent = original; }, 1600);
}

function initServiceLaunchpad() {
  loadServiceNetwork();
  const previewInputs = ['serviceName', 'serviceDescription', 'serviceCategory', 'servicePrice', 'serviceCurrency'];
  for (const id of previewInputs) document.getElementById(id)?.addEventListener('input', updateServicePreview);
  document.getElementById('btnHeroStart')?.addEventListener('click', () => document.getElementById('launchBuilder')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  document.getElementById('btnHeroExplore')?.addEventListener('click', () => switchView('marketplace'));
  document.getElementById('btnMarketLaunch')?.addEventListener('click', () => switchView('service-launch'));
  document.getElementById('btnLaunchNewService')?.addEventListener('click', () => switchView('service-launch'));
  document.getElementById('btnPublishService')?.addEventListener('click', handlePublishService);
  document.getElementById('btnChooseServiceLogo')?.addEventListener('click', () => document.getElementById('serviceLogoInput').click());
  document.getElementById('serviceLogoInput')?.addEventListener('change', event => handleServiceLogo(event.target.files?.[0]));
  document.getElementById('btnRemoveServiceLogo')?.addEventListener('click', clearServiceLogo);
  document.getElementById('btnChooseServiceOpenApi')?.addEventListener('click', () => document.getElementById('serviceOpenApiInput').click());
  document.getElementById('serviceOpenApiInput')?.addEventListener('change', event => handleServiceOpenApi(event.target.files?.[0]));
  document.getElementById('btnRemoveServiceOpenApi')?.addEventListener('click', clearServiceOpenApi);
  document.getElementById('btnServiceBack')?.addEventListener('click', () => { history.pushState(null, '', '/'); switchView('marketplace'); });
  document.getElementById('btnCopyServiceUrl')?.addEventListener('click', event => copyServiceText(document.getElementById('serviceSuccessUrl').textContent, event.currentTarget));
  document.getElementById('btnCopyDetailEndpoint')?.addEventListener('click', event => copyServiceText(serviceUiState.currentService?.gatewayUrl || '', event.currentTarget));
  document.getElementById('btnCopyCurl')?.addEventListener('click', event => copyServiceText(document.getElementById('detailCurl').textContent, event.currentTarget));
  document.getElementById('btnCopyAgentCode')?.addEventListener('click', event => copyServiceText(document.getElementById('detailAgentCode').textContent, event.currentTarget));
  document.getElementById('btnRunService')?.addEventListener('click', () => {
    if (serviceUiState.currentService?.billingMode === 'metered') {
      document.getElementById('detailAgentCode')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const slug = serviceUiState.currentService?.slug;
    history.pushState(null, '', slug ? `/payments?service=${encodeURIComponent(slug)}` : '/payments');
    switchView('payments');
    if (slug) selectPaymentService(slug);
  });
  document.getElementById('serviceProjectsTableBody')?.addEventListener('click', handleServiceManagement);

  document.getElementById('serviceSearch')?.addEventListener('input', () => {
    clearTimeout(serviceUiState.searchTimer);
    serviceUiState.searchTimer = setTimeout(loadServiceMarketplace, 250);
  });
  document.getElementById('marketFilters')?.addEventListener('click', event => {
    const button = event.target.closest('button[data-category]');
    if (!button) return;
    document.querySelectorAll('#marketFilters button').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    serviceUiState.category = button.dataset.category;
    loadServiceMarketplace();
  });
  document.getElementById('serviceMarketGrid')?.addEventListener('click', event => {
    const card = event.target.closest('[data-service-slug]');
    if (card) openServicePage(card.dataset.serviceSlug);
  });
  updateServicePreview();
}

async function loadServiceNetwork() {
  try {
    const response = await fetch('/api/services/networks', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.networks?.[0]) throw new Error(data.error || 'Network unavailable');
    serviceUiState.network = data.networks[0];
    document.getElementById('serviceNetworkName').textContent = serviceUiState.network.name;
    document.getElementById('serviceNetworkMeta').textContent = `Chain ID ${serviceUiState.network.chainId} · Direct to your wallet`;
    const currency = document.getElementById('serviceCurrency');
    currency.replaceChildren(...serviceUiState.network.tokens.map(token => new Option(token.symbol, token.symbol)));
    if ([...currency.options].some(option => option.value === 'USDG')) currency.value = 'USDG';
    updateServicePreview();
  } catch (error) {
    document.getElementById('btnPublishService').disabled = true;
    document.getElementById('serviceNetworkMeta').textContent = 'Network configuration unavailable';
  }
}

function updateServicePreview() {
  const name = document.getElementById('serviceName')?.value.trim() || 'API';
  const uploadPreview = document.getElementById('serviceLogoPreview');
  if (uploadPreview && !serviceUiState.logoDataUrl) uploadPreview.textContent = serviceInitial(name);
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Logo could not be read'));
    reader.readAsDataURL(file);
  });
}

async function handleServiceLogo(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 512 * 1024) {
    showAppNotice({ title: 'Logo not accepted', message: 'Choose a PNG, JPEG, or WebP image no larger than 512 KB.', type: 'warning' });
    return;
  }
  try {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    serviceUiState.logoHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    serviceUiState.logoDataUrl = await fileAsDataUrl(file);
    const preview = document.getElementById('serviceLogoPreview');
    preview.innerHTML = `<img src="${serviceUiState.logoDataUrl}" alt="Selected API logo">`;
    document.getElementById('btnRemoveServiceLogo').hidden = false;
    updateServicePreview();
  } catch (error) { showAppNotice({ title: 'Logo upload failed', message: error.message, type: 'error' }); }
}

function clearServiceLogo() {
  serviceUiState.logoDataUrl = '';
  serviceUiState.logoHash = '';
  const input = document.getElementById('serviceLogoInput');
  if (input) input.value = '';
  document.getElementById('btnRemoveServiceLogo').hidden = true;
  const preview = document.getElementById('serviceLogoPreview');
  preview.replaceChildren();
  updateServicePreview();
}

async function handleServiceOpenApi(file) {
  if (!file) return;
  if (file.size > 256 * 1024) {
    showAppNotice({ title: 'Schema is too large', message: 'Choose an OpenAPI JSON file no larger than 256 KB.', type: 'warning' });
    return;
  }
  try {
    const source = await file.text();
    const spec = JSON.parse(source);
    if (!spec || typeof spec !== 'object' || !/^3\.(0|1)\./.test(spec.openapi || '') || !spec.paths) {
      throw new Error('OpenAPI 3.0 or 3.1 JSON document required');
    }
    const canonical = JSON.stringify(spec);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    serviceUiState.openapiHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    serviceUiState.openapiDocument = spec;
    document.getElementById('serviceOpenApiName').textContent = file.name;
    document.getElementById('btnRemoveServiceOpenApi').hidden = false;
  } catch (error) {
    showAppNotice({ title: 'Schema not accepted', message: error.message, type: 'error' });
  }
}

function clearServiceOpenApi() {
  serviceUiState.openapiDocument = null;
  serviceUiState.openapiHash = '';
  const input = document.getElementById('serviceOpenApiInput');
  if (input) input.value = '';
  document.getElementById('serviceOpenApiName').textContent = 'Add openapi.json';
  document.getElementById('btnRemoveServiceOpenApi').hidden = true;
}

async function serviceSigningProvider() {
  if (state.currentWallet?.isRealWeb3 && window.ethereum) return window.ethereum;
  if (window.__privy && typeof window.__privy.getProvider === 'function') {
    try { return await window.__privy.getProvider(); } catch (_) { /* fall through */ }
  }
  return window.ethereum || null;
}

async function handlePublishService() {
  if (!state.currentWallet) { triggerPrivyLogin(); return; }
  const endpointInput = document.getElementById('serviceEndpoint').value.trim();
  const name = document.getElementById('serviceName').value.trim();
  const description = document.getElementById('serviceDescription').value.trim();
  const category = document.getElementById('serviceCategory').value;
  const videoInput = document.getElementById('serviceVideoUrl').value.trim();
  const price = document.getElementById('servicePrice').value.trim();
  const currency = document.getElementById('serviceCurrency').value;
  const allowedMethods = [...document.querySelectorAll('input[name="serviceMethod"]:checked')].map(input => input.value).sort();
  let endpointUrl;
  let videoUrl = '';
  try { endpointUrl = new URL(endpointInput).toString(); }
  catch (_) { showAppNotice({ title: 'Valid endpoint required', message: 'Enter a complete HTTP or HTTPS API URL.', type: 'warning' }); return; }
  if (videoInput) {
    try {
      const parsedVideo = new URL(videoInput);
      if (!['http:', 'https:'].includes(parsedVideo.protocol)) throw new Error('Unsupported protocol');
      videoUrl = parsedVideo.toString();
    } catch (_) { showAppNotice({ title: 'Valid video link required', message: 'Use a complete HTTP or HTTPS video URL.', type: 'warning' }); return; }
  }
  if (!name || !description || !/^\d+(\.\d+)?$/.test(price) || Number(price) <= 0 || !allowedMethods.length) {
    showAppNotice({ title: 'Complete your launch details', message: 'Add a name, description, positive price, and at least one HTTP method.', type: 'warning' }); return;
  }
  if (!serviceUiState.network) { showAppNotice({ title: 'Network unavailable', message: 'Robinhood Chain configuration could not be loaded.', type: 'error' }); return; }

  const button = document.getElementById('btnPublishService');
  button.disabled = true;
  button.querySelector('span').textContent = 'Preparing signature...';
  try {
    const provider = await serviceSigningProvider();
    if (!provider) throw new Error('Connect a wallet to launch your API');
    if (!await ensureRobinhoodNetwork(provider)) throw new Error(`Switch to ${ROBINHOOD_CHAIN_NAME} to continue`);
    await provider.request({ method: 'eth_requestAccounts' });
    const creatorAddress = state.currentWallet.address;
    const creatorTimestamp = String(Date.now());
    const orderedPayload = {
      name, description, category, videoUrl, logoHash: serviceUiState.logoHash, openapiHash: serviceUiState.openapiHash,
      endpointUrl, allowedMethods, price, currency,
      creatorAddress: creatorAddress.toLowerCase(), payoutAddress: creatorAddress.toLowerCase(),
      network: serviceUiState.network.id, chainId: serviceUiState.network.chainId, timestamp: creatorTimestamp
    };
    button.querySelector('span').textContent = 'Confirm in your wallet...';
    const creatorSignature = await provider.request({ method: 'personal_sign', params: ['x402 launch service\n' + JSON.stringify(orderedPayload), creatorAddress] });
    button.querySelector('span').textContent = 'Launching your API...';
    const response = await fetch('/api/services', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...orderedPayload, logoDataUrl: serviceUiState.logoDataUrl, openapiDocument: serviceUiState.openapiDocument,
        creatorAddress, payoutAddress: creatorAddress, creatorTimestamp, creatorSignature
      })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'The service could not be launched');
    document.getElementById('serviceSuccess').hidden = false;
    document.getElementById('serviceSuccessName').textContent = `${data.service.name} is live`;
    document.getElementById('serviceSuccessUrl').textContent = data.service.gatewayUrl;
    document.getElementById('serviceSuccessPage').href = `/services/${encodeURIComponent(data.service.slug)}`;
    document.getElementById('serviceSuccess').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    showAppNotice({ title: 'API launch failed', message: error.message, type: 'error' });
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Sign & launch API';
  }
}

async function loadServiceMarketplace() {
  const grid = document.getElementById('serviceMarketGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="market-loading">Loading the launchpad...</div>';
  try {
    const params = new URLSearchParams({ status: 'live', limit: '60' });
    const search = document.getElementById('serviceSearch')?.value.trim();
    if (search) params.set('search', search);
    if (serviceUiState.category) params.set('category', serviceUiState.category);
    const response = await fetch('/api/services?' + params.toString(), { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load services');
    if (!data.services.length) {
      grid.innerHTML = '<div class="market-empty"><strong>No APIs here yet.</strong><br>Be the first developer to launch one.</div>';
      return;
    }
    grid.innerHTML = data.services.map(service => `
      <article class="api-product-card" data-service-slug="${escapeServiceHtml(service.slug)}" tabindex="0">
        <div class="product-card-top"><span class="product-category">${escapeServiceHtml(service.category)}</span><span class="product-live"><i></i> ${escapeServiceHtml(service.status)}</span></div>
        <div class="product-icon">${service.logoUrl ? `<img src="${escapeServiceHtml(service.logoUrl)}" alt="${escapeServiceHtml(service.name)} logo">` : escapeServiceHtml(serviceInitial(service.name))}</div>
        <h3>${escapeServiceHtml(service.name)}</h3><p>${escapeServiceHtml(service.description || 'A paid API on Robinhood Chain.')}</p>
        <div class="product-metrics"><div><span>Price</span><strong>${escapeServiceHtml(service.billingMode === 'metered' ? 'Usage-based' : service.price)} ${escapeServiceHtml(service.currency)}</strong><small>${service.billingMode === 'metered' ? 'actual model cost' : '/ request'}</small></div><div><span>Paid calls</span><strong>${service.billingMode === 'metered' ? '—' : shortNumber(service.requests)}</strong><small>${escapeServiceHtml(service.currency)}</small></div></div>
        <div class="product-card-foot"><span><i></i> Robinhood Chain</span><span class="market-card-requests">View API ↗</span></div>
      </article>`).join('');
  } catch (error) { grid.innerHTML = `<div class="market-empty">${escapeServiceHtml(error.message)}</div>`; }
}

function openServicePage(slug) {
  history.pushState(null, '', `/services/${encodeURIComponent(slug)}`);
  loadServiceDetail(slug);
}

async function loadServiceDetail(slug) {
  switchView('service-detail');
  try {
    const response = await fetch('/api/services/' + encodeURIComponent(slug), { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Service not found');
    const service = data.service;
    serviceUiState.currentService = service;
    document.getElementById('detailCategory').textContent = service.category;
    document.getElementById('detailStatus').textContent = service.status;
    document.getElementById('detailStatus').parentElement.dataset.status = service.status;
    const detailIcon = document.getElementById('detailIcon');
    if (service.logoUrl) detailIcon.innerHTML = `<img src="${escapeServiceHtml(service.logoUrl)}" alt="${escapeServiceHtml(service.name)} logo">`;
    else detailIcon.textContent = serviceInitial(service.name);
    document.getElementById('detailName').textContent = service.name;
    document.getElementById('detailDescription').textContent = service.description;
    document.getElementById('detailPrice').textContent = service.billingMode === 'metered' ? 'Usage-based' : service.price;
    document.getElementById('btnRunService').textContent = service.billingMode === 'metered' ? 'Use with agent wallet' : 'Run API';
    document.getElementById('detailNetwork').textContent = ROBINHOOD_CHAIN_NAME.replace(' Chain', '');
    document.getElementById('detailToken').textContent = service.currency;
    document.getElementById('detailRequests').textContent = Number(service.requests || 0).toLocaleString();
    document.getElementById('detailRevenue').textContent = service.revenueUsd == null ? `${service.revenue} ${service.currency}` : `$${Number(service.revenueUsd).toFixed(2)}`;
    document.getElementById('detailEndpoint').textContent = service.gatewayUrl;
    document.getElementById('detailMethods').innerHTML = service.allowedMethods.map(method => `<span>${escapeServiceHtml(method)}</span>`).join('');
    const videoLink = document.getElementById('detailVideoLink');
    videoLink.hidden = !service.videoUrl;
    if (service.videoUrl) videoLink.href = service.videoUrl;
    const openapiLink = document.getElementById('detailOpenApiLink');
    openapiLink.hidden = !service.openapiUrl;
    if (service.openapiUrl) openapiLink.href = service.openapiUrl;
    if (service.billingMode === 'metered') {
      document.getElementById('detailRequests').textContent = 'Reported by service';
      document.getElementById('detailRevenue').textContent = 'Reported by service';
      document.getElementById('detailCurl').textContent = 'Read model rates: ' + service.metered.modelsUrl;
      document.getElementById('detailAgentCode').textContent = 'Configure the Olanas wallet with:\nPAYMENTS_INFERENCE_URL=' + new URL(service.gatewayUrl).origin + '\nPAYMENTS_INFERENCE_RECEIVER=' + service.payoutAddress + '\n\nEnable USDG spending limits, then use list_ai_models and use_ai_model. The wallet authorizes a maximum; the service charges actual reported model cost. Refund unused escrow with refund_ai_escrow.';
      return;
    }
    const method = service.allowedMethods.includes('POST') ? 'POST' : service.allowedMethods[0];
    const body = method === 'GET' ? '' : [
      ' \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"input":"hello"}\''
    ].join('\n');
    document.getElementById('detailCurl').textContent = `curl -i -X ${method} "${service.gatewayUrl}"${body}`;
    document.getElementById('detailAgentCode').textContent =
      `const { OlanasAgent } = require("./sdk");\n\nconst agent = new OlanasAgent({\n  signer,\n  allowedServices: ["${service.slug}"],\n  allowedTokens: ["${service.currency}"],\n  maxPricePerCall: { ${service.currency}: "${service.price}" },\n  dailyBudget: { ${service.currency}: "1.00" },\n  approvePayment: policy.approve\n});\n\nconst result = await agent.call("${service.slug}", {\n  method: "${method}",\n  body: { input: "hello" }\n});`;
  } catch (error) { showAppNotice({ title: 'Service unavailable', message: error.message, type: 'error' }); }
}

async function fetchMyServices() {
  const tbody = document.getElementById('serviceProjectsTableBody');
  if (!tbody) return;
  if (!state.currentWallet) { tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:32px">Connect your wallet to view API services.</td></tr>'; return; }
  try {
    const response = await fetch(`/api/services/creator/${state.currentWallet.address}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load services');
    if (!data.services.length) { tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:32px">No API services yet. Launch your first endpoint.</td></tr>'; return; }
    tbody.innerHTML = data.services.map(service => `<tr><td><strong>${escapeServiceHtml(service.name)}</strong><div style="font-size:11px;color:var(--text-muted)">${escapeServiceHtml(service.description)}</div></td><td><strong>${escapeServiceHtml(service.billingMode === 'metered' ? 'Usage-based' : service.price)} ${escapeServiceHtml(service.currency)}</strong></td><td>${Number(service.requests || 0).toLocaleString()}</td><td class="text-success"><strong>${escapeServiceHtml(service.revenue)} ${escapeServiceHtml(service.currency)}</strong></td><td><span class="status-live-pill">${escapeServiceHtml(service.status)}</span></td><td><a href="/services/${encodeURIComponent(service.slug)}" class="btn btn-secondary btn-sm">View ↗</a></td></tr>`).join('');
    [...tbody.querySelectorAll('tr')].forEach((row, index) => {
      const service = data.services[index];
      const cell = row.lastElementChild;
      cell.insertAdjacentHTML('beforeend', ` <button type='button' class='btn btn-secondary btn-sm' data-service-action='toggle' data-service-slug='${escapeServiceHtml(service.slug)}' data-service-status='${escapeServiceHtml(service.status)}'>${service.status === 'live' ? 'Pause' : 'Resume'}</button> <button type='button' class='btn btn-secondary btn-sm text-danger' data-service-action='delete' data-service-slug='${escapeServiceHtml(service.slug)}'>Delete</button>`);
    });
  } catch (error) { tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger" style="padding:24px">${escapeServiceHtml(error.message)}</td></tr>`; }
}

async function handleServiceManagement(event) {
  const button = event.target.closest('button[data-service-action]');
  if (!button || !state.currentWallet) return;
  const action = button.dataset.serviceAction;
  const slug = button.dataset.serviceSlug;
  if (action === 'delete' && !confirm('Delete this API listing permanently?')) return;
  const changes = action === 'toggle' ? { status: button.dataset.serviceStatus === 'live' ? 'paused' : 'live' } : {};
  const requestAction = action === 'delete' ? 'delete' : 'update';
  const creatorTimestamp = String(Date.now());
  try {
    const provider = await serviceSigningProvider();
    if (!provider) throw new Error('Connect the creator wallet first');
    const message = 'x402 manage service\n' + JSON.stringify({ action: requestAction, slug, changes, timestamp: creatorTimestamp });
    const creatorSignature = await provider.request({ method: 'personal_sign', params: [message, state.currentWallet.address] });
    button.disabled = true;
    const response = await fetch('/api/services/' + encodeURIComponent(slug), {
      method: action === 'delete' ? 'DELETE' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes, creatorTimestamp, creatorSignature })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Service could not be updated');
    await fetchMyServices();
    loadServiceMarketplace();
  } catch (error) {
    button.disabled = false;
    showAppNotice({ title: 'Service update failed', message: error.message, type: 'error' });
  }
}
