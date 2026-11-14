'use strict';

const {
  getDeployKey,
  safeComparePassword,
  createSessionToken,
  verifyTokenOrPassword,
  extractAuthFromRequest,
  readJsonBody
} = require('./_lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  const deployKey = getDeployKey();
  if (!deployKey) {
    return res.status(500).json({
      ok: false,
      code: 'MISSING_DEPLOY_KEY',
      error: 'Konfigurasi server belum lengkap: Environment variable DEPLOY_KEY belum diatur di Vercel.',
      action: 'Tambahkan DEPLOY_KEY pada pengaturan Environment Variables di dashboard Vercel.'
    });
  }

  // GET /api/auth-check -> Verify existing session token on page load / refresh
  if (req.method === 'GET') {
    const token = extractAuthFromRequest(req);
    if (!token) {
      return res.status(401).json({
        ok: false,
        authenticated: false,
        code: 'NO_SESSION',
        error: 'Sesi tidak ditemukan. Silakan login terlebih dahulu.'
      });
    }

    const check = verifyTokenOrPassword(token, deployKey);
    if (!check.valid) {
      return res.status(401).json({
        ok: false,
        authenticated: false,
        code: 'INVALID_SESSION',
        error: check.reason || 'Sesi tidak valid atau telah berakhir.'
      });
    }

    return res.status(200).json({
      ok: true,
      authenticated: true,
      expiresAt: check.expiresAt
    });
  }

  // POST /api/auth-check -> Verify login password and issue stateless session token
  if (req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_JSON',
        error: 'Format request tidak valid.'
      });
    }

    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password) {
      return res.status(400).json({
        ok: false,
        code: 'EMPTY_PASSWORD',
        error: 'Password tidak boleh kosong.'
      });
    }

    if (!safeComparePassword(password, deployKey)) {
      return res.status(401).json({
        ok: false,
        code: 'INVALID_PASSWORD',
        error: 'Password salah.'
      });
    }

    const token = createSessionToken(deployKey);
    return res.status(200).json({
      ok: true,
      authenticated: true,
      token,
      expiresAt: token.split('.')[1] ? undefined : undefined
    });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
