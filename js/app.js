// === Provider Icon Map (same CDN URLs as ai.ezif.in) ===
const PROVIDER_ICONS = {
  anthropic: 'https://svgstack.com/media/img/claude-logo-6FGW382926.webp',
  openai: 'https://svgstack.com/media/img/chatgpt-logo-hyKG382924.webp',
  google: 'https://svgstack.com/media/img/gemini-logo-P9mq386067.webp',
  xai: 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/grok.png',
  qwen: 'https://unpkg.com/@lobehub/icons-static-png@latest/light/qwen-color.png',
  deepseek: 'https://svgstack.com/media/img/deepseek-logo-TrLl386065.webp',
  meta: 'https://unpkg.com/@lobehub/icons-static-png@latest/light/meta-color.png',
  microsoft: 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/microsoft-color.png',
  mistral: 'https://svgstack.com/media/img/mistral-ai-logo-1N5p386073.webp',
  minimax: 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/minimax-color.png',
  moonshot: 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/kimi.png',
  nvidia: 'https://svgstack.com/media/img/nvidia-logo-pv5D386076.webp',
  zhipu: 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/zai.png',
  kivest: 'https://svgstack.com/media/img/chatgpt-logo-hyKG382924.webp',
  sarvam: 'https://i.ibb.co/W4m5pZZ6/image.png',
  xiaomi: 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/xiaomimimo.png',
  bytedance: 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/bytedance-color.png',
  stepfun: 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/stepfun-color.png',
  'openai-oss': 'https://svgstack.com/media/img/chatgpt-logo-hyKG382924.webp',
};

// Special icon overrides for specific model patterns
function getModelIcon(modelId, ownedBy) {
  if (modelId.includes('codex')) {
    return 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/codex.png';
  }
  if (modelId.includes('veo')) {
    return 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/dark/deepmind-color.png';
  }
  return PROVIDER_ICONS[ownedBy] || null;
}

// === State ===
let statusData = null;
let historyData = null;
let activeProvider = 'all';
let activeStatusFilter = null;
let filterReasoning = false;
let searchQuery = '';
let autoRefreshInterval = null;
const UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;
const TIMELINE_SEGMENTS = 48;

// === DOM refs ===
const $grid = document.getElementById('model-grid');
const $loading = document.getElementById('loading-screen');
const $systemStatus = document.getElementById('system-status');
const $systemStatusText = document.getElementById('system-status-text');
const $heroTitle = document.getElementById('hero-title');
const $heroSubtitle = document.getElementById('hero-subtitle');
const $lastUpdated = document.getElementById('last-updated');
const $searchInput = document.getElementById('search-input');
const $statOnline = document.getElementById('stat-online');
const $statDown = document.getElementById('stat-down');
const $statUptime = document.getElementById('stat-uptime');
const $statTotal = document.getElementById('stat-total');

// === Data Fetching ===
async function fetchData() {
  try {
    const [statusRes, historyRes] = await Promise.all([
      fetch('data/status.json?' + Date.now()),
      fetch('data/history.json?' + Date.now())
    ]);
    statusData = await statusRes.json();
    historyData = await historyRes.json();
    return true;
  } catch (err) {
    console.error('Failed to fetch data:', err);
    return false;
  }
}

// === Rendering ===
function timeAgo(isoString) {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function statusLabel(status) {
  switch (status) {
    case 'operational': return 'Operational';
    case 'down': return 'Down';
    case 'paid_only': return 'Paid Only';
    default: return 'Unknown';
  }
}

function getSortedHistoryEntries() {
  if (!Array.isArray(historyData)) return [];

  return [...historyData]
    .filter(entry => entry && entry.timestamp && entry.statuses)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function buildHistoryIndex() {
  const historyIndex = new Map();

  for (const entry of getSortedHistoryEntries()) {
    for (const [modelId, snapshot] of Object.entries(entry.statuses || {})) {
      if (!historyIndex.has(modelId)) {
        historyIndex.set(modelId, []);
      }

      historyIndex.get(modelId).push({
        timestamp: entry.timestamp,
        status: snapshot.status || 'unknown',
        responseTime: snapshot.responseTime ?? null
      });
    }
  }

  return historyIndex;
}

function calculateUptime(history) {
  if (!history.length) return null;

  const operationalChecks = history.filter(entry => entry.status === 'operational').length;
  return parseFloat(((operationalChecks / history.length) * 100).toFixed(1));
}

function getModels() {
  const statusModels = statusData?.models || {};
  const historyIndex = buildHistoryIndex();
  const modelIds = new Set([
    ...Object.keys(statusModels),
    ...historyIndex.keys()
  ]);
  const now = Date.now();

  return [...modelIds].map(modelId => {
    const baseModel = statusModels[modelId] || {
      id: modelId,
      ownedBy: 'unknown',
      status: 'unknown',
      responseTime: null,
      supportsReasoning: false,
      isPaidOnly: false,
      response: null,
      reasoningContent: null,
      rawResponse: null,
      error: null,
      lastChecked: null,
      uptime: null,
      totalChecks: null
    };

    const fullHistory = historyIndex.get(modelId) || [];
    const latestHistory = fullHistory[fullHistory.length - 1] || null;
    const uptimeHistory = fullHistory.filter(entry => {
      const timestamp = new Date(entry.timestamp).getTime();
      return Number.isFinite(timestamp) && now - timestamp <= UPTIME_WINDOW_MS;
    });
    const timelineHistory = fullHistory.slice(-TIMELINE_SEGMENTS);

    const statusCheckedAt = baseModel.lastChecked ? new Date(baseModel.lastChecked).getTime() : 0;
    const historyCheckedAt = latestHistory ? new Date(latestHistory.timestamp).getTime() : 0;
    const useLiveStatus = statusCheckedAt > historyCheckedAt;

    const effectiveStatus = useLiveStatus || !latestHistory
      ? (baseModel.status || 'unknown')
      : latestHistory.status;
    const effectiveResponseTime = useLiveStatus || !latestHistory
      ? (baseModel.responseTime ?? null)
      : (latestHistory.responseTime ?? null);
    const effectiveLastChecked = useLiveStatus || !latestHistory
      ? (baseModel.lastChecked || null)
      : latestHistory.timestamp;
    const calculatedUptime = calculateUptime(uptimeHistory);

    return {
      ...baseModel,
      status: effectiveStatus,
      responseTime: effectiveResponseTime,
      lastChecked: effectiveLastChecked,
      isPaidOnly: effectiveStatus === 'paid_only',
      uptime: calculatedUptime ?? (fullHistory.length === 0 ? (baseModel.uptime ?? null) : null),
      totalChecks: uptimeHistory.length || (fullHistory.length === 0 ? (baseModel.totalChecks ?? null) : null),
      timelineHistory
    };
  });
}

function getFilteredModels() {
  let models = getModels();

  if (activeProvider !== 'all') {
    models = models.filter(m => (m.ownedBy || '').toLowerCase() === activeProvider);
  }

  if (filterReasoning) {
    models = models.filter(m => m.supportsReasoning);
  }

  if (activeStatusFilter === 'online') {
    models = models.filter(m => m.status === 'operational');
  } else if (activeStatusFilter === 'offline') {
    models = models.filter(m => m.status === 'down');
  } else if (activeStatusFilter === 'paid') {
    models = models.filter(m => m.status === 'paid_only');
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    models = models.filter(m =>
      m.id.toLowerCase().includes(q) ||
      (m.ownedBy || '').toLowerCase().includes(q)
    );
  }

  // Sort: operational first, then paid, then by name
  models.sort((a, b) => {
    const order = { operational: 0, paid_only: 1, unknown: 2, down: 3 };
    const diff = (order[a.status] ?? 2) - (order[b.status] ?? 2);
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });

  return models;
}

function renderSummary() {
  const models = getModels();
  if (models.length === 0) {
    if ($systemStatus) $systemStatus.className = 'system-status degraded';
    if ($systemStatusText) $systemStatusText.textContent = 'Loading...';
    $heroTitle.textContent = 'Model Status';
    $heroSubtitle.textContent = 'Waiting for data...';
    $statOnline.textContent = '-';
    $statDown.textContent = '-';
    $statUptime.textContent = '-';
    $statTotal.textContent = '-';
    return;
  }

  const operational = models.filter(m => m.status === 'operational').length;
  const down = models.filter(m => m.status === 'down').length;
  const paidOnly = models.filter(m => m.status === 'paid_only').length;
  const total = models.length;
  const onlinePercent = ((operational / total) * 100).toFixed(1);

  const uptimeModels = models.filter(m => !m.isPaidOnly && m.uptime != null);
  const uptimes = uptimeModels.map(m => m.uptime);
  const avgUptime = uptimes.length > 0
    ? (uptimes.reduce((a, b) => a + b, 0) / uptimes.length).toFixed(1)
    : '-';

  // System status
  if (down === 0 && paidOnly === 0) {
    if ($systemStatus) $systemStatus.className = 'system-status operational';
    if ($systemStatusText) $systemStatusText.textContent = 'All Systems Operational';
  } else if (down > total * 0.5) {
    if ($systemStatus) $systemStatus.className = 'system-status outage';
    if ($systemStatusText) $systemStatusText.textContent = 'Major Outage';
  } else if (down > 0) {
    if ($systemStatus) $systemStatus.className = 'system-status degraded';
    if ($systemStatusText) $systemStatusText.textContent = 'Partial Outage';
  } else {
    if ($systemStatus) $systemStatus.className = 'system-status operational';
    if ($systemStatusText) $systemStatusText.textContent = 'All Systems Operational';
  }

  $heroTitle.textContent = `${onlinePercent}% Operational`;
  $heroSubtitle.textContent = `${operational} of ${total} models are currently online.`;

  $statOnline.textContent = operational;
  $statDown.textContent = down;
  $statUptime.textContent = avgUptime !== '-' ? avgUptime + '%' : '-';
  $statTotal.textContent = total;

  const latestCheckedAt = models.reduce((latest, model) => {
    if (!model.lastChecked) return latest;
    const timestamp = new Date(model.lastChecked).getTime();
    return Number.isFinite(timestamp) && timestamp > latest ? timestamp : latest;
  }, 0);

  if (latestCheckedAt > 0) {
    $lastUpdated.textContent = `Last checked: ${timeAgo(new Date(latestCheckedAt).toISOString())}`;
  } else if (statusData?.lastRun) {
    $lastUpdated.textContent = `Last checked: ${timeAgo(statusData.lastRun)}`;
  }
}

function renderModelCard(model) {
  const history = model.timelineHistory || [];
  const icon = getModelIcon(model.id, model.ownedBy);
  const uptime = model.uptime;
  const hasUptime = uptime != null;
  const uptimeClass = hasUptime && uptime >= 95 ? 'high' : hasUptime && uptime >= 80 ? 'medium' : 'low';
  const iconHTML = icon
    ? `<img class="model-icon" src="${icon}" alt="${model.ownedBy}" loading="lazy" onerror="this.style.display='none'">`
    : '';

  let timelineHTML = '';
  if (!model.isPaidOnly) {
    if (history.length > 0) {
      const segments = history.map(h => {
        const cls = h.status === 'operational' ? 'up' : h.status === 'paid_only' ? 'paid' : 'down';
        const tooltipText = `${new Date(h.timestamp).toLocaleString()}: ${statusLabel(h.status)}`;
        return `<button type="button" class="uptime-segment ${cls}" title="${tooltipText}" aria-label="${tooltipText}"></button>`;
      }).join('');
      const pad = Math.max(0, TIMELINE_SEGMENTS - history.length);
      const padHTML = Array(pad).fill('<button type="button" class="uptime-segment unknown" title="No data" aria-label="No data"></button>').join('');
      timelineHTML = `<div class="uptime-timeline">${padHTML}${segments}</div>`;
    } else {
      timelineHTML = `<div class="uptime-timeline">${Array(TIMELINE_SEGMENTS).fill('<button type="button" class="uptime-segment unknown" title="No data" aria-label="No data"></button>').join('')}</div>`;
    }
  }

  const badges = [];
  if (model.supportsReasoning) {
    badges.push('<span class="badge badge-reasoning">⚡ Reasoning</span>');
  }
  if (model.isPaidOnly) {
    badges.push('<span class="badge badge-paid">💎 Paid</span>');
  }
  badges.push(`<span class="badge badge-provider">${model.ownedBy || 'unknown'}</span>`);

  return `
    <div class="model-card" data-model-id="${model.id}">
      <div class="model-card-header">
        ${iconHTML}
        <span class="model-name" title="${model.id}">${model.id}</span>
        <div class="model-status-dot ${model.status}"></div>
      </div>
      <div class="model-card-meta">
        <span class="badge badge-status ${model.status}">${statusLabel(model.status)}</span>
        ${badges.join('')}
      </div>
      ${timelineHTML}
      ${hasUptime && !model.isPaidOnly ? `
        <div class="uptime-bar-container">
          <div class="uptime-bar-label">
            <span class="uptime-bar-text">24h Uptime</span>
            <span class="uptime-bar-value ${uptimeClass}">${uptime}%</span>
          </div>
          <div class="uptime-bar">
            <div class="uptime-bar-fill ${uptimeClass}" style="width: ${uptime}%"></div>
          </div>
        </div>
      ` : ''}
      <div class="model-card-footer">
        <div class="response-time">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          ${model.responseTime != null ? `${(model.responseTime / 1000).toFixed(1)}s` : '-'}
        </div>
        <span>${model.lastChecked ? timeAgo(model.lastChecked) : 'Not tested'}</span>
      </div>
    </div>
  `;
}

function renderGrid() {
  const models = getFilteredModels();
  if (models.length === 0) {
    $grid.innerHTML = '<div class="no-results">No models found matching your filters.</div>';
    return;
  }
  $grid.innerHTML = models.map(renderModelCard).join('');
}

function renderAll() {
  renderSummary();
  renderGrid();
}

// === Filters ===
function buildProviderTabs() {
  const models = getModels();
  const providers = new Set(models.map(m => (m.ownedBy || 'unknown').toLowerCase()));
  const $tabs = document.getElementById('provider-tabs');
  const $allBtn = document.getElementById('filter-tab-all');
  if (!$tabs) return;

  // Build only provider buttons (All is separate)
  const sorted = [...providers].sort();
  let html = '';
  for (const p of sorted) {
    const label = p.charAt(0).toUpperCase() + p.slice(1);
    html += `<button class="filter-tab" data-provider="${p}">${label}</button>`;
  }
  $tabs.innerHTML = html;

  // All button click
  if ($allBtn) {
    $allBtn.addEventListener('click', () => {
      $tabs.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      $allBtn.classList.add('active');
      activeProvider = 'all';
      renderGrid();
    });
  }

  // Provider tab clicks
  $tabs.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $tabs.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      if ($allBtn) $allBtn.classList.remove('active');
      tab.classList.add('active');
      activeProvider = tab.dataset.provider;
      renderGrid();
    });
  });

  // Scroll arrows
  const $scrollLeft = document.getElementById('scroll-left');
  const $scrollRight = document.getElementById('scroll-right');

  function updateScrollArrows() {
    if (!$scrollLeft || !$scrollRight) return;
    const atStart = $tabs.scrollLeft <= 1;
    const atEnd = $tabs.scrollLeft + $tabs.clientWidth >= $tabs.scrollWidth - 1;
    $scrollLeft.classList.toggle('hidden', atStart);
    $scrollRight.classList.toggle('hidden', atEnd);
  }

  $tabs.addEventListener('scroll', updateScrollArrows);
  updateScrollArrows();

  // Mouse wheel horizontal scroll
  $tabs.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      $tabs.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  if ($scrollLeft) {
    $scrollLeft.addEventListener('click', () => {
      $tabs.scrollBy({ left: -150, behavior: 'smooth' });
    });
  }
  if ($scrollRight) {
    $scrollRight.addEventListener('click', () => {
      $tabs.scrollBy({ left: 150, behavior: 'smooth' });
    });
  }
}

function setupFilters() {
  buildProviderTabs();

  // Status filter buttons
  document.querySelectorAll('.filter-status-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.dataset.status;
      if (activeStatusFilter === filter) {
        activeStatusFilter = null;
        btn.classList.remove('active-green', 'active-red', 'active-amber');
      } else {
        document.querySelectorAll('.filter-status-btn').forEach(b => b.classList.remove('active-green', 'active-red', 'active-amber'));
        activeStatusFilter = filter;
        if (filter === 'online') btn.classList.add('active-green');
        else if (filter === 'paid') btn.classList.add('active-amber');
        else btn.classList.add('active-red');
      }
      renderGrid();
    });
  });

  // Reasoning filter
  const $reasoningBtn = document.getElementById('filter-reasoning');
  if ($reasoningBtn) {
    $reasoningBtn.addEventListener('click', () => {
      filterReasoning = !filterReasoning;
      $reasoningBtn.classList.toggle('active-purple', filterReasoning);
      renderGrid();
    });
  }

  // Search
  $searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderGrid();
  });
}

// === Auto Refresh ===
function startAutoRefresh() {
  autoRefreshInterval = setInterval(async () => {
    const ok = await fetchData();
    if (ok) renderAll();
  }, 60000); // Refresh every 60s
}

// === Init ===

async function init() {
  const ok = await fetchData();
  if (ok) {
    renderAll();
  }
  $loading.classList.add('hidden');
  setupFilters();
  startAutoRefresh();

  // Update time-ago labels every 30s
  setInterval(() => {
    renderAll();
  }, 30000);
}

// === Mobile-friendly tooltip for timeline segments ===
let $segmentTooltip = null;
function ensureSegmentTooltip() {
  if ($segmentTooltip) return $segmentTooltip;
  $segmentTooltip = document.createElement('div');
  $segmentTooltip.className = 'segment-tooltip';
  $segmentTooltip.hidden = true;
  $segmentTooltip.innerHTML = `<span class="segment-tooltip-text"></span><button type="button" aria-label="Close">✕</button>`;
  document.body.appendChild($segmentTooltip);

  $segmentTooltip.querySelector('button')?.addEventListener('click', hideSegmentTooltip);
  return $segmentTooltip;
}

function showSegmentTooltip(text) {
  const tip = ensureSegmentTooltip();
  const textEl = tip.querySelector('.segment-tooltip-text');
  if (textEl) textEl.textContent = text;
  tip.hidden = false;
}

function hideSegmentTooltip() {
  if ($segmentTooltip) $segmentTooltip.hidden = true;
}

// Tap/click on a segment to show its info (mobile). Click outside to close.
document.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;

  const seg = target.closest('.uptime-segment');
  if (seg) {
    const text = seg.getAttribute('aria-label') || seg.getAttribute('title');
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    showSegmentTooltip(text);
    return;
  }

  // outside click
  hideSegmentTooltip();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSegmentTooltip();
});

document.addEventListener('DOMContentLoaded', init);

