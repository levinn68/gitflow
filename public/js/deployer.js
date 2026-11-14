'use strict';

(function () {
  var token = null;
  try {
    token = sessionStorage.getItem('gitflow_session_token');
  } catch (_) {}

  if (!token) {
    window.location.replace('/login.html');
    return;
  }

  // Auth check on load
  fetch('/api/auth-check', {
    method: 'GET',
    headers: { 'x-gitflow-auth': token },
    cache: 'no-store'
  })
    .then(function (res) {
      if (!res.ok) {
        try { sessionStorage.removeItem('gitflow_session_token'); } catch (_) {}
        window.location.replace('/login.html');
        return null;
      }
      return res.json();
    })
    .then(function (data) {
      if (!data) return;
      document.getElementById('userStatus').textContent = 'Authenticated';
      loadConfig();
      loadRepos();
    })
    .catch(function () {
      window.location.replace('/login.html');
    });

  // Panel switching
  document.querySelectorAll('.nav-item a').forEach(function (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      var panel = link.getAttribute('data-panel');
      document.querySelectorAll('.nav-item a').forEach(function (a) { a.classList.remove('active'); });
      link.classList.add('active');
      document.querySelectorAll('.panel').forEach(function (p) { p.hidden = true; });
      var target = document.getElementById('panel-' + panel);
      if (target) target.hidden = false;
    });
  });

  // Dropzone
  var dropzone = document.getElementById('dropzone');
  var zipInput = document.getElementById('zipInput');
  var selectedFileEl = document.getElementById('selectedFile');
  var deployBtn = document.getElementById('deployBtn');
  var selectedFile = null;

  dropzone.addEventListener('click', function () { zipInput.click(); });
  dropzone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', function () {
    dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  });
  zipInput.addEventListener('change', function () {
    if (zipInput.files && zipInput.files[0]) {
      handleFile(zipInput.files[0]);
    }
  });

  function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      alert('Hanya file .zip yang didukung.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      alert('Ukuran ZIP maksimal 4 MB.');
      return;
    }
    selectedFile = file;
    selectedFileEl.style.display = 'block';
    selectedFileEl.textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
    deployBtn.disabled = false;
  }

  // Monitor helper
  var monitor = document.getElementById('monitor');
  function appendLog(level, message) {
    var div = document.createElement('div');
    div.className = 'log-' + (level || 'info');
    div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    monitor.appendChild(div);
    monitor.scrollTop = monitor.scrollHeight;
  }
  function clearMonitor() {
    monitor.innerHTML = '';
  }

  // Deploy
  deployBtn.addEventListener('click', function () {
    if (!selectedFile) return;

    var owner = document.getElementById('deployOwner').value.trim();
    var repo = document.getElementById('deployRepo').value.trim();
    var branch = document.getElementById('deployBranch').value.trim() || 'main';
    var message = document.getElementById('deployMessage').value.trim() || 'Upload project files';

    if (!owner || !repo) {
      alert('Isi Owner dan Repository terlebih dahulu.');
      return;
    }

    deployBtn.disabled = true;
    clearMonitor();
    appendLog('info', 'Memulai upload...');

    var formData = new FormData();
    formData.append('zip', selectedFile);
    formData.append('owner', owner);
    formData.append('repo', repo);
    formData.append('branch', branch);
    formData.append('message', message);

    fetch('/api/upload?stream=1', {
      method: 'POST',
      headers: { 'x-gitflow-auth': token, 'Accept': 'application/x-ndjson' },
      body: formData
    })
      .then(function (res) {
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function read() {
          return reader.read().then(function (result) {
            if (result.done) {
              deployBtn.disabled = false;
              return;
            }
            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';
            lines.forEach(function (line) {
              if (!line.trim()) return;
              try {
                var obj = JSON.parse(line);
                if (obj.message) {
                  appendLog(obj.level || 'info', obj.message);
                }
                if (obj.ok === true) {
                  appendLog('success', 'Commit: ' + (obj.commitSha || '').slice(0, 8) + '...');
                }
                if (obj.ok === false) {
                  appendLog('error', obj.error || 'Upload failed');
                }
              } catch (_) {}
            });
            return read();
          });
        }
        return read();
      })
      .catch(function (err) {
        appendLog('error', 'Network error: ' + (err.message || err));
        deployBtn.disabled = false;
      });
  });

  // Load config
  function loadConfig() {
    fetch('/api/config', {
      headers: { 'x-gitflow-auth': token },
      cache: 'no-store'
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.githubUser && data.githubUser.login) {
          document.getElementById('userStatus').textContent = '@' + data.githubUser.login;
          if (!document.getElementById('deployOwner').value) {
            document.getElementById('deployOwner').value = data.githubUser.login;
          }
        }
      })
      .catch(function () {});
  }

  // Load repos
  function loadRepos(query) {
    var url = '/api/repos' + (query ? '?q=' + encodeURIComponent(query) : '');
    fetch(url, {
      headers: { 'x-gitflow-auth': token },
      cache: 'no-store'
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var list = document.getElementById('repoList');
        list.innerHTML = '';
        if (!data.ok || !data.repos || data.repos.length === 0) {
          list.innerHTML = '<div style="color:var(--text-muted);padding:12px">Tidak ada repository.</div>';
          return;
        }
        data.repos.forEach(function (repo) {
          var item = document.createElement('div');
          item.className = 'repo-item';
          item.innerHTML = '<div class="repo-name">' + repo.fullName + '</div><div class="repo-meta">' +
            (repo.private ? 'private' : 'public') + '</div>';
          item.addEventListener('click', function () {
            document.getElementById('deployOwner').value = repo.fullName.split('/')[0];
            document.getElementById('deployRepo').value = repo.name;
            document.querySelector('[data-panel="deploy"]').click();
          });
          list.appendChild(item);
        });
      })
      .catch(function () {
        document.getElementById('repoList').innerHTML =
          '<div style="color:var(--danger);padding:12px">Gagal memuat repository.</div>';
      });
  }

  document.getElementById('repoSearch').addEventListener('input', function (e) {
    loadRepos(e.target.value.trim());
  });

  // Create repo
  document.getElementById('createRepoBtn').addEventListener('click', function () {
    var name = document.getElementById('newRepoName').value.trim();
    var description = document.getElementById('newRepoDesc').value.trim();
    var visibility = document.getElementById('newRepoVisibility').value;
    var resultEl = document.getElementById('createResult');

    if (!name) {
      resultEl.textContent = 'Nama repository wajib diisi.';
      resultEl.style.color = 'var(--danger)';
      return;
    }

    resultEl.textContent = 'Membuat...';
    resultEl.style.color = 'var(--text-muted)';

    fetch('/api/create-repo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gitflow-auth': token
      },
      body: JSON.stringify({ name: name, description: description, visibility: visibility })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          resultEl.textContent = 'Berhasil dibuat: ' + data.repo.fullName;
          resultEl.style.color = 'var(--success)';
          loadRepos();
        } else {
          resultEl.textContent = data.error || 'Gagal membuat repository.';
          resultEl.style.color = 'var(--danger)';
        }
      })
      .catch(function () {
        resultEl.textContent = 'Network error.';
        resultEl.style.color = 'var(--danger)';
      });
  });
})();
