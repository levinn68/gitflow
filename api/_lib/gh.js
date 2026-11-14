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

/**
 * Retrieves GITHUB_TOKEN from Vercel Environment Variables without exposing or logging it.
 * Supports both Classic Personal Access Tokens (ghp_...) and Fine-Grained Tokens (github_pat_...).
 */
function getGitHubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return null;
  }
  return token.trim();
}

/**
 * Low-level GitHub REST API wrapper with rate-limit detection, timeout, and structured error mapping.
 * Uses `Authorization: Bearer <token>` which GitHub REST API v2022-11-28 accepts for both Classic (ghp_) and Fine-Grained PATs.
 */
async function ghRequest(path, { method = 'GET', body = null, stage = 'github_api', timeoutMs = 25000 } = {}) {
  const token = getGitHubToken();
  if (!token) {
    throw new GitHubApiError(
      'Server configuration incomplete: GITHUB_TOKEN environment variable is missing on Vercel.',
      {
        status: 500,
        code: 'MISSING_GITHUB_TOKEN',
        stage,
        action: 'Add GITHUB_TOKEN (Classic PAT with "repo" scope) in your Vercel Project Environment Variables.'
      }
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'GitFlow-ZIP-Deployer/1.0'
  };

  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(`${GITHUB_API_BASE}${path}`, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new GitHubApiError('GitHub API request timed out.', {
        status: 504,
        code: 'GITHUB_TIMEOUT',
        stage,
        action: 'Check GitHub status or reduce archive complexity and retry.'
      });
    }
    throw new GitHubApiError('Failed to connect to GitHub REST API.', {
      status: 502,
      code: 'NETWORK_INTERRUPTION',
      stage,
      action: 'Verify network connectivity and retry the operation.'
    });
  } finally {
    clearTimeout(timer);
  }

  const rateRemaining = res.headers.get('x-ratelimit-remaining');
  const rateReset = res.headers.get('x-ratelimit-reset');

  let payload = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      payload = await res.json();
    } catch (_) {
      payload = null;
    }
  } else {
    try {
      const text = await res.text();
      payload = text ? { message: text } : null;
    } catch (_) {
      payload = null;
    }
  }

  if (!res.ok) {
    const apiMessage = (payload && payload.message) ? String(payload.message) : `HTTP ${res.status}`;

    if (res.status === 401) {
      throw new GitHubApiError('GitHub token is invalid, expired, or revoked.', {
        status: 401,
        code: 'INVALID_GITHUB_TOKEN',
        stage,
        action: 'Generate a valid Personal Access Token (Classic "repo" scope) and update GITHUB_TOKEN in Vercel.'
      });
    }

    if (res.status === 403 && (rateRemaining === '0' || /rate limit/i.test(apiMessage))) {
      const resetTime = rateReset ? new Date(Number(rateReset) * 1000).toISOString() : 'shortly';
      throw new GitHubApiError(`GitHub API rate limit exceeded. Resets at ${resetTime}.`, {
        status: 429,
        code: 'GITHUB_RATE_LIMIT',
        stage,
        action: `Wait until ${resetTime} before starting another deployment.`
      });
    }

    if (res.status === 403) {
      throw new GitHubApiError(`GitHub access denied: ${apiMessage}`, {
        status: 403,
        code: 'GITHUB_FORBIDDEN',
        stage,
        action: 'Ensure your Classic Token has the full "repo" scope checked on GitHub.'
      });
    }

    if (res.status === 404) {
      throw new GitHubApiError(`GitHub resource not found: ${apiMessage}`, {
        status: 404,
        code: 'GITHUB_NOT_FOUND',
        stage,
        action: 'Verify that the repository or branch exists and that your token can access it.'
      });
    }

    // Special flag for 409 "Git Repository is empty."
    if (res.status === 409 || /Git Repository is empty/i.test(apiMessage)) {
      throw new GitHubApiError('Git Repository is empty.', {
        status: 409,
        code: 'EMPTY_GIT_REPOSITORY',
        stage,
        action: 'Repository has 0 commits and requires automatic bootstrap initialization.'
      });
    }

    throw new GitHubApiError(`GitHub API error (${res.status}): ${apiMessage}`, {
      status: res.status,
      code: 'GITHUB_API_FAILURE',
      stage,
      action: (payload && Array.isArray(payload.errors) && payload.errors[0]?.message)
        ? payload.errors[0].message
        : 'Review repository permissions and input parameters.'
    });
  }

  return {
    data: payload,
    status: res.status,
    rateLimit: {
      remaining: rateRemaining !== null ? Number(rateRemaining) : null,
      reset: rateReset !== null ? Number(rateReset) : null
    }
  };
}

function isEmptyRepoError(err) {
  if (!err) return false;
  if (err.status === 409 || err.code === 'EMPTY_GIT_REPOSITORY') return true;
  return /Git Repository is empty/i.test(String(err.message || ''));
}

/**
 * Fetches authenticated GitHub user profile to verify token health.
 */
async function getAuthenticatedUser() {
  const { data, rateLimit } = await ghRequest('/user', { stage: 'verify_token' });
  return {
    login: data.login,
    name: data.name || data.login,
    avatarUrl: data.avatar_url,
    htmlUrl: data.html_url,
    rateLimit
  };
}

/**
 * Lists all accessible repositories for the authenticated GitHub token.
 */
async function listAllAccessibleRepos({ page = 1, perPage = 100, fetchAll = true } = {}) {
  const normalizedPerPage = Math.min(Math.max(Number(perPage) || 100, 1), 100);
  const allRepos = [];
  let currentPage = Math.max(Number(page) || 1, 1);
  const maxPages = fetchAll ? 10 : 1;

  for (let i = 0; i < maxPages; i++) {
    const query = `/user/repos?per_page=${normalizedPerPage}&page=${currentPage}&sort=updated&direction=desc&affiliation=owner,collaborator,organization_member`;
    const { data } = await ghRequest(query, { stage: 'list_repos' });
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }
    for (const repo of data) {
      allRepos.push(normalizeRepo(repo));
    }
    if (data.length < normalizedPerPage || !fetchAll) {
      break;
    }
    currentPage += 1;
  }

  return allRepos;
}

function normalizeRepo(repo) {
  const permissions = repo.permissions || {};
  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner ? repo.owner.login : '',
    ownerAvatar: repo.owner ? repo.owner.avatar_url : '',
    private: Boolean(repo.private),
    visibility: repo.visibility || (repo.private ? 'private' : 'public'),
    defaultBranch: repo.default_branch || 'main',
    pushPermission: Boolean(permissions.push || permissions.admin || permissions.maintain),
    description: repo.description || '',
    htmlUrl: repo.html_url,
    updatedAt: repo.updated_at,
    size: typeof repo.size === 'number' ? repo.size : 0
  };
}

/**
 * Creates a new repository under the authenticated GitHub user account.
 */
async function createRepository({ name, description = '', isPrivate = false }) {
  const cleanName = String(name || '').trim();
  if (!cleanName || !/^[A-Za-z0-9._-]+$/.test(cleanName) || cleanName === '.' || cleanName === '..') {
    throw new GitHubApiError(
      'Invalid repository name. Use letters, numbers, hyphens (-), underscores (_), or periods (.).',
      {
        status: 400,
        code: 'INVALID_REPO_NAME',
        stage: 'create_repository',
        action: 'Enter a valid repository name such as "my-project" or "overdrive-web".'
      }
    );
  }

  const { data } = await ghRequest('/user/repos', {
    method: 'POST',
    stage: 'create_repository',
    body: {
      name: cleanName,
      description: String(description || '').trim(),
      private: Boolean(isPrivate),
      auto_init: false
    }
  });

  return normalizeRepo(data);
}

/**
 * Validates that a repository exists and the token has push permissions.
 */
async function verifyRepository(owner, repo) {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  try {
    const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}`, {
      stage: 'verify_repository'
    });
    const normalized = normalizeRepo(data);
    if (!normalized.pushPermission) {
      throw new GitHubApiError(
        `No push permission for repository "${normalized.fullName}".`,
        {
          status: 403,
          code: 'NO_PUSH_PERMISSION',
          stage: 'verify_repository',
          action: 'Choose a repository where your GitHub token has write/push access.'
        }
      );
    }
    return normalized;
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      throw new GitHubApiError(`Repository "${owner}/${repo}" was not found.`, {
        status: 404,
        code: 'REPOSITORY_NOT_FOUND',
        stage: 'verify_repository',
        action: 'Refresh the repository list and select an existing repository.'
      });
    }
    throw err;
  }
}

/**
 * Inspects target branch state safely, catching HTTP 409 ("Git Repository is empty.")
 * on completely bare repositories so it NEVER crashes branch verification.
 */
async function inspectBranchState(owner, repo, targetBranch, defaultBranch = 'main') {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const encodedTarget = targetBranch.split('/').map(encodeURIComponent).join('/');

  // 1. Check if target branch already exists
  try {
    const { data: refData } = await ghRequest(
      `/repos/${safeOwner}/${safeRepo}/git/ref/heads/${encodedTarget}`,
      { stage: 'verify_branch' }
    );
    const commitSha = refData.object.sha;
    const { data: commitData } = await ghRequest(
      `/repos/${safeOwner}/${safeRepo}/git/commits/${commitSha}`,
      { stage: 'verify_branch' }
    );
    return {
      exists: true,
      isEmptyRepo: false,
      commitSha,
      treeSha: commitData.tree.sha
    };
  } catch (err) {
    if (isEmptyRepoError(err)) {
      return {
        exists: false,
        isEmptyRepo: true,
        commitSha: null,
        treeSha: null
      };
    }
    if (!(err instanceof GitHubApiError) || err.status !== 404) {
      throw err;
    }
  }

  // 2. Target branch returned 404. Check if repository has commits on defaultBranch
  if (defaultBranch && defaultBranch !== targetBranch) {
    const encodedDefault = defaultBranch.split('/').map(encodeURIComponent).join('/');
    try {
      const { data: defaultRef } = await ghRequest(
        `/repos/${safeOwner}/${safeRepo}/git/ref/heads/${encodedDefault}`,
        { stage: 'verify_branch' }
      );
      const commitSha = defaultRef.object.sha;
      const { data: commitData } = await ghRequest(
        `/repos/${safeOwner}/${safeRepo}/git/commits/${commitSha}`,
        { stage: 'verify_branch' }
      );
      return {
        exists: false,
        isEmptyRepo: false,
        commitSha,
        treeSha: commitData.tree.sha
      };
    } catch (err) {
      if (isEmptyRepoError(err) || (err instanceof GitHubApiError && err.status === 404)) {
        return {
          exists: false,
          isEmptyRepo: true,
          commitSha: null,
          treeSha: null
        };
      }
      throw err;
    }
  }

  // 3. Fallback check via /commits?per_page=1
  try {
    const { data: commits } = await ghRequest(
      `/repos/${safeOwner}/${safeRepo}/commits?per_page=1`,
      { stage: 'verify_branch' }
    );
    if (Array.isArray(commits) && commits.length > 0) {
      const commitSha = commits[0].sha;
      const treeSha = commits[0].commit?.tree?.sha || null;
      return {
        exists: false,
        isEmptyRepo: false,
        commitSha,
        treeSha
      };
    }
  } catch (err) {
    if (isEmptyRepoError(err) || (err instanceof GitHubApiError && err.status === 404)) {
      return {
        exists: false,
        isEmptyRepo: true,
        commitSha: null,
        treeSha: null
      };
    }
    throw err;
  }

  return {
    exists: false,
    isEmptyRepo: true,
    commitSha: null,
    treeSha: null
  };
}

/**
 * Initializes a completely empty GitHub repository (0 commits) using the Contents API
 * so that GitHub's Git Data API (/git/blobs, /git/trees, /git/commits) unlocks and never returns 409.
 */
async function bootstrapBareRepository(owner, repo, branch, firstFile) {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const encodedPath = firstFile.path.split('/').map(encodeURIComponent).join('/');

  const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}/contents/${encodedPath}`, {
    method: 'PUT',
    stage: 'bootstrap_empty_repo',
    body: {
      message: 'Initialize repository for GitFlow deployment',
      content: firstFile.buffer.toString('base64'),
      branch
    }
  });

  return {
    bootstrapped: true,
    firstBlobSha: data?.content?.sha || null,
    bootstrapCommitSha: data?.commit?.sha || null
  };
}

/**
 * Creates a Git blob for a single file buffer.
 */
async function createBlob(owner, repo, buffer, { allowBootstrap = false, bootstrapBranch = 'main', bootstrapFile = null } = {}) {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);

  try {
    const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}/git/blobs`, {
      method: 'POST',
      stage: 'create_blobs',
      body: {
        content: buffer.toString('base64'),
        encoding: 'base64'
      }
    });
    return { sha: data.sha, bootstrapped: false, bootstrapCommitSha: null };
  } catch (err) {
    if (allowBootstrap && isEmptyRepoError(err) && bootstrapFile) {
      const boot = await bootstrapBareRepository(owner, repo, bootstrapBranch, bootstrapFile);
      if (boot.firstBlobSha) {
        return {
          sha: boot.firstBlobSha,
          bootstrapped: true,
          bootstrapCommitSha: boot.bootstrapCommitSha
        };
      }
      const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}/git/blobs`, {
        method: 'POST',
        stage: 'create_blobs',
        body: {
          content: buffer.toString('base64'),
          encoding: 'base64'
        }
      });
      return {
        sha: data.sha,
        bootstrapped: true,
        bootstrapCommitSha: boot.bootstrapCommitSha
      };
    }
    throw err;
  }
}

/**
 * Creates Git blobs in controlled batches.
 * If isEmptyRepo is true, proactively bootstraps the repository on the first file if needed.
 */
async function createBlobsForFiles(owner, repo, files, { branch = 'main', isEmptyRepo = false, concurrency = 6, onProgress = null } = {}) {
  const results = new Array(files.length);
  let completed = 0;
  let bootstrappedRepo = false;
  let bootstrapCommitSha = null;

  if (files.length > 0) {
    const first = files[0];
    // Always allow bootstrap on the first file in case the repo is empty (0 commits)
    const firstBlob = await createBlob(owner, repo, first.buffer, {
      allowBootstrap: true,
      bootstrapBranch: branch,
      bootstrapFile: first
    });
    bootstrappedRepo = firstBlob.bootstrapped;
    bootstrapCommitSha = firstBlob.bootstrapCommitSha;
    results[0] = {
      path: first.path,
      mode: first.mode || '100644',
      type: 'blob',
      sha: firstBlob.sha
    };
    completed = 1;
    if (typeof onProgress === 'function') {
      onProgress(completed, files.length, first.path);
    }
  }

  let nextIndex = 1;
  async function worker() {
    while (nextIndex < files.length) {
      const idx = nextIndex++;
      const file = files[idx];
      const { sha } = await createBlob(owner, repo, file.buffer);
      results[idx] = {
        path: file.path,
        mode: file.mode || '100644',
        type: 'blob',
        sha
      };
      completed += 1;
      if (typeof onProgress === 'function') {
        onProgress(completed, files.length, file.path);
      }
    }
  }

  const workerCount = Math.min(concurrency, Math.max(files.length - 1, 0));
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { treeItems: results, bootstrappedRepo, bootstrapCommitSha };
}

/**
 * Creates a Git tree.
 * - For empty repositories: omits base_tree to create a clean root Git tree.
 * - For existing repositories: includes base_tree so existing files are preserved without deletion.
 */
async function createGitTree(owner, repo, treeItems, baseTreeSha = null) {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const body = { tree: treeItems };
  if (baseTreeSha) {
    body.base_tree = baseTreeSha;
  }

  const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}/git/trees`, {
    method: 'POST',
    stage: 'create_tree',
    body
  });

  return data.sha;
}

/**
 * Creates a Git commit.
 * - For empty repositories: parents is [] (initial commit without parent).
 * - For existing repositories: parents is [parentCommitSha].
 */
async function createGitCommit(owner, repo, { message, treeSha, parentCommitSha = null }) {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);

  const body = {
    message: String(message || 'Upload project files').trim() || 'Upload project files',
    tree: treeSha,
    parents: parentCommitSha ? [parentCommitSha] : []
  };

  const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}/git/commits`, {
    method: 'POST',
    stage: 'create_commit',
    body
  });

  return {
    sha: data.sha,
    htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/commit/${data.sha}`
  };
}

/**
 * Updates an existing branch reference or creates the first branch reference.
 * Handles empty repositories that were bootstrapped via the Contents API seamlessly.
 */
async function updateOrCreateBranchRef(owner, repo, { branch, commitSha, branchExists, bootstrappedRepo = false, bootstrapCommitSha = null, treeSha = null, commitMessage = 'Upload project files' }) {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');

  if (branchExists) {
    const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}/git/refs/heads/${encodedBranch}`, {
      method: 'PATCH',
      stage: 'update_reference',
      body: {
        sha: commitSha,
        force: false
      }
    });
    return { refData: data, finalCommitSha: commitSha };
  }

  if (bootstrappedRepo) {
    // The Contents API bootstrap created refs/heads/<branch>.
    // Point refs/heads/<branch> to our clean root commit (or child commit if force update is restricted).
    try {
      const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}/git/refs/heads/${encodedBranch}`, {
        method: 'PATCH',
        stage: 'update_reference',
        body: {
          sha: commitSha,
          force: true
        }
      });
      return { refData: data, finalCommitSha: commitSha };
    } catch (err) {
      if (bootstrapCommitSha && treeSha) {
        const childCommit = await createGitCommit(owner, repo, {
          message: commitMessage,
          treeSha,
          parentCommitSha: bootstrapCommitSha
        });
        const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}/git/refs/heads/${encodedBranch}`, {
          method: 'PATCH',
          stage: 'update_reference',
          body: {
            sha: childCommit.sha,
            force: false
          }
        });
        return { refData: data, finalCommitSha: childCommit.sha };
      }
      throw err;
    }
  }

  try {
    const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}/git/refs`, {
      method: 'POST',
      stage: 'create_reference',
      body: {
        ref: `refs/heads/${branch}`,
        sha: commitSha
      }
    });
    return { refData: data, finalCommitSha: commitSha };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 422) {
      const { data } = await ghRequest(`/repos/${safeOwner}/${safeRepo}/git/refs/heads/${encodedBranch}`, {
        method: 'PATCH',
        stage: 'update_reference',
        body: {
          sha: commitSha,
          force: true
        }
      });
      return { refData: data, finalCommitSha: commitSha };
    }
    throw err;
  }
}

module.exports = {
  GitHubApiError,
  isEmptyRepoError,
  getGitHubToken,
  ghRequest,
  getAuthenticatedUser,
  listAllAccessibleRepos,
  createRepository,
  verifyRepository,
  inspectBranchState,
  bootstrapBareRepository,
  createBlob,
  createBlobsForFiles,
  createGitTree,
  createGitCommit,
  updateOrCreateBranchRef
};
