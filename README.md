# Shado Cloud

A fully featured cloud drive.

## Features

- File upload, download, and sharing
- Secure cookie-based authentication via [shado-auth-api](https://github.com/shadijiha/shado-auth-api) microservice
- Admin panel
- Music streaming via [Smusic](https://github.com/shadijiha/shado-music-api) *(separate microservice, not included in this repo)*

## Quick Server Setup

To provision a fresh Ubuntu machine into a fully working Shado Cloud server, run:

```bash
cd setup-new-server-script
chmod +x master-setup.sh
./master-setup.sh
```

This installs all dependencies (Node.js, Docker, Apache, Chromium, Certbot, etc.), sets up Git SSH keys, clones all repos, restores the database and cloud files from the existing server's backup API, configures HTTPS with Let's Encrypt, and starts everything via PM2.

See [`setup-new-server-script/`](setup-new-server-script/) for details.

---

## Architecture

```
┌─────────────────────────────────────┐
│     shado-cloud (HTTP :9000)        │
│                                     │
│  Local User entity (numeric id)     │
│  ├── shadoUserId (UUID → auth-api)  │
│  ├── files, logs, temp URLs, etc.   │
│  └── no auth data stored locally    │
│                                     │
│  FilesController                    │
│  DirsController                     │
│  TempUrlController                  │
│  AdminModule (Admin panel, etc.)    │
│  UserProfileModule                  │
│  Swagger (HTTP layer)               │
└──────────────┬──────────────────────┘
               │ TCP :11002
               ▼
┌─────────────────────────────────────┐
│  shado-auth-api (HTTP :11001)       │
│                                     │
│  ShadoUser (UUID, source of truth)  │
│  Owns: email, name, password,       │
│        is_admin                     │
│                                     │
│  Login / Register / Logout / Me     │
│  Token validation (TCP)             │
│  User lookup (TCP)                  │
│  Change password / name (TCP)       │
│  Swagger: /api                      │
└─────────────────────────────────────┘
```

Authentication and user profile data (email, name, password, admin status) are fully owned by [shado-auth-api](https://github.com/shadijiha/shado-auth-api) via the `ShadoUser` entity (UUID primary key).

shado-cloud maintains a local `User` entity with an auto-increment numeric `id` for DB relations (files, logs, temp URLs, etc.) and a `shadoUserId` column linking to the auth-api. The local `User` stores no auth or profile data — when shado-cloud needs the user's email or name, it fetches it from auth-api via TCP. Profile mutations (change password, change name) are forwarded to auth-api.

The frontend calls shado-auth-api directly for login, register, logout, and me. All other requests go to shado-cloud, which validates the auth cookie via TCP (`validate_cookie` — raw cookie header is forwarded to auth-api, which owns all cookie knowledge).

## Screenshots

![](https://github.com/shadijiha/shado-cloud/blob/nest-js-backend/readme%20images/Capture.PNG?raw=true)
![](https://github.com/shadijiha/shado-cloud/blob/nest-js-backend/readme%20images/upload.png?raw=true)
![](https://github.com/shadijiha/shado-cloud/blob/nest-js-backend/readme%20images/share.png?raw=true)
![](https://github.com/shadijiha/shado-cloud/blob/nest-js-backend/readme%20images/manage%20shared.PNG?raw=true)
![](https://github.com/shadijiha/shado-cloud/blob/nest-js-backend/readme%20images/auth.PNG?raw=true)
