// -------------------------------------------------------------
// 8. MY PAYWALLED LINKS
// -------------------------------------------------------------
async function fetchMyLinks() {
  const tbody = document.getElementById('myLinksTableBody');
  if (!state.currentWallet) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-muted" style="padding: 32px;">
          Please connect your wallet to view your paywalled links.
        </td>
      </tr>
    `;
    return;
  }

  try {
    const res = await fetch(`/api/paywalls/creator/${state.currentWallet.address}`);
    const data = await res.json();

    if (!data.paywalls || data.paywalls.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted" style="padding: 32px;">
            No paywalls created yet with this wallet. Click "Create Paywall" to launch your first one!
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = data.paywalls.map(p => {
      const shareUrl = `${window.location.origin}/p/${encodeURIComponent(p.paywallId)}`;
      const dateStr = new Date(p.createdAt).toLocaleDateString();

      return `
        <tr>
          <td>
            <strong>${escapeHtml(p.title)}</strong>
            <div class="project-description">${escapeHtml(p.asset.originalName)} (${escapeHtml(p.asset.formattedSize)})</div>
          </td>
          <td class="project-value"><strong>${escapeHtml(p.price)} ${escapeHtml(p.currency)}</strong></td>
          <td>${p.viewsCount || 0}</td>
          <td>${p.salesCount || 0}</td>
          <td class="project-value text-success"><strong>${escapeHtml(p.totalEarned || 0)} ${escapeHtml(p.currency)}</strong></td>
          <td class="project-value">${dateStr}</td>
          <td>
            <a href="${shareUrl}" target="_blank" class="btn btn-secondary btn-sm">View ↗</a>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-danger" style="padding: 24px;">
          Failed to load links: ${escapeHtml(err.message)}
        </td>
      </tr>
    `;
  }
}

// -------------------------------------------------------------
// 9. DOCUMENTATION PORTAL LOGIC
// -------------------------------------------------------------
function initDocsPortal() {
  // 1. Tabbed Navigation
  const tabBtns = document.querySelectorAll('.doc-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.docTab;
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.doc-tab-pane').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPane = document.getElementById(`pane-${tabName}`);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  // 2. Code Language Switcher
  const langTabs = document.querySelectorAll('.code-lang-tab');
  langTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const lang = tab.dataset.lang;
      langTabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.code-snippet-wrapper').forEach(w => w.style.display = 'none');

      tab.classList.add('active');
      const targetCode = document.getElementById(`code-${lang}`);
      if (targetCode) targetCode.style.display = 'block';
    });
  });

  // 3. Copy Code Buttons
  const copyBtns = document.querySelectorAll('.btn-copy-code');
  copyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const el = document.getElementById(targetId);
      if (el) {
        navigator.clipboard.writeText(el.innerText || el.textContent);
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = originalText;
          btn.classList.remove('copied');
        }, 2000);
      }
    });
  });

  // 4. FAQ Accordion
  const faqQuestions = document.querySelectorAll('.faq-question');
  faqQuestions.forEach(q => {
    q.addEventListener('click', () => {
      const item = q.closest('.faq-item');
      if (item) item.classList.toggle('open');
    });
  });
}


function escapeHtml(value) {
  const el = document.createElement('span'); el.textContent = String(value ?? ''); return el.innerHTML;
}
function decimalUnits(value, decimals) {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('Invalid price');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('Price has too many decimal places');
  const units = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (units <= 0n || units >= 2n ** 256n) throw new Error('Invalid price');
  return units;
}
async function loadAvailableCurrencies() {
  try {
    const config = await fetch('/facilitator/supported').then(r => r.json());
    const select = document.getElementById('assetCurrency');
    select.replaceChildren(...config.supportedTokens.map(t => new Option(t.symbol, t.symbol)));
  } catch (_) { document.getElementById('btnPublishPaywall').disabled = true; }
}
