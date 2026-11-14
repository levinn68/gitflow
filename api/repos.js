'use strict';

const { requireAuth } = require('./_lib/auth');
const { listAllAccessibleRepos, GitHubApiError } = require('./_lib/gh');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      ok: false,
      code: 'METHOD_NOT_ALLOWED',
      error: 'Method tidak didukung.'
    });
  }

  const session = requireAuth(req, res);
  if (!session) return;

  try {
    const searchQuery = String(req.query?.q || '').trim().toLowerCase();
    const repos = await listAllAccessibleRepos({ fetchAll: true });

    const filtered = searchQuery
      ? repos.filter((r) =>
          r.fullName.toLowerCase().includes(searchQuery) ||
          r.name.toLowerCase().includes(searchQuery) ||
          (r.description && r.description.toLowerCase().includes(searchQuery))
        )
      : repos;

    return res.status(200).json({
      ok: true,
      total: filtered.length,
      repos: filtered
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
      code: 'REPOS_FETCH_ERROR',
      stage: 'list_repos',
      error: 'Gagal memuat daftar repository dari GitHub.',
      action: 'Periksa GITHUB_TOKEN dan coba muat ulang daftar repository.'
    });
  }
};
