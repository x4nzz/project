'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ──────────────────────────────────────────────────────

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
      },
    },
  })
);

app.use(cors({ origin: false })); // same-origin only
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});

app.use('/api', apiLimiter);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Masks a Stripe key for safe display.
 * e.g. sk_live_abcdefgh...wxyz
 */
function maskKey(key) {
  if (!key || key.length <= 16) return key;
  const prefix = key.substring(0, 12);
  const suffix = key.substring(key.length - 4);
  return `${prefix}...${suffix}`;
}

/**
 * Classifies the key type from its prefix.
 */
function classifyKey(key) {
  if (key.startsWith('sk_live_')) return { type: 'Secret', env: 'Live' };
  if (key.startsWith('sk_test_')) return { type: 'Secret', env: 'Test' };
  if (key.startsWith('rk_live_')) return { type: 'Restricted', env: 'Live' };
  if (key.startsWith('rk_test_')) return { type: 'Restricted', env: 'Test' };
  if (key.startsWith('pk_live_')) return { type: 'Publishable', env: 'Live' };
  if (key.startsWith('pk_test_')) return { type: 'Publishable', env: 'Test' };
  return null;
}

/**
 * Validates a single Stripe key against the Stripe API.
 * Uses /v1/customers?limit=1 — minimal read, any valid secret key passes.
 */
async function validateStripeKey(rawKey) {
  const key = rawKey.trim();

  if (!key) {
    return { key: '', masked: '', status: 'skipped', message: 'Empty key' };
  }

  const classification = classifyKey(key);

  if (!classification) {
    return {
      key,
      masked: maskKey(key),
      status: 'invalid',
      message: 'Unrecognised key prefix',
      keyType: null,
      keyEnv: null,
    };
  }

  // Publishable keys cannot be validated server-side this way
  if (classification.type === 'Publishable') {
    return {
      key,
      masked: maskKey(key),
      status: 'skipped',
      message: 'Publishable keys are not validated (no secret scope)',
      keyType: classification.type,
      keyEnv: classification.env,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://api.stripe.com/v1/customers?limit=1', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Stripe-Version': '2023-10-16',
        'User-Agent': 'StripeKeyValidator/1.0',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      return {
        key,
        masked: maskKey(key),
        status: 'valid',
        message: `[VALID] ${maskKey(key)} is valid!`,
        keyType: classification.type,
        keyEnv: classification.env,
        isLive: classification.env === 'Live',
      };
    }

    if (response.status === 401) {
      return {
        key,
        masked: maskKey(key),
        status: 'invalid',
        message: 'Invalid API key',
        keyType: classification.type,
        keyEnv: classification.env,
      };
    }

    if (response.status === 403) {
      // Restricted key exists but lacks /customers scope — still valid
      return {
        key,
        masked: maskKey(key),
        status: 'valid',
        message: `[VALID] ${maskKey(key)} is valid! (restricted permissions)`,
        keyType: classification.type,
        keyEnv: classification.env,
        isLive: classification.env === 'Live',
        restricted: true,
      };
    }

    if (response.status === 429) {
      return {
        key,
        masked: maskKey(key),
        status: 'error',
        message: 'Stripe rate limit hit — try again shortly',
        keyType: classification.type,
        keyEnv: classification.env,
      };
    }

    return {
      key,
      masked: maskKey(key),
      status: 'error',
      message: `Unexpected HTTP ${response.status}`,
      keyType: classification.type,
      keyEnv: classification.env,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        key,
        masked: maskKey(key),
        status: 'error',
        message: 'Request timed out',
        keyType: classification.type,
        keyEnv: classification.env,
      };
    }
    return {
      key,
      masked: maskKey(key),
      status: 'error',
      message: `Network error: ${err.message}`,
      keyType: classification.type,
      keyEnv: classification.env,
    };
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/validate
 * Validate a single key. Returns JSON.
 */
app.post('/api/validate', async (req, res) => {
  const { key } = req.body;

  if (typeof key !== 'string' || !key.trim()) {
    return res.status(400).json({ error: 'key (string) is required.' });
  }

  if (key.length > 500) {
    return res.status(400).json({ error: 'Key value is too long.' });
  }

  const result = await validateStripeKey(key);
  res.json(result);
});

/**
 * POST /api/validate/bulk
 * Streams results via Server-Sent Events.
 * Body: { keys: string[], stopOnValid?: boolean, concurrency?: number }
 */
app.post('/api/validate/bulk', async (req, res) => {
  const { keys, stopOnValid = false, concurrency = 3 } = req.body;

  if (!Array.isArray(keys) || keys.length === 0) {
    return res.status(400).json({ error: 'keys (array) is required.' });
  }

  if (keys.length > 2000) {
    return res.status(400).json({ error: 'Maximum 2 000 keys per request.' });
  }

  // Deduplicate and sanitise
  const uniqueKeys = [
    ...new Set(keys.map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean)),
  ];

  const safeConc = Math.min(Math.max(1, Math.floor(concurrency)), 10);

  // ── SSE setup ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering on Railway
  res.flushHeaders();

  const send = (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (_) {
      // client disconnected mid-stream
    }
  };

  // Client disconnect tracking
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  send({ type: 'start', total: uniqueKeys.length, concurrency: safeConc });

  let stopped = false;
  let processed = 0;
  let validCount = 0;
  let invalidCount = 0;
  let errorCount = 0;

  /**
   * Process a single key, emit SSE result.
   */
  const processKey = async (key) => {
    if (stopped || clientGone) return;

    const result = await validateStripeKey(key);
    processed++;

    if (result.status === 'valid') validCount++;
    else if (result.status === 'invalid') invalidCount++;
    else if (result.status === 'error') errorCount++;

    send({
      type: 'result',
      ...result,
      processed,
      total: uniqueKeys.length,
    });

    if (result.status === 'valid' && stopOnValid) {
      stopped = true;
      send({
        type: 'stopped',
        reason: 'valid_found',
        masked: result.masked,
        processed,
        total: uniqueKeys.length,
      });
    }
  };

  // ── Concurrency loop ──
  for (let i = 0; i < uniqueKeys.length; i += safeConc) {
    if (stopped || clientGone) break;
    const chunk = uniqueKeys.slice(i, i + safeConc);
    await Promise.all(chunk.map(processKey));
  }

  if (!stopped && !clientGone) {
    send({
      type: 'complete',
      processed,
      total: uniqueKeys.length,
      stats: { valid: validCount, invalid: invalidCount, errors: errorCount },
    });
  }

  res.end();
});

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── 404 Fallback → SPA ──────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅  Stripe Key Validator running → http://localhost:${PORT}`);
});
