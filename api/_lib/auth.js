'use strict';

const crypto = require('crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Reads DEPLOY_KEY from Vercel Environment Variables without ever logging or returning it.
 */
function getDeployKey() {
  const key = process.env.DEPLOY_KEY;
  if (!key || typeof key !== 'string' || !key.trim()) {
    return null;
  }
  return key.trim();
}

/**
 * Timing-safe comparison of password against DEPLOY_KEY using SHA-256 digests.
 */
function safeComparePassword(password, deployKey) {
  if (!password || !deployKey) return false;
  const a = crypto.createHash('sha256').update(String(password), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(deployKey), 'utf8').digest();
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Creates a stateless HMAC-signed session token.
 * Format: base64url(payload).base64url(signature)
 */
function createSessionToken(deployKey) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt }), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', deployKey)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verifies a session token or falls back to password comparison.
 */
function verifyTokenOrPassword(tokenOrPassword, deployKey) {
  if (!tokenOrPassword || !deployKey) {
    return { valid: false, reason: 'Missing credentials' };
  }

  // Try as session token first
  const parts = String(tokenOrPassword).split('.');
  if (parts.length === 2) {
    const [payloadB64, sig] = parts;
    try {
      const expected = crypto
        .createHmac('sha256', deployKey)
        .update(payloadB64)
        .digest('base64url');
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return { valid: false, reason: 'Invalid signature' };
      }
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      if (!payload.exp || Date.now() > payload.exp) {
        return { valid: false, reason: 'Session expired' };
      }
      return { valid: true, expiresAt: payload.exp };
    } catch (_) {
      // Fall through to password check
    }
  }

  // Fallback: treat as password
  if (safeComparePassword(tokenOrPassword, deployKey)) {
    return { valid: true, expiresAt: Date.now() + SESSION_TTL_MS };
  }

  return { valid: false, reason: 'Invalid credentials' };
}

/**
 * Extracts auth token from request headers or Authorization header.
 */
function extractAuthFromRequest(req) {
  const header = req.headers['x-gitflow-auth'] || req.headers['authorization'];
  if (!header) return null;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return String(header).trim();
}

/**
 * Reads and parses JSON body from request (for Node/Vercel).
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') {
      return resolve(req.body);
    }
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Middleware-style auth guard. Returns session info or sends 401 and returns null.
 */
function requireAuth(req, res) {
  const deployKey = getDeployKey();
  if (!deployKey) {
    res.status(500).json({
      ok: false,
      code: 'MISSING_DEPLOY_KEY',
      error: 'Server configuration incomplete.'
    });
    return null;
  }

  const token = extractAuthFromRequest(req);
  if (!token) {
    res.status(401).json({
      ok: false,
      authenticated: false,
      code: 'NO_SESSION',
      error: 'Authentication required.'
    });
    return null;
  }

  const check = verifyTokenOrPassword(token, deployKey);
  if (!check.valid) {
    res.status(401).json({
      ok: false,
      authenticated: false,
      code: 'INVALID_SESSION',
      error: check.reason || 'Invalid or expired session.'
    });
    return null;
  }

  return { expiresAt: check.expiresAt };
}

module.exports = {
  getDeployKey,
  safeComparePassword,
  createSessionToken,
  verifyTokenOrPassword,
  extractAuthFromRequest,
  readJsonBody,
  requireAuth,
  SESSION_TTL_MS
};
