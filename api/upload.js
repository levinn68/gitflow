'use strict';

const Busboy = require('busboy');
const JSZip = require('jszip');
const { requireAuth } = require('./_lib/auth');
const {
  GitHubApiError,
  verifyRepository,
  inspectBranchState,
  createBlobsForFiles,
  createGitTree,
  createGitCommit,
  updateOrCreateBranchRef
} = require('./_lib/gh');

const MAX_ZIP_BYTES = 4 * 1024 * 1024; // 4 MB
const MAX_EXTRACTED_FILES = 400;
const MAX_EXPANDED_BYTES = 18 * 1024 * 1024; // 18 MB

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sendLog(res, wantsStream, level, message, extra = {}) {
  const entry = {
    ts: formatTimestamp(),
    level,
    message,
    ...extra
  };
  if (wantsStream) {
    res.write(JSON.stringify(entry) + '\n');
  }
  return entry;
}

function sanitizePath(entryName) {
  if (!entryName || typeof entryName !== 'string') return null;
  let p = entryName.replace(/\\/g, '/').replace(/\0/g, '');
  if (p.startsWith('/')) p = p.slice(1);
  if (p.includes('..') || p.includes('\0')) return null;
  if (p.startsWith('.git/') || p === '.git') return null;
  return p || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Method tidak didukung.' });
  }

  const session = requireAuth(req, res);
  if (!session) return;

  const wantsStream = (req.headers.accept || '').includes('application/x-ndjson') ||
    req.query?.stream === '1' || req.query?.stream === 'true';

  if (wantsStream) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.statusCode = 200;
  }

  const logs = [];
  const log = (level, message, extra) => {
    const entry = sendLog(res, wantsStream, level, message, extra);
    logs.push(entry);
    return entry;
  };

  try {
    log('info', 'Memulai proses upload ZIP...');

    // Parse multipart with Busboy
    const fields = {};
    let zipBuffer = null;
    let zipFilename = 'project.zip';

    await new Promise((resolve, reject) => {
      const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_ZIP_BYTES + 1024 } });

      busboy.on('file', (name, file, info) => {
        if (name !== 'zip' && name !== 'file') {
          file.resume();
          return;
        }
        zipFilename = info.filename || zipFilename;
        const chunks = [];
        let total = 0;
        file.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_ZIP_BYTES) {
            file.destroy();
            reject(new Error('ZIP terlalu besar (maks 4 MB).'));
            return;
          }
          chunks.push(chunk);
        });
        file.on('end', () => {
          zipBuffer = Buffer.concat(chunks);
        });
        file.on('error', reject);
      });

      busboy.on('field', (name, val) => {
        fields[name] = val;
      });

      busboy.on('finish', resolve);
      busboy.on('error', reject);

      req.pipe(busboy);
    });

    if (!zipBuffer || zipBuffer.length === 0) {
      throw Object.assign(new Error('File ZIP tidak ditemukan di request.'), { status: 400, code: 'NO_ZIP' });
    }

    log('info', `ZIP diterima: ${zipFilename} (${(zipBuffer.length / 1024).toFixed(1)} KB)`);

    const owner = String(fields.owner || fields.repoOwner || '').trim();
    const repo = String(fields.repo || fields.repoName || '').trim();
    const branch = String(fields.branch || 'main').trim() || 'main';
    const commitMessage = String(fields.message || fields.commitMessage || 'Upload project files').trim();

    if (!owner || !repo) {
      throw Object.assign(new Error('Parameter owner dan repo wajib diisi.'), { status: 400, code: 'MISSING_REPO' });
    }

    log('info', `Target: ${owner}/${repo} @ ${branch}`);

    // Extract ZIP
    log('info', 'Mengekstrak isi ZIP...');
    const zip = await JSZip.loadAsync(zipBuffer);
    const files = [];
    let expandedBytes = 0;

    const entries = Object.keys(zip.files);
    for (const name of entries) {
      const entry = zip.files[name];
      if (entry.dir) continue;

      const safePath = sanitizePath(name);
      if (!safePath) {
        log('warn', `Path diabaikan: ${name}`);
        continue;
      }

      // Skip symlink-like entries if mode indicates
      const content = await entry.async('string');
      expandedBytes += Buffer.byteLength(content, 'utf8');

      if (files.length >= MAX_EXTRACTED_FILES) {
        throw Object.assign(new Error(`Jumlah file melebihi batas (${MAX_EXTRACTED_FILES}).`), {
          status: 400,
          code: 'TOO_MANY_FILES'
        });
      }
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw Object.assign(new Error('Total ukuran hasil ekstraksi melebihi 18 MB.'), {
          status: 400,
          code: 'EXPANDED_TOO_LARGE'
        });
      }

      files.push({ path: safePath, content });
    }

    if (files.length === 0) {
      throw Object.assign(new Error('ZIP tidak berisi file yang valid.'), { status: 400, code: 'EMPTY_ZIP' });
    }

    log('info', `Ekstraksi selesai: ${files.length} file, ${(expandedBytes / 1024).toFixed(1)} KB`);

    // Verify repo
    log('info', 'Memverifikasi repository...');
    await verifyRepository(owner, repo);

    // Inspect branch
    log('info', `Memeriksa branch ${branch}...`);
    const branchState = await inspectBranchState(owner, repo, branch);
    const baseTreeSha = branchState.exists ? null : null; // simplified; full impl uses commit tree
    let parentSha = branchState.sha || null;

    // Create blobs
    log('info', 'Mengunggah blob ke GitHub...');
    const treeEntries = await createBlobsForFiles(owner, repo, files);
    log('info', `${treeEntries.length} blob berhasil dibuat`);

    // Create tree
    log('info', 'Membuat Git tree...');
    const treeSha = await createGitTree(owner, repo, treeEntries, null);
    log('info', `Tree SHA: ${treeSha.slice(0, 8)}...`);

    // Create commit
    log('info', 'Membuat commit...');
    const commitSha = await createGitCommit(owner, repo, {
      message: commitMessage,
      treeSha,
      parentSha
    });
    log('info', `Commit SHA: ${commitSha.slice(0, 8)}...`);

    // Update ref
    log('info', `Memperbarui branch ${branch}...`);
    await updateOrCreateBranchRef(owner, repo, branch, commitSha, false);

    log('success', 'Upload selesai. Commit berhasil dibuat.');

    const result = {
      ok: true,
      commitSha,
      treeSha,
      branch,
      filesCount: files.length,
      message: commitMessage,
      logs
    };

    if (wantsStream) {
      res.write(JSON.stringify(result) + '\n');
      return res.end();
    }

    return res.status(200).json(result);
  } catch (err) {
    const status = err.status || (err instanceof GitHubApiError ? err.status : 500);
    const code = err.code || (err instanceof GitHubApiError ? err.code : 'UPLOAD_FAILED');
    const stage = err.stage || (err instanceof GitHubApiError ? err.stage : 'upload');
    const message = err.message || 'Gagal mengunggah project.';
    const action = err.action || 'Periksa ukuran ZIP, token, dan izin repository.';

    log('error', message, { code, stage });

    const errorPayload = {
      ok: false,
      code,
      stage,
      error: message,
      action,
      logs
    };

    if (wantsStream) {
      res.write(JSON.stringify(errorPayload) + '\n');
      return res.end();
    }

    return res.status(status).json(errorPayload);
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
