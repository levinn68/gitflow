# GitFlow ZIP Deployer v1.0

**One ZIP. One destination. One clean commit.**

GitFlow adalah aplikasi web berbasis **Vercel Serverless Functions** dan **GitHub REST API** untuk mengunggah project berbentuk archive `.zip` langsung ke repository GitHub sebagai satu commit Git yang bersih tanpa infrastruktur tambahan.

---

## Arsitektur & Struktur Direktori

```text
gitflow/
|-- api/
|   |-- _lib/
|   |   |-- auth.js          # Verifikasi DEPLOY_KEY (timing-safe SHA-256) & stateless HMAC session
|   |   |-- gh.js            # Wrapper GitHub REST API (2022-11-28) & Git Data API engine
|   |-- auth-check.js        # Endpoint login & verifikasi sesi autentikasi
|   |-- config.js            # Endpoint status environment & batas sistem (tanpa membocorkan secret)
|   |-- repos.js             # Endpoint daftar seluruh repository akun GitHub + filter pencarian
|   |-- create-repo.js       # Endpoint pembuatan repository baru (Public / Private)
|   |-- upload.js            # Git Upload Engine (Busboy + JSZip + NDJSON real-time telemetry)
|
|-- public/
|   |-- index.html           # Auth gate router (mengarahkan ke login.html jika belum login)
|   |-- login.html           # Halaman login custom password (DEPLOY_KEY)
|   |-- dashboard.html       # Workspace utama GitFlow ZIP Deployer
|   |-- login.css            # Stylesheet halaman login (Dark Graphite + Lime Green)
|   |-- css/
|   |   |-- dashboard.css    # Stylesheet workspace utama & animasi 3D Spatial
|   |-- js/
|   |   |-- deployer.js      # Logika frontend, ekstraksi preview JSZip, & stream Process Monitor
|   |-- assets/
|       |-- favicon.svg      # Ikon vektor GitFlow
|
|-- package.json
|-- vercel.json
```

---

## Konfigurasi Vercel Environment Variables

Tambahkan dua variabel berikut pada **Project Settings → Environment Variables** di Vercel:

| Variable | Deskripsi |
| :--- | :--- |
| `DEPLOY_KEY` | Password rahasia untuk login (disimpan sebagai hash SHA-256) |
| `GITHUB_TOKEN` | Personal Access Token GitHub dengan scope `repo` |

---

## Cara Deploy

1. Import repository ini ke Vercel
2. Set environment variables di atas
3. Deploy

Setelah deploy, buka URL Vercel → halaman login → masukkan `DEPLOY_KEY` → dashboard siap digunakan.

---

## Fitur Utama

- Login berbasis `DEPLOY_KEY` (stateless HMAC session)
- List & search repository GitHub
- Create repository baru (public/private)
- Upload ZIP → ekstrak → commit tunggal bersih ke branch yang dipilih
- Real-time process monitor (NDJSON stream)
- Preview struktur file dari ZIP sebelum upload

---

**GitFlow v1.0** — One ZIP. One destination. One clean commit.
