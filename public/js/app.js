'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  running:     false,
  results:     [],   // { key, masked, status, message, keyType, keyEnv, isLive }
  concurrency: 3,
  controller:  null, // AbortController for fetch
};

// ─── DOM Refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const el = {
  keyInput:       $('keyInput'),
  keyCount:       $('keyCount'),
  fileInput:      $('fileInput'),
  clearBtn:       $('clearBtn'),
  stopOnValid:    $('stopOnValid'),
  liveOnly:       $('liveOnly'),
  concValue:      $('concValue'),
  concDec:        $('concDec'),
  concInc:        $('concInc'),
  runBtn:         $('runBtn'),
  runBtnLabel:    $('runBtnLabel'),
  statusPill:     $('statusPill'),
  statsBar:       $('statsBar'),
  statValid:      $('statValid'),
  statInvalid:    $('statInvalid'),
  statError:      $('statError'),
  statProgress:   $('statProgress'),
  progressWrap:   $('progressWrap'),
  progressBar:    $('progressBar'),
  resultsPanel:   $('resultsPanel'),
  resultsList:    $('resultsList'),
  copyValidBtn:   $('copyValidBtn'),
  exportBtn:      $('exportBtn'),
  clearResultsBtn:$('clearResultsBtn'),
};

// ─── Key Parsing ──────────────────────────────────────────────────────────────

function parseKeys(raw) {
  return raw
    .split(/[\n,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function updateKeyCount() {
  const keys = parseKeys(el.keyInput.value);
  const n = keys.length;
  el.keyCount.textContent = `${n} key${n !== 1 ? 's' : ''}`;
}

// ─── Concurrency Stepper ──────────────────────────────────────────────────────

el.concDec.addEventListener('click', () => {
  if (state.concurrency > 1) {
    state.concurrency--;
    el.concValue.textContent = state.concurrency;
  }
});

el.concInc.addEventListener('click', () => {
  if (state.concurrency < 10) {
    state.concurrency++;
    el.concValue.textContent = state.concurrency;
  }
});

// ─── File Upload ──────────────────────────────────────────────────────────────

el.fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const existing = el.keyInput.value.trim();
    const incoming = ev.target.result.trim();
    el.keyInput.value = existing ? `${existing}\n${incoming}` : incoming;
    updateKeyCount();
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ─── Clear ────────────────────────────────────────────────────────────────────

el.clearBtn.addEventListener('click', () => {
  el.keyInput.value = '';
  updateKeyCount();
});

el.clearResultsBtn.addEventListener('click', () => {
  state.results = [];
  el.resultsList.innerHTML = '';
  el.resultsPanel.hidden = true;
  el.statsBar.hidden = true;
  el.progressWrap.hidden = true;
  el.copyValidBtn.hidden = true;
  el.exportBtn.hidden = true;
  setPill('idle');
});

el.keyInput.addEventListener('input', updateKeyCount);

// ─── Status Pill ──────────────────────────────────────────────────────────────

const PILL_MAP = {
  idle:    ['pill--idle',    'Idle'],
  running: ['pill--running', 'Running'],
  done:    ['pill--done',    'Done'],
  stopped: ['pill--stopped', 'Stopped'],
};

function setPill(type) {
  const [cls, label] = PILL_MAP[type] || PILL_MAP.idle;
  el.statusPill.innerHTML = `<span class="pill ${cls}">${label}</span>`;
}

// ─── Stats Update ─────────────────────────────────────────────────────────────

function updateStats(processed, total) {
  const valid   = state.results.filter((r) => r.status === 'valid').length;
  const invalid = state.results.filter((r) => r.status === 'invalid').length;
  const errors  = state.results.filter((r) => r.status === 'error').length;
  const pct     = total > 0 ? Math.round((processed / total) * 100) : 0;

  el.statValid.textContent    = valid;
  el.statInvalid.textContent  = invalid;
  el.statError.textContent    = errors;
  el.statProgress.textContent = `${pct}%`;
  el.progressBar.style.width  = `${pct}%`;
}

// ─── Result Row Rendering ─────────────────────────────────────────────────────

const STATUS_ICON = {
  valid:   '✅',
  invalid: '✗',
  error:   '⚠',
  skipped: '–',
};

const STATUS_BADGE = {
  valid:   ['badge--valid',   'VALID'],
  invalid: ['badge--invalid', 'INVALID'],
  error:   ['badge--error',   'ERROR'],
  skipped: ['badge--skipped', 'SKIP'],
};

function renderResultRow(result) {
  const [badgeCls, badgeLabel] = STATUS_BADGE[result.status] || STATUS_BADGE.skipped;
  const icon = STATUS_ICON[result.status] || '?';
  const env  = result.keyEnv ? ` [${result.keyEnv}]` : '';

  const row = document.createElement('div');
  row.className = `result-item result-item--${result.status}`;
  row.innerHTML = `
    <span class="result-icon">${icon}</span>
    <span class="result-key" title="${result.masked || ''}">${result.masked || result.key}${env}</span>
    <span class="result-badge ${badgeCls}">${badgeLabel}</span>
  `;
  return row;
}

function injectValidBanner(masked) {
  const banner = document.createElement('div');
  banner.className = 'valid-banner';
  banner.innerHTML = `<span>⚡</span><span>[VALID] ${masked} is valid!</span>`;

  // Insert at top of results list
  el.resultsList.prepend(banner);
  // Also scroll to top
  el.resultsList.scrollTop = 0;
}

// ─── Main Run ─────────────────────────────────────────────────────────────────

el.runBtn.addEventListener('click', () => {
  if (state.running) {
    stopRun();
  } else {
    startRun();
  }
});

function stopRun() {
  if (state.controller) state.controller.abort();
  state.running = false;
  el.runBtnLabel.textContent = '▶ Run Validator';
  el.runBtn.classList.remove('btn--stop');
  setPill('stopped');
}

async function startRun() {
  const raw = el.keyInput.value.trim();
  if (!raw) return;

  let keys = parseKeys(raw);
  if (keys.length === 0) return;

  // Live-only filter (client side pre-filter)
  if (el.liveOnly.checked) {
    keys = keys.filter((k) => k.startsWith('sk_live_') || k.startsWith('rk_live_'));
    if (keys.length === 0) {
      alert('No live keys found in input.');
      return;
    }
  }

  // Reset state
  state.running = true;
  state.results = [];
  state.controller = new AbortController();

  el.resultsList.innerHTML = '';
  el.resultsPanel.hidden   = false;
  el.statsBar.hidden       = false;
  el.progressWrap.hidden   = false;
  el.copyValidBtn.hidden   = true;
  el.exportBtn.hidden      = true;

  el.runBtnLabel.textContent = '■ Stop';
  el.runBtn.classList.add('btn--stop');
  setPill('running');
  updateStats(0, keys.length);

  try {
    const response = await fetch('/api/validate/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keys,
        stopOnValid:  el.stopOnValid.checked,
        concurrency:  state.concurrency,
      }),
      signal: state.controller.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    // Read SSE stream
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          handleSSEEvent(event);
        } catch (_) { /* malformed line */ }
      }
    }

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Validation error:', err);
      const row = document.createElement('div');
      row.className = 'result-item result-item--error';
      row.innerHTML = `<span class="result-icon">⚠</span><span class="result-key">${err.message}</span><span class="result-badge badge--error">ERR</span>`;
      el.resultsList.appendChild(row);
    }
  } finally {
    finishRun();
  }
}

function handleSSEEvent(event) {
  switch (event.type) {

    case 'start':
      // Nothing extra needed
      break;

    case 'result': {
      state.results.push(event);
      const row = renderResultRow(event);
      el.resultsList.appendChild(row);

      // Auto-scroll to bottom (unless user has scrolled up)
      const list = el.resultsList;
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
      if (nearBottom) list.scrollTop = list.scrollHeight;

      updateStats(event.processed, event.total);
      break;
    }

    case 'stopped': {
      injectValidBanner(event.masked);
      break;
    }

    case 'complete':
      // Stats already up to date via result events
      updateStats(event.processed, event.total);
      break;
  }
}

function finishRun() {
  state.running = false;
  el.runBtnLabel.textContent = '▶ Run Validator';
  el.runBtn.classList.remove('btn--stop');

  const hasValid = state.results.some((r) => r.status === 'valid');
  const wasStopped = el.statusPill.querySelector('.pill--running') !== null;

  setPill(hasValid && el.stopOnValid.checked ? 'stopped' : 'done');

  if (hasValid) {
    el.copyValidBtn.hidden = false;
    el.exportBtn.hidden    = false;
  } else if (state.results.length > 0) {
    el.exportBtn.hidden = false;
  }
}

// ─── Copy Valid Keys ──────────────────────────────────────────────────────────

el.copyValidBtn.addEventListener('click', () => {
  const validKeys = state.results
    .filter((r) => r.status === 'valid')
    .map((r) => r.key)
    .join('\n');

  navigator.clipboard.writeText(validKeys).then(() => {
    const orig = el.copyValidBtn.textContent;
    el.copyValidBtn.textContent = '✓ Copied!';
    setTimeout(() => { el.copyValidBtn.textContent = orig; }, 2000);
  });
});

// ─── Export JSON ──────────────────────────────────────────────────────────────

el.exportBtn.addEventListener('click', () => {
  const data = {
    exportedAt: new Date().toISOString(),
    summary: {
      total:   state.results.length,
      valid:   state.results.filter((r) => r.status === 'valid').length,
      invalid: state.results.filter((r) => r.status === 'invalid').length,
      errors:  state.results.filter((r) => r.status === 'error').length,
    },
    // Never export raw keys — masked only
    results: state.results.map(({ masked, status, message, keyType, keyEnv, isLive }) => ({
      masked, status, message, keyType, keyEnv, isLive: isLive ?? false,
    })),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `stripe-validation-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

updateKeyCount();
