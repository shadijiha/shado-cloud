#!/usr/bin/env python3
"""
Master Setup Script for Shado Cloud + Shado Gym App.
Provisions a fresh Ubuntu machine into a fully working server.

Run via:  chmod +x master-setup.sh && ./master-setup.sh
"""

import getpass, json, os, re, shutil, subprocess, sys, tempfile, textwrap, zipfile
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.cookiejar import CookieJar
from urllib.request import HTTPCookieProcessor, build_opener

# ── Config ────────────────────────────────────────────────────────────────────
API_BASE = "https://cloud.shadijiha.com/apinest"
ADMIN_EMAIL = "admin@shado.com"
INSTALL_DIR = Path.home() / "Desktop"
CLOUD_DIR = INSTALL_DIR / "shado-cloud-data"
MTX_VERSION = "v1.9.3"

REPOS = {
    "shado-cloud": "git@github.com:shadijiha/shado-cloud.git",
    "shado-cloud-frontend": "git@github.com:shadijiha/shado-cloud-frontend.git",
    "shado-gym-app": "git@github.com:shadijiha/shado-gym-app.git",
}

# ── Helpers ───────────────────────────────────────────────────────────────────
C = "\033[0;36m"; G = "\033[0;32m"; Y = "\033[1;33m"; R = "\033[0;31m"; N = "\033[0m"

def step(num: str, msg: str):
    print(f"\n{C}━━━ [{num}] {msg} ━━━{N}")

def ok(msg: str):
    print(f"{G}✓ {msg}{N}")

def warn(msg: str):
    print(f"{Y}⚠ {msg}{N}")

def fail(msg: str):
    print(f"{R}✗ {msg}{N}")
    sys.exit(1)

def run(cmd: str, check=True, **kw):
    """Run a shell command, streaming output."""
    return subprocess.run(cmd, shell=True, check=check, **kw)

def run_quiet(cmd: str, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)

def ask_yn(prompt: str, default: bool = True) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    ans = input(f"{prompt} {suffix}: ").strip().lower()
    if not ans:
        return default
    return ans in ("y", "yes")

def human_bytes(n: float) -> str:
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {u}"
        n /= 1024
    return f"{n:.1f} TB"

# ── HTTP client (cookie-aware) ────────────────────────────────────────────────
cookie_jar = CookieJar()
opener = build_opener(HTTPCookieProcessor(cookie_jar))

def api(method: str, path: str, body: dict | None = None, stream=False) -> any:
    url = f"{API_BASE}/{path.lstrip('/')}"
    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    resp = opener.open(req)
    if stream:
        return resp  # caller reads line-by-line
    return json.loads(resp.read().decode())

def download_file(path: str, dest: Path):
    """Download a file from the API to disk, showing progress."""
    url = f"{API_BASE}/{path.lstrip('/')}"
    req = Request(url)
    resp = opener.open(req)
    total = int(resp.headers.get("Content-Length", 0))
    downloaded = 0
    with open(dest, "wb") as f:
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            f.write(chunk)
            downloaded += len(chunk)
            if total:
                pct = downloaded * 100 // total
                print(f"\r  Downloading... {human_bytes(downloaded)} / {human_bytes(total)} ({pct}%)", end="", flush=True)
            else:
                print(f"\r  Downloading... {human_bytes(downloaded)}", end="", flush=True)
    print()

# ── SSE reader ────────────────────────────────────────────────────────────────
def follow_sse(path: str) -> str | None:
    """
    Follow an SSE endpoint, print progress, return the downloadPath on completion.
    """
    resp = api("GET", path, stream=True)
    download_path = None
    for raw_line in resp:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line.startswith("data:"):
            continue
        data_str = line[len("data:"):].strip()
        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            continue

        evt_type = data.get("type", "")
        if evt_type == "progress":
            step_msg = data.get("step", "")
            pct = data.get("percent", "")
            total = data.get("totalBytes")
            processed = data.get("processedBytes")
            parts = [step_msg]
            if pct not in ("", None):
                parts.append(f"{pct}%")
            if total and processed:
                parts.append(f"({human_bytes(processed)} / {human_bytes(total)})")
            print(f"\r  {Y}{' — '.join(parts)}{N}          ", end="", flush=True)
        elif evt_type == "complete":
            print()
            download_path = data.get("downloadPath")
            ok("Backup ready on server")
            break
        elif evt_type == "error":
            print()
            warn(f"Server error: {data.get('message', '?')}")
            break
    resp.close()
    return download_path


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════
def main():
    print(f"{C}╔══════════════════════════════════════════════╗{N}")
    print(f"{C}║   Shado Cloud — Master Setup                 ║{N}")
    print(f"{C}╚══════════════════════════════════════════════╝{N}")
    print()

    password = getpass.getpass(f"Enter admin password for {ADMIN_EMAIL}: ")

    # ── 1. System packages ────────────────────────────────────────────────────
    step("1/10", "Installing system packages")
    run("sudo apt update && sudo apt upgrade -y")
    run(
        "sudo apt install -y "
        "curl wget git build-essential software-properties-common "
        "xorg xdotool scrot ffmpeg xserver-xorg-video-dummy "
        "apache2 graphicsmagick ghostscript "
        "unzip jq bc certbot python3-certbot-apache "
        # Puppeteer / Chromium deps (for pdf2pic / thumbnails)
        "ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 "
        "libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 "
        "libfontconfig1 libgbm1 libgcc-s1 libglib2.0-0 libgtk-3-0 libnspr4 "
        "libnss3 libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 "
        "libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 "
        "libxi6 libxrandr2 libxrender1 libxshmfence1 libxss1 libxtst6 "
        "wget xdg-utils chromium-browser"
    )
    # Verify chromium-browser is at expected path
    if Path("/usr/bin/chromium-browser").exists():
        ok("Chromium installed at /usr/bin/chromium-browser")
    else:
        # Some Ubuntu versions install as 'chromium' instead
        run("sudo ln -sf $(which chromium || which chromium-browser) /usr/bin/chromium-browser", check=False)
        warn("Created symlink to /usr/bin/chromium-browser")
    ok("System packages installed")

    # ── Git SSH setup ─────────────────────────────────────────────────────────
    ssh_dir = Path.home() / ".ssh"
    ssh_dir.mkdir(mode=0o700, exist_ok=True)
    key_path = ssh_dir / "id_ed25519"

    if key_path.exists():
        ok(f"SSH key already exists at {key_path}")
    else:
        print(f"\n{Y}  Git SSH key required for cloning repos.{N}")
        email = input("  Enter your GitHub email: ").strip()
        run(f'ssh-keygen -t ed25519 -C "{email}" -f {key_path} -N ""')
        ok("SSH key generated")

    # Start ssh-agent and add key
    run(f'eval "$(ssh-agent -s)" && ssh-add {key_path}', check=False)

    # Check if GitHub already recognizes this key
    test = run_quiet("ssh -T git@github.com -o StrictHostKeyChecking=accept-new")
    if "successfully authenticated" not in (test.stdout + test.stderr).lower():
        pub_key = key_path.with_suffix(".pub").read_text().strip()
        print(f"\n{Y}══════════════════════════════════════════════{N}")
        print(f"{Y}  Copy this public key and add it to GitHub:{N}")
        print(f"{Y}  https://github.com/settings/ssh/new{N}")
        print(f"{Y}══════════════════════════════════════════════{N}")
        print(f"\n{C}{pub_key}{N}\n")
        input(f"{Y}Press Enter once you've added the key to GitHub...{N}")

        # Verify
        result = run_quiet("ssh -T git@github.com -o StrictHostKeyChecking=accept-new")
        if "successfully authenticated" in (result.stdout + result.stderr).lower():
            ok("SSH connection to GitHub verified")
        else:
            warn("Could not verify SSH — will try anyway. Output: " + (result.stderr or result.stdout).strip())
    else:
        ok("SSH connection to GitHub already working")

    # ── 2. Docker ─────────────────────────────────────────────────────────────
    step("2/10", "Installing Docker")
    if shutil.which("docker") is None:
        run("curl -fsSL https://get.docker.com | sudo sh")
        run(f"sudo usermod -aG docker {os.environ['USER']}")
        ok("Docker installed (re-login for group to take effect)")
    else:
        ok("Docker already installed")
    run("sudo systemctl enable --now docker")
    # docker compose plugin
    if run_quiet("docker compose version").returncode != 0:
        run("sudo apt install -y docker-compose-plugin")
    ok("Docker + Compose ready")

    # ── 3. Node.js (latest LTS) ──────────────────────────────────────────────
    step("3/10", "Installing latest Node.js")
    node_ver = run_quiet("node -v")
    need_node = node_ver.returncode != 0
    if need_node:
        run("curl -fsSL https://deb.nodesource.com/setup_current.x | sudo -E bash -")
        run("sudo apt install -y nodejs")
    else:
        ok(f"Node already installed: {node_ver.stdout.strip()}")
    run("sudo npm install -g pm2 @nestjs/cli", check=False)
    ok(f"Node {run_quiet('node -v').stdout.strip()} / npm {run_quiet('npm -v').stdout.strip()} / pm2 + nest-cli")

    # ── 4. Clone repos ────────────────────────────────────────────────────────
    step("4/10", "Cloning repositories")
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in REPOS.items():
        dest = INSTALL_DIR / name
        if (dest / ".git").is_dir():
            print(f"  Pulling {name}...")
            run(f"git -C {dest} pull")
        else:
            print(f"  Cloning {name}...")
            run(f"git clone {url} {dest}")
    ok("Repos ready")

    # ── 5. Authenticate ──────────────────────────────────────────────────────
    step("5/10", "Authenticating with Shado Cloud API")
    try:
        resp = api("POST", "/auth/login", {"email": ADMIN_EMAIL, "password": password})
    except HTTPError as e:
        fail(f"Login request failed: {e}")
    errors = resp.get("errors", [])
    if errors:
        fail(f"Login failed: {errors[0].get('message', 'Unknown error')}")
    ok("Authenticated successfully")

    # ── 6. Server backup (DB + .env + Apache) via SSE ─────────────────────────
    step("6/10", "Downloading server backup (DB dump + .env + Apache config)")
    server_zip = Path("/tmp/server-backup.zip")
    dl_path = follow_sse("/admin/server-setup/stream")
    if dl_path:
        print("  Downloading zip from server...")
        download_file(dl_path, server_zip)
        ok("Server backup downloaded")
    else:
        warn("No download path received for server backup")

    # ── 7. Cloud files backup via SSE ─────────────────────────────────────────
    step("7/10", "Downloading full cloud files backup")
    cloud_zip = Path("/tmp/cloud-backup.zip")
    dl_path = follow_sse("/admin/cloud-backup/stream")
    if dl_path:
        print("  Downloading cloud files zip...")
        download_file(dl_path, cloud_zip)
        ok("Cloud backup downloaded")
    else:
        warn("No download path received for cloud backup")

    # ── 8. Extract & seed ─────────────────────────────────────────────────────
    step("8/10", "Extracting backups and seeding database")
    cloud_app = INSTALL_DIR / "shado-cloud"

    if server_zip.exists():
        extract_dir = Path("/tmp/server-backup")
        extract_dir.mkdir(exist_ok=True)
        with zipfile.ZipFile(server_zip) as zf:
            zf.extractall(extract_dir)
        ok("Server backup extracted")

        # .env
        env_src = extract_dir / "env-file.txt"
        env_dest = cloud_app / ".env"
        if env_src.exists():
            content = env_src.read_text()
            # Patch values for this machine
            content = re.sub(r"^CLOUD_DIR=.*$", f"CLOUD_DIR={CLOUD_DIR}", content, flags=re.M)
            content = re.sub(r"^FRONTEND_DEPLOY_PATH=.*$", "FRONTEND_DEPLOY_PATH=/var/www/html/shado-cloud-frontend/build", content, flags=re.M)
            content = re.sub(r"^ENV=.*$", "ENV=prod", content, flags=re.M)
            # Ensure Puppeteer uses system Chromium
            if "PUPPETEER_EXECUTABLE_PATH" not in content:
                content += "\nPUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser\n"
            env_dest.write_text(content)
            ok(".env copied and patched")

    # Apache config — prefer the one from the server backup (production config)
        apache_src = extract_dir / "apache-config.conf"
        if apache_src.exists():
            run(f"sudo cp {apache_src} /etc/apache2/sites-available/shado-cloud.conf")
            ok("Apache config restored from server backup")
        else:
            run(f"sudo cp {cloud_app / 'deploy/shado-cloud.conf'} /etc/apache2/sites-available/shado-cloud.conf")
            ok("Apache config copied from repo (no backup found)")

        # Start Docker (MySQL + Redis) before seeding
        print("  Starting Docker services (MySQL + Redis)...")
        run(f"docker compose -f {cloud_app / 'docker-compose.yml'} up -d mysql redis")
        print("  Waiting for MySQL to be healthy...", end="", flush=True)
        for _ in range(60):
            r = run_quiet("docker exec mysql-db-shado-cloud mysqladmin ping -h localhost --silent")
            if r.returncode == 0:
                break
            print(".", end="", flush=True)
            import time; time.sleep(2)
        print()
        ok("MySQL is ready")

        # Seed DB
        sql_dump = extract_dir / "mysql-dump.sql"
        if sql_dump.exists():
            # Read DB_PASSWORD from the patched .env
            db_pass = ""
            for line in env_dest.read_text().splitlines():
                if line.startswith("DB_PASSWORD="):
                    db_pass = line.split("=", 1)[1]
            print("  Importing MySQL dump...")
            run(f"docker exec -i mysql-db-shado-cloud mysql -u root -p'{db_pass}' < {sql_dump}")
            ok("Database seeded")

        # Cleanup
        shutil.rmtree(extract_dir, ignore_errors=True)
        server_zip.unlink(missing_ok=True)

    # Extract cloud files
    if cloud_zip.exists():
        CLOUD_DIR.mkdir(parents=True, exist_ok=True)
        print(f"  Extracting cloud files to {CLOUD_DIR}...")
        with zipfile.ZipFile(cloud_zip) as zf:
            zf.extractall(CLOUD_DIR)
        # The archive wraps files in a "cloud/" prefix
        cloud_inner = CLOUD_DIR / "cloud"
        if cloud_inner.is_dir():
            for item in cloud_inner.iterdir():
                dest = CLOUD_DIR / item.name
                if item.is_dir():
                    shutil.copytree(item, dest, dirs_exist_ok=True)
                else:
                    shutil.copy2(item, dest)
            shutil.rmtree(cloud_inner, ignore_errors=True)
        ok(f"Cloud files extracted to {CLOUD_DIR}")
        cloud_zip.unlink(missing_ok=True)

    # ── 9. Build applications ─────────────────────────────────────────────────
    step("9/10", "Building applications")

    # shado-cloud backend
    print("  [1/3] shado-cloud backend...")
    run(f"cd {cloud_app} && npm install && npm run build 2>/dev/null || cd {cloud_app} && npx nest build")
    ok("shado-cloud built")

    # Migrations
    print("  Running TypeORM migrations...")
    run("npx typeorm migration:run -d dist/ormconfig.js", check=False)

    # shado-cloud frontend
    print("  [2/3] shado-cloud frontend...")
    frontend = INSTALL_DIR / "shado-cloud-frontend"
    run(f"cd {frontend} && npm install && npm run build")
    run("sudo mkdir -p /var/www/html/shado-cloud-frontend")
    run(f"sudo cp -r {frontend}/build/* /var/www/html/shado-cloud-frontend/ 2>/dev/null || true")
    ok("shado-cloud frontend built & deployed")

    # shado-gym-app
    print("  [3/3] shado-gym-app...")
    gym = INSTALL_DIR / "shado-gym-app"
    run(f"cd {gym} && npm install && npm run build")
    ok("shado-gym-app built")

    # ── 10. Services (MediaMTX, Apache, PM2) ──────────────────────────────────
    step("10/10", "Configuring services")

    # MediaMTX
    print("  Installing MediaMTX...")
    arch_out = run_quiet("dpkg --print-architecture").stdout.strip()
    mtx_arch = "linux_arm64v8" if arch_out in ("arm64", "aarch64") else "linux_amd64"
    run(
        f"wget -q https://github.com/bluenviron/mediamtx/releases/download/{MTX_VERSION}/"
        f"mediamtx_{MTX_VERSION}_{mtx_arch}.tar.gz -O /tmp/mediamtx.tar.gz"
    )
    run("tar -xzf /tmp/mediamtx.tar.gz -C /tmp && sudo mv /tmp/mediamtx /usr/local/bin/")
    shutil.copy2(cloud_app / "mediamtx.yml", Path.home() / "mediamtx.yml")
    ok("MediaMTX installed")

    # MediaMTX systemd
    user = os.environ["USER"]
    home = str(Path.home())
    run(f"""sudo tee /etc/systemd/system/mediamtx.service > /dev/null <<'EOF'
[Unit]
Description=MediaMTX
After=network.target

[Service]
User={user}
ExecStart=/usr/local/bin/mediamtx {home}/mediamtx.yml
Restart=always

[Install]
WantedBy=multi-user.target
EOF""")
    run("sudo systemctl daemon-reload && sudo systemctl enable mediamtx")
    ok("MediaMTX service configured")

    # Apache + HTTPS (Let's Encrypt)
    print("  Configuring Apache...")
    run("sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers ssl")
    run("sudo a2dissite 000-default.conf 2>/dev/null || true")
    run("sudo a2ensite shado-cloud.conf")
    run("sudo systemctl enable apache2 && sudo systemctl restart apache2")
    ok("Apache configured (HTTP)")

    # SSL — Let's Encrypt via Certbot
    print(f"\n  {Y}Setting up HTTPS with Let's Encrypt...{N}")
    # Extract domain names from the Apache config
    domains = []
    try:
        conf = Path("/etc/apache2/sites-available/shado-cloud.conf").read_text()
        for m in re.finditer(r"Server(?:Name|Alias)\s+(\S+)", conf):
            d = m.group(1)
            if d not in domains:
                domains.append(d)
    except Exception:
        pass

    if not domains:
        print("  Could not auto-detect domains from Apache config.")
        domain_input = input("  Enter your domain(s) comma-separated (e.g. shadijiha.com,cloud.shadijiha.com,music.shadijiha.com): ").strip()
        domains = [d.strip() for d in domain_input.split(",") if d.strip()]

    if domains:
        certbot_email = input(f"  Enter email for Let's Encrypt notifications (or press Enter for {ADMIN_EMAIL}): ").strip()
        if not certbot_email:
            certbot_email = ADMIN_EMAIL

        domain_flags = " ".join(f"-d {d}" for d in domains)
        print(f"  Requesting certificate for: {', '.join(domains)}")
        result = run(
            f"sudo certbot --apache --non-interactive --agree-tos "
            f"--email {certbot_email} {domain_flags} --redirect",
            check=False,
        )
        if result.returncode == 0:
            ok(f"HTTPS enabled for: {', '.join(domains)}")
            # Certbot auto-creates a cron/systemd timer, but verify
            run("sudo systemctl enable certbot.timer 2>/dev/null || true", check=False)
            ok("Auto-renewal enabled (certbot timer)")
        else:
            warn("Certbot failed — you can retry manually: sudo certbot --apache")
    else:
        warn("No domains provided — skipping HTTPS. Run 'sudo certbot --apache' later.")

    # PM2
    print("  Setting up PM2 processes...")
    run(f'cd {cloud_app} && pm2 start "npm run start:prod" --name "shado-cloud-backend"')
    run(f'cd {gym} && pm2 start "npm run start" --name "shado-gym-app"')
    run("pm2 save")
    # pm2 startup prints a sudo command — capture and run it
    startup = run_quiet(f"pm2 startup systemd -u {user} --hp {home}")
    for line in startup.stdout.splitlines():
        if line.strip().startswith("sudo"):
            run(line.strip())
    ok("PM2 configured with startup")

    # Disable screen blanking
    xsession = Path.home() / ".xsessionrc"
    xsession.write_text("xset s off\nxset -dpms\nxset s noblank\n")
    ok("Screen blanking disabled")

    # Cleanup
    Path("/tmp/mediamtx.tar.gz").unlink(missing_ok=True)

    # ── Done ──────────────────────────────────────────────────────────────────
    domain_str = domains[0] if domains else "localhost"
    print(f"""
{G}╔══════════════════════════════════════════════╗
║   Setup Complete!                            ║
╚══════════════════════════════════════════════╝{N}

  Cloud files dir:  {C}{CLOUD_DIR}{N}
  Backend:          {C}https://{domain_str}/apinest{N}
  Frontend:         {C}https://{domain_str}{N}
  Gym App:          {C}http://localhost:3000/gym{N}
  phpMyAdmin:       {C}http://localhost:8080{N}
  MediaMTX WebRTC:  {C}http://localhost:8889{N}

  {Y}pm2 status{N}   — check running processes
  {Y}docker ps{N}    — check containers
  {Y}sudo certbot certificates{N} — check SSL certs
  {Y}sudo certbot renew --dry-run{N} — test auto-renewal

  {R}NOTE: Log out and back in for Docker group permissions.{N}
""")


if __name__ == "__main__":
    main()
