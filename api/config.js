'use strict';

const { requireAuth, getDeployKey } = require('./_lib/auth');
const { getGitHubToken, getAuthenticatedUser, GitHubApiError } = require('./_lib/gh');

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

  const hasDeployKey = Boolean(getDeployKey());
  const hasGithubToken = Boolean(getGitHubToken());

  const configPayload = {
    ok: true,
    version: '1.0.0',
    platform: 'Vercel Serverless',
    limits: {
      maxZipBytes: 4 * 1024 * 1024, // 4 MB
      maxZipMB: 4,
      maxExtractedFiles: 400,
      maxExpandedBytes: 18 * 1024 * 1024, // 18 MB
      maxExpandedMB: 18
    },
    defaults: {
      commitMessage: 'Upload project files',
      branch: 'main'
    },
    environment: {
      deployKeyConfigured: hasDeployKey,
      githubTokenConfigured: hasGithubToken
    },
    githubUser: null
  };

  if (!hasGithubToken) {
    return res.status(200).json({
      ...configPayload,
      warning: {
        code: 'MISSING_GITHUB_TOKEN',
        message: 'GITHUB_TOKEN belum dikonfigurasi pada Vercel Environment Variables.',
        action: 'Tambahkan GITHUB_TOKEN dengan permission repo di pengaturan Vercel.'
      }
    });
  }

  try {
    const user = await getAuthenticatedUser();
    configPayload.githubUser = {
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      htmlUrl: user.htmlUrl
    };
    configPayload.rateLimit = user.rateLimit;
    return res.status(200).json(configPayload);
  } catch (err) {
    if (err instanceof GitHubApiError) {
      return res.status(200).json({
        ...configPayload,
        warning: {
          code: err.code,
          message: err.message,
          action: err.action
        }
      });
    }
    return res.status(200).json({
      ...configPayload,
      warning: {
        code: 'GITHUB_CHECK_FAILED',
        message: 'Gagal memverifikasi status akun GitHub.',
        action: 'Periksa koneksi atau validitas GITHUB_TOKEN.'
      }
    });
  }
};
