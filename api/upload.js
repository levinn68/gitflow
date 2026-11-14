'use strict';

const Busboy = require('busboy');
const JSZip = require('jszip');
const { requireAuth } = require('./_lib/auth');
const {
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
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Validates and normalizes an entry path from a ZIP archive.
 * - Rejects path traversal (..), backslashes, null bytes, leading slashes, Windows drive letters.
 * - Ignores .git directories and .git metadata files.
 */
function validateAndNormalizeZipPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    return { valid: false, error: 'Empty or non-string file path in archive.' };
  }

  if (rawPath.includes('\0')) {
    return { valid: false, error: `Invalid null byte detected in path: "${rawPath}"` };
  }

  if (rawPath.includes('\\')) {
    return { valid: false, error: `Backslash path separator rejected for security: "${rawPath}"` };
  }

  if (/^[A-Za-z]:/.test(rawPath) || rawPath.startsWith('/')) {
    return { valid: false, error: `Absolute or drive-prefixed path rejected: "${rawPath}"` };
  }

  const normalized = rawPath.replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized) {
    return { ignore: true };
  }

  const segments = normalized.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      return {
        valid: false,
        error: `Path traversal or relative segment rejected: "${rawPath}"`
      };
    }
  }

  if (segments.includes('.git') || segments[0] === '__MACOSX' || segments[segments.length - 1] === '.DS_Store') {
    if (segments.includes('.git')) {
      return { ignore: true, reason: 'git_dir' };
    }
  }

  return {
    valid: true,
    ignore: false,
    path: segments.join('/')
  };
}

function isSymlinkEntry(zipEntry) {
  if (!zipEntry || typeof zipEntry.unixPermissions !== 'number') {
    return false;
  }
  const S_IFMT = 0o170000;
  const S_IFLNK = 0o120000;
  return (zipEntry.unixPermissions & S_IFMT) === S_IFLNK;
}

function parseMultipartUpload(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return reject({
        status: 400,
        code: 'INVALID_CONTENT_TYPE',
        stage: 'receive_zip',
        message: 'Format upload harus berupa multipart/form-data.',
        action: 'Unggah file ZIP melalui form GitFlow Workspace.'
      });
    }

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_ZIP_BYTES,
          files: 1,
          fields: 12
        }
      });
    } catch (_) {
      return reject({
        status: 400,
        code: 'MULTIPART_PARSE_ERROR',
        stage: 'receive_zip',
        message: 'Gagal menginisialisasi parser multipart upload.',
        action: 'Pastikan file ZIP valid dan ulangi proses upload.'
      });
    }

    const fields = {};
    let fileBuffer = null;
    let fileName = '';
    let fileExceededLimit = false;

    busboy.on('field', (name, val) => {
      fields[name] = String(val || '').trim();
    });

    busboy.on('file', (name, fileStream, info) => {
      fileName = info?.filename || 'archive.zip';
      const chunks = [];
      let totalBytes = 0;

      fileStream.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_ZIP_BYTES) {
          fileExceededLimit = true;
          fileStream.resume();
          return;
        }
        chunks.push(chunk);
      });

      fileStream.on('limit', () => {
        fileExceededLimit = true;
      });

      fileStream.on('end', () => {
        if (!fileExceededLimit) {
          fileBuffer = Buffer.concat(chunks);
        }
      });
    });

    busboy.on('error', (err) => {
      reject({
        status: 400,
        code: 'UPLOAD_STREAM_ERROR',
        stage: 'receive_zip',
        message: `Gagal membaca stream upload: ${err.message || 'Unknown error'}`,
        action: 'Periksa koneksi jaringan dan coba unggah kembali.'
      });
    });

    busboy.on('finish', () => {
      if (fileExceededLimit) {
        return reject({
          status: 413,
          code: 'ZIP_SIZE_EXCEEDED',
          stage: 'receive_zip',
          message: 'Ukuran file ZIP melebihi batas maksimum 4 MB.',
          action: 'Perkecil ukuran archive ZIP (maksimal 4 MB) atau hapus aset besar seperti node_modules.'
        });
      }
      if (!fileBuffer || fileBuffer.length === 0) {
        return reject({
          status: 400,
          code: 'MISSING_ZIP_FILE',
          stage: 'receive_zip',
          message: 'File ZIP tidak ditemukan atau kosong.',
          action: 'Pilih file ZIP yang valid sebelum menekan tombol Deploy.'
        });
      }
      resolve({ fields, fileBuffer, fileName });
    });

    if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
      busboy.end(req.rawBody);
    } else {
      req.pipe(busboy);
    }
  });
}

async function extractAndValidateZip(zipBuffer, { stripRootFolder = false } = {}) {
  let zip;
  try {
    zip = await JSZip.loadAsync(zipBuffer, { checkCRC32: true });
  } catch (_) {
    throw {
      status: 400,
      code: 'INVALID_ZIP',
      stage: 'extract_archive',
      message: 'File yang diunggah bukan archive ZIP yang valid atau rusak (corrupted).',
      action: 'Pastikan file berformat .zip standar dan tidak diproteksi password.'
    };
  }

  const rawEntries = [];
  const entryNames = Object.keys(zip.files);

  for (const rawName of entryNames) {
    const entry = zip.files[rawName];

    if (isSymlinkEntry(entry)) {
      throw {
        status: 400,
        code: 'UNSUPPORTED_SYMLINK',
        stage: 'validate_paths',
        message: `Symbolic link tidak didukung ditemukan pada path: "${rawName}".`,
        action: 'Hapus symlink dari archive ZIP sebelum melakukan deployment.'
      };
    }

    if (entry.dir) {
      const dirCheck = validateAndNormalizeZipPath(rawName);
      if (dirCheck.valid === false) {
        throw {
          status: 400,
          code: 'INVALID_FILE_PATH',
          stage: 'validate_paths',
          message: dirCheck.error,
          action: 'Pastikan archive ZIP tidak memiliki path relatif (..) atau karakter ilegal.'
        };
      }
      continue;
    }

    const pathCheck = validateAndNormalizeZipPath(rawName);
    if (pathCheck.valid === false) {
      throw {
        status: 400,
        code: 'INVALID_FILE_PATH',
        stage: 'validate_paths',
        message: pathCheck.error,
        action: 'Bersihkan nama file dari karakter ilegal atau path traversal (..).'
      };
    }
    if (pathCheck.ignore) {
      continue;
    }

    rawEntries.push({
      originalPath: pathCheck.path,
      entry
    });
  }

  if (rawEntries.length === 0) {
    throw {
      status: 400,
      code: 'EMPTY_ZIP_ARCHIVE',
      stage: 'extract_archive',
      message: 'Archive ZIP tidak memiliki file yang dapat diunggah.',
      action: 'Pastikan ZIP berisi minimal 1 file project di luar folder .git.'
    };
  }

  if (rawEntries.length > MAX_EXTRACTED_FILES) {
    throw {
      status: 400,
      code: 'FILE_COUNT_EXCEEDED',
      stage: 'extract_archive',
      message: `Jumlah file di dalam ZIP (${rawEntries.length} file) melebihi batas maksimum ${MAX_EXTRACTED_FILES} file.`,
      action: 'Pastikan folder seperti node_modules, .next, atau dist tidak ikut dikompres ke dalam ZIP.'
    };
  }

  let commonRootPrefix = '';
  if (stripRootFolder && rawEntries.length > 0) {
    const firstParts = rawEntries[0].originalPath.split('/');
    if (firstParts.length > 1) {
      const candidateRoot = `${firstParts[0]}/`;
      const allShareRoot = rawEntries.every((item) => item.originalPath.startsWith(candidateRoot));
      if (allShareRoot) {
        commonRootPrefix = candidateRoot;
      }
    }
  }

  const extractedFiles = [];
  const seenPaths = new Set();
  const folderSet = new Set();
  let totalExpandedBytes = 0;

  for (const item of rawEntries) {
    const finalPath = commonRootPrefix
      ? item.originalPath.slice(commonRootPrefix.length)
      : item.originalPath;

    if (!finalPath) continue;

    const segments = finalPath.split('/');
    if (segments.includes('.git')) {
      continue;
    }

    if (seenPaths.has(finalPath)) {
      throw {
        status: 400,
        code: 'DUPLICATE_PATH',
        stage: 'validate_paths',
        message: `Path file duplikat terdeteksi di dalam archive: "${finalPath}".`,
        action: 'Pastikan tidak ada path file yang terduplikasi di dalam ZIP.'
      };
    }
    seenPaths.add(finalPath);

    for (let i = 1; i < segments.length; i++) {
      folderSet.add(segments.slice(0, i).join('/'));
    }

    const contentBuffer = await item.entry.async('nodebuffer');
    totalExpandedBytes += contentBuffer.length;

    if (totalExpandedBytes > MAX_EXPANDED_BYTES) {
      throw {
        status: 413,
        code: 'EXPANDED_SIZE_EXCEEDED',
        stage: 'extract_archive',
        message: 'Total ukuran hasil ekstraksi melebihi batas maksimum 18 MB.',
        action: 'Kurangi ukuran file di dalam ZIP hingga hasil ekstraksi di bawah 18 MB.'
      };
    }

    let mode = '100644';
    if (typeof item.entry.unixPermissions === 'number' && (item.entry.unixPermissions & 0o111) !== 0) {
      mode = '100755';
    }

    extractedFiles.push({
      path: finalPath,
      size: contentBuffer.length,
      mode,
      buffer: contentBuffer
    });
  }

  if (extractedFiles.length === 0) {
    throw {
      status: 400,
      code: 'EMPTY_ZIP_ARCHIVE',
      stage: 'extract_archive',
      message: 'Tidak ada file valid yang tersisa setelah pembersihan struktur archive.',
      action: 'Periksa isi file ZIP Anda dan coba lagi.'
    };
  }

  return {
    files: extractedFiles,
    totalFiles: extractedFiles.length,
    totalFolders: folderSet.size,
    totalExpandedBytes,
    strippedRoot: commonRootPrefix ? commonRootPrefix.replace(/\/$/, '') : null
  };
}

async function handler(req, res) {
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

  const wantsStream =
    req.headers['x-gitflow-stream'] === '1' ||
    (req.headers['accept'] || '').includes('application/x-ndjson');

  const logs = [];
  let currentStage = 'init';

  function emitProgress({ status = 'PROCESSING', percent = 0, level = 'INFO', message = '', stage = currentStage }) {
    currentStage = stage;
    const entry = {
      type: 'progress',
      timestamp: formatTimestamp(),
      status,
      percent,
      level,
      stage,
      message
    };
    logs.push(entry);
    if (wantsStream && !res.writableEnded) {
      res.write(JSON.stringify(entry) + '\n');
    }
  }

  if (wantsStream) {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Accel-Buffering': 'no'
    });
  }

  try {
    emitProgress({
      status: 'PROCESSING',
      percent: 5,
      level: 'INFO',
      stage: 'upload_started',
      message: 'Upload job started'
    });

    const { fields, fileBuffer, fileName } = await parseMultipartUpload(req);

    const repoFullName = String(fields.repository || fields.repo || '').trim();
    const requestedBranch = String(fields.branch || '').trim();
    const commitMessage = String(fields.commitMessage || 'Upload project files').trim() || 'Upload project files';
    const stripRootFolder = fields.stripRoot === 'true' || fields.stripRoot === '1';

    if (!repoFullName || !repoFullName.includes('/')) {
      throw {
        status: 400,
        code: 'INVALID_REPOSITORY',
        stage: 'verify_repository',
        message: 'Destination repository belum dipilih atau format tidak valid (owner/repo).',
        action: 'Pilih repository tujuan dari daftar atau buat repository baru terlebih dahulu.'
      };
    }

    const [owner, repo] = repoFullName.split('/');

    emitProgress({
      status: 'PROCESSING',
      percent: 12,
      level: 'INFO',
      stage: 'verify_repository',
      message: `Checking repository ${owner}/${repo}`
    });

    const repoInfo = await verifyRepository(owner, repo);
    const targetBranch = requestedBranch || repoInfo.defaultBranch || 'main';

    if (!/^[A-Za-z0-9._/-]+$/.test(targetBranch) || targetBranch.includes('..') || targetBranch.startsWith('/') || targetBranch.endsWith('/')) {
      throw {
        status: 400,
        code: 'INVALID_BRANCH_NAME',
        stage: 'verify_branch',
        message: `Nama branch "${targetBranch}" tidak valid.`,
        action: 'Gunakan nama branch standar seperti main, master, atau feature/update.'
      };
    }

    const branchState = await inspectBranchState(owner, repo, targetBranch, repoInfo.defaultBranch);

    emitProgress({
      status: 'PROCESSING',
      percent: 22,
      level: 'SUCCESS',
      stage: 'verify_repository',
      message: `Repository verified (${repoInfo.fullName} @ ${targetBranch}${branchState.isEmptyRepo ? ' — empty repo auto-init mode' : ''})`
    });

    emitProgress({
      status: 'PROCESSING',
      percent: 28,
      level: 'SUCCESS',
      stage: 'receive_zip',
      message: `Archive received (${fileName}, ${(fileBuffer.length / 1024).toFixed(1)} KB)`
    });

    const extracted = await extractAndValidateZip(fileBuffer, { stripRootFolder });

    emitProgress({
      status: 'PROCESSING',
      percent: 38,
      level: 'SUCCESS',
      stage: 'extract_archive',
      message: `${extracted.totalFiles} files extracted across ${extracted.totalFolders} folders`
    });

    emitProgress({
      status: 'PROCESSING',
      percent: 42,
      level: 'INFO',
      stage: 'create_blobs',
      message: `Creating Git blobs (${extracted.totalFiles} files)`
    });

    let lastReportedMilestone = 0;
    const { treeItems, bootstrappedRepo, bootstrapCommitSha } = await createBlobsForFiles(owner, repo, extracted.files, {
      branch: targetBranch,
      isEmptyRepo: branchState.isEmptyRepo,
      concurrency: 6,
      onProgress: (done, total) => {
        const ratio = done / total;
        const pct = Math.min(78, Math.round(42 + ratio * 36));
        const stepSize = Math.max(1, Math.ceil(total / 4));
        if (done === total || done - lastReportedMilestone >= stepSize) {
          lastReportedMilestone = done;
          emitProgress({
            status: 'PROCESSING',
            percent: pct,
            level: 'INFO',
            stage: 'create_blobs',
            message: `Uploaded ${done}/${total} Git blobs`
          });
        }
      }
    });

    const baseTreeSha = branchState.isEmptyRepo ? null : branchState.treeSha;
    const newTreeSha = await createGitTree(owner, repo, treeItems, baseTreeSha);

    emitProgress({
      status: 'PROCESSING',
      percent: 86,
      level: 'SUCCESS',
      stage: 'create_tree',
      message: `Git tree created (${newTreeSha.slice(0, 7)})`
    });

    emitProgress({
      status: 'PROCESSING',
      percent: 92,
      level: 'INFO',
      stage: 'create_commit',
      message: 'Creating commit'
    });

    const parentCommitSha = branchState.isEmptyRepo ? null : branchState.commitSha;
    const commitResult = await createGitCommit(owner, repo, {
      message: commitMessage,
      treeSha: newTreeSha,
      parentCommitSha
    });

    const refUpdate = await updateOrCreateBranchRef(owner, repo, {
      branch: targetBranch,
      commitSha: commitResult.sha,
      branchExists: branchState.exists,
      bootstrappedRepo,
      bootstrapCommitSha,
      treeSha: newTreeSha,
      commitMessage
    });

    const finalSha = refUpdate?.finalCommitSha || commitResult.sha;

    emitProgress({
      status: 'SUCCESS',
      percent: 100,
      level: 'SUCCESS',
      stage: 'completed',
      message: `Commit completed (${finalSha.slice(0, 7)})`
    });

    const finalPayload = {
      type: 'result',
      ok: true,
      status: 'SUCCESS',
      result: {
        commitSha: finalSha,
        shortSha: finalSha.slice(0, 7),
        repository: repoInfo.fullName,
        repoUrl: repoInfo.htmlUrl,
        branch: targetBranch,
        branchUrl: `${repoInfo.htmlUrl}/tree/${encodeURIComponent(targetBranch)}`,
        commitUrl: `https://github.com/${owner}/${repo}/commit/${finalSha}`,
        commitMessage,
        totalFiles: extracted.totalFiles,
        totalFolders: extracted.totalFolders,
        totalBytes: extracted.totalExpandedBytes,
        isInitialCommit: Boolean(branchState.isEmptyRepo)
      },
      logs
    };

    if (wantsStream) {
      res.write(JSON.stringify(finalPayload) + '\n');
      return res.end();
    }

    return res.status(200).json(finalPayload);
  } catch (err) {
    const status = (err && typeof err.status === 'number') ? err.status : 500;
    const code = (err && err.code) ? err.code : 'DEPLOYMENT_FAILED';
    const stage = (err && err.stage) ? err.stage : currentStage;
    const message = (err && err.message) ? err.message : 'Terjadi kesalahan saat memproses upload ke GitHub.';
    const action = (err && err.action)
      ? err.action
      : 'Periksa kembali file ZIP, izin repository, dan konfigurasi GITHUB_TOKEN Anda.';

    emitProgress({
      status: 'FAILED',
      percent: 100,
      level: 'ERROR',
      stage,
      message: `Error [${stage}]: ${message}`
    });

    const errorPayload = {
      type: 'result',
      ok: false,
      status: 'FAILED',
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
}

handler.config = {
  api: {
    bodyParser: false
  }
};
handler.validateAndNormalizeZipPath = validateAndNormalizeZipPath;
handler.extractAndValidateZip = extractAndValidateZip;

module.exports = handler;
