'use strict';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

class GitHubApiError extends Error {
  constructor(message, { status = 500, code = 'GITHUB_API_ERROR', stage = 'github_api', action = '' } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.code = code;
    this.stage = stage;
    this.action = action;
  }
}

function getGitHubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token || typeof token !== 'string' || !token.trim()) return null;
  return token.trim();
}

async function githubFetch(path, options = {}) {
  const token = getGitHubToken();
  if (!token) {
    throw new GitHubApiError('GITHUB_TOKEN is not configured.', {
      status: 500,
      code: 'MISSING_GITHUB_TOKEN',
      stage: 'auth',
      action: 'Set GITHUB_TOKEN in Vercel Environment Variables with repo scope.'
    });
  }

  const url = path.startsWith('http') ? path : `${GITHUB_API_BASE}${path}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    Authorization: `Bearer ${token}`,
    'User-Agent': 'GitFlow-ZIP-Deployer/1.0',
    ...(options.headers || {})
  };

  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }

  if (!res.ok) {
    const msg = (data && data.message) || res.statusText || 'GitHub API error';
    throw new GitHubApiError(msg, {
      status: res.status,
      code: 'GITHUB_API_ERROR',
      stage: options.stage || 'github_api',
      action: data && data.documentation_url ? `See ${data.documentation_url}` : 'Check token permissions and rate limits.'
    });
  }

  return { data, headers: res.headers, status: res.status };
}

async function getAuthenticatedUser() {
  const { data, headers } = await githubFetch('/user', { stage: 'get_user' });
  const remaining = headers.get('x-ratelimit-remaining');
  const limit = headers.get('x-ratelimit-limit');
  return {
    login: data.login,
    name: data.name,
    avatarUrl: data.avatar_url,
    htmlUrl: data.html_url,
    rateLimit: remaining != null ? { remaining: Number(remaining), limit: Number(limit) } : null
  };
}

async function listAllAccessibleRepos({ fetchAll = true } = {}) {
  const repos = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await githubFetch(`/user/repos?per_page=${perPage}&page=${page}&sort=updated`, {
      stage: 'list_repos'
    });
    if (!Array.isArray(data) || data.length === 0) break;

    for (const r of data) {
      repos.push({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        description: r.description,
        htmlUrl: r.html_url,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at
      });
    }

    if (!fetchAll || data.length < perPage) break;
    page += 1;
    if (page > 20) break; // safety
  }

  return repos;
}

async function createRepository({ name, description = '', isPrivate = false }) {
  const { data } = await githubFetch('/user/repos', {
    method: 'POST',
    stage: 'create_repository',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      description: description || undefined,
      private: !!isPrivate,
      auto_init: false
    })
  });

  return {
    id: data.id,
    name: data.name,
    fullName: data.full_name,
    private: data.private,
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch || 'main'
  };
}

async function verifyRepository(owner, repo) {
  const { data } = await githubFetch(`/repos/${owner}/${repo}`, { stage: 'verify_repo' });
  return {
    id: data.id,
    name: data.name,
    fullName: data.full_name,
    private: data.private,
    defaultBranch: data.default_branch,
    htmlUrl: data.html_url
  };
}

async function inspectBranchState(owner, repo, branch) {
  try {
    const { data } = await githubFetch(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {
      stage: 'inspect_branch'
    });
    const sha = data.object && data.object.sha;
    return { exists: true, sha, ref: data.ref };
  } catch (err) {
    if (err.status === 404) return { exists: false, sha: null, ref: null };
    throw err;
  }
}

async function createBlob(owner, repo, content, encoding = 'utf-8') {
  const { data } = await githubFetch(`/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    stage: 'create_blob',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, encoding })
  });
  return data.sha;
}

async function createBlobsForFiles(owner, repo, files) {
  // files: [{ path, content }]
  const results = [];
  for (const file of files) {
    const sha = await createBlob(owner, repo, file.content, 'utf-8');
    results.push({ path: file.path, sha, mode: '100644', type: 'blob' });
  }
  return results;
}

async function createGitTree(owner, repo, treeEntries, baseTreeSha = null) {
  const body = { tree: treeEntries };
  if (baseTreeSha) body.base_tree = baseTreeSha;

  const { data } = await githubFetch(`/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    stage: 'create_tree',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return data.sha;
}

async function createGitCommit(owner, repo, { message, treeSha, parentSha = null }) {
  const body = {
    message,
    tree: treeSha
  };
  if (parentSha) body.parents = [parentSha];

  const { data } = await githubFetch(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    stage: 'create_commit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return data.sha;
}

async function updateOrCreateBranchRef(owner, repo, branch, commitSha, force = false) {
  const ref = `heads/${branch}`;
  try {
    // Try update first
    const { data } = await githubFetch(`/repos/${owner}/${repo}/git/refs/${ref}`, {
      method: 'PATCH',
      stage: 'update_ref',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: commitSha, force })
    });
    return data;
  } catch (err) {
    if (err.status === 404) {
      // Create new ref
      const { data } = await githubFetch(`/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        stage: 'create_ref',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha })
      });
      return data;
    }
    throw err;
  }
}

module.exports = {
  GitHubApiError,
  getGitHubToken,
  githubFetch,
  getAuthenticatedUser,
  listAllAccessibleRepos,
  createRepository,
  verifyRepository,
  inspectBranchState,
  createBlob,
  createBlobsForFiles,
  createGitTree,
  createGitCommit,
  updateOrCreateBranchRef
};
