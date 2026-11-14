'use strict';

const { requireAuth, readJsonBody } = require('./_lib/auth');
const { createRepository, GitHubApiError } = require('./_lib/gh');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      ok: false,
      code: 'METHOD_NOT_ALLOWED',
      error: 'Method tidak didukung.'
    });
  }

  const session = requireAuth(req, res);
  if (!session) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_JSON',
      error: 'Payload JSON tidak valid.'
    });
  }

  const name = String(body?.name || '').trim();
  const description = String(body?.description || '').trim();
  const visibility = String(body?.visibility || '').toLowerCase();
  const isPrivate = visibility === 'private' || body?.private === true;

  if (!name) {
    return res.status(400).json({
      ok: false,
      code: 'MISSING_REPO_NAME',
      stage: 'create_repository',
      error: 'Nama repository wajib diisi.',
      action: 'Masukkan nama repository yang valid sebelum menekan tombol buat.'
    });
  }

  try {
    const repo = await createRepository({
      name,
      description,
      isPrivate
    });

    return res.status(201).json({
      ok: true,
      repo
    });
  } catch (err) {
    if (err instanceof GitHubApiError) {
      return res.status(err.status || 500).json({
        ok: false,
        code: err.code,
        stage: err.stage,
        error: err.message,
        action: err.action
      });
    }
    return res.status(500).json({
      ok: false,
      code: 'CREATE_REPO_FAILED',
      stage: 'create_repository',
      error: 'Gagal membuat repository baru di GitHub.',
      action: 'Pastikan nama repository belum digunakan dan GITHUB_TOKEN memiliki izin pembuatan repository.'
    });
  }
};
