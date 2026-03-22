#!/usr/bin/env python3
"""
Master Setup Script for Shado Cloud + Shado Gym App.
Provisions a fresh Ubuntu machine into a fully working server.

Run via:  chmod +x master-setup.sh && ./master-setup.sh
"""

import getpass, json, os, re, shutil, subprocess, sys, zipfile
from pathlib import Path
import requests

# ── Config ────────────────────────────────────────────────────────────────────
API_BASE = "https://cloudapi.shadijiha.com"
ADMIN_EMAIL = "admin@shado.com"
INSTALL_DIR = Path.home() / "Desktop"
CLOUD_DIR = INSTALL_DIR / "shado-cloud-data"
MTX_VERSION = "v1.9.3"

REPOS = {
    "shado-cloud": "git@github.com:shadijiha/shado-cloud.git",
    "shado-cloud-frontend": "git@github.com:shadijiha/shado-cloud-frontend.git",
    "shado-auth-api": "git@github.com:shadijiha/shado-auth-api.git",
    "shado-gym-app": "git@github.com:shadijiha/shado-gym-app.git",
}

# ── Helpers ───────────────────────────────────────────────────────────────────
C = "\033[0;36m"; G = "\033[0;32m"; Y = "\033[1;33m"; R = "\033[0;31m"; N = "\033[0m"
USER = os.environ.get("USER") or os.environ.get("LOGNAME") or subprocess.run("whoami", shell=True, capture_output=True, text=True).stdout.strip() or "root"

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

# ── HTTP client (requests-based) ──────────────────────────────────────────────
session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 ShadoCloudSetup/1.0",
    "Origin": "https://cloud.shadijiha.com",
})

def api(method: str, path: str, body: dict | None = None):
    url = f"{API_BASE}/{path.lstrip('/')}"
    resp = session.request(method, url, json=body)
    resp.raise_for_status()
    return resp.json()

def download_file(path: str, dest: Path):
    """Download a file from the API to disk, showing progress."""
    url = f"{API_BASE}/{path.lstrip('/')}"
    with session.get(url, stream=True) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(65536):
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded * 100 // total
                    print(f"\r  Downloading... {human_bytes(downloaded)} / {human_bytes(total)} ({pct}%)", end="", flush=True)
                else:
                    print(f"\r  Downloading... {human_bytes(downloaded)}", end="", flush=True)
    print()

def follow_sse(path: str) -> str | None:
    """Follow an SSE endpoint, print progress, return the downloadPath on completion."""
    url = f"{API_BASE}/{path.lstrip('/')}"
    download_path = None
    with session.get(url, stream=True) as resp:
        resp.raise_for_status()
        for raw_line in resp.iter_lines():
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
        "graphicsmagick ghostscript "
        "unzip jq bc "
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

    # ── X11 dummy display for headless operation ──────────────────────────────
    # A headless server has no physical monitor. The X11 "dummy" driver creates
    # a virtual framebuffer so that Xorg, xdotool, scrot, and ffmpeg (x11grab)
    # all work as if a real display were attached. Without this, there is no
    # screen to capture or interact with for remote desktop streaming.
    step("1b/10", "Configuring X11 dummy display + GDM auto-login")
    xorg_conf = """\
Section "Device"
    Identifier "DummyDevice"
    Driver "dummy"
    # VideoRam must be large enough for the highest resolution (2560x1440x32bpp ≈ 14MB)
    VideoRam 256000
EndSection

Section "Monitor"
    Identifier "DummyMonitor"
    HorizSync 28-80
    VertRefresh 48-75
    # Modelines define the exact pixel timings for each resolution.
    # These are required because the dummy driver has no EDID from a real monitor.
    Modeline "1920x1080" 148.50 1920 2008 2052 2200 1080 1084 1089 1125 +hsync +vsync
    Modeline "2560x1440" 312.25 2560 2752 3024 3488 1440 1443 1448 1493 -hsync +vsync
EndSection

Section "Screen"
    Identifier "DummyScreen"
    Device "DummyDevice"
    Monitor "DummyMonitor"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        # List preferred resolution first — Xorg picks the first one it can use.
        Modes "2560x1440" "1920x1080"
    EndSubSection
EndSection
"""
    run(f"echo '{xorg_conf}' | sudo tee /etc/X11/xorg.conf > /dev/null")
    ok("X11 dummy display configured at /etc/X11/xorg.conf")

    # GDM auto-login: On a headless server, nobody is physically present to
    # type a password at the login screen. Without auto-login, GDM sits at the
    # greeter — which means:
    #   1. No user desktop session exists (no ~/.Xauthority for the user)
    #   2. xdotool/scrot/ffmpeg cannot authenticate to the X server
    #   3. The X display number may differ from what the app expects
    # Auto-login ensures a real user session starts on every boot, creating
    # the Xauthority file and a predictable DISPLAY.
    # WaylandEnable=false forces X11 — Wayland doesn't support x11grab/xdotool.
    print("  Configuring GDM auto-login...")
    gdm_conf = f"""\
[daemon]
AutomaticLoginEnable=True
AutomaticLogin={USER}
# Force X11 instead of Wayland — xdotool, scrot, and ffmpeg x11grab
# do not work under Wayland.
WaylandEnable=false

[security]

[xdmcp]

[chooser]

[debug]
"""
    run(f"echo '{gdm_conf}' | sudo tee /etc/gdm3/custom.conf > /dev/null")
    run("sudo systemctl enable gdm", check=False)
    ok("GDM auto-login configured")

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
        run(f"sudo usermod -aG docker {USER}")
        ok("Docker installed (re-login for group to take effect)")
    else:
        ok("Docker already installed")
    run("sudo systemctl enable --now docker", check=False)
    ok("Docker ready")
    if run_quiet("docker compose version").returncode != 0:
        run("sudo apt install -y docker-compose-plugin", check=False)

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
    run("sudo pip3 install yt-dlp --break-system-packages 2>/dev/null || sudo pip3 install yt-dlp", check=False)
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
    except requests.RequestException as e:
        fail(f"Login request failed: {e}")
    if not resp.get("user"):
        errors = resp.get("errors", [])
        msg = errors[0].get("message", "Unknown error") if errors else "Unknown error"
        fail(f"Login failed: {msg}")
    ok("Authenticated successfully")
    ok("Authenticated successfully")

    # ── 6. Server backup (DB + .env + Apache) via SSE ─────────────────────────
    step("6/10", "Downloading server backup (DB dump + .env + cloudflared config)")
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
            content = re.sub(r"^FRONTEND_DEPLOY_PATH=.*\n?", "", content, flags=re.M)
            content = re.sub(r"^ENV=.*$", "ENV=prod", content, flags=re.M)
            content = re.sub(r"^DB_HOST=.*$", "DB_HOST=localhost", content, flags=re.M)
            content = re.sub(r"^REDIS_HOST=.*$", "REDIS_HOST=localhost", content, flags=re.M)
            # Ensure Puppeteer uses system Chromium
            if "PUPPETEER_EXECUTABLE_PATH" not in content:
                content += "\nPUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser\n"
            env_dest.write_text(content)
            ok(".env copied and patched")

        # Start MySQL & Redis (native installs)
        print("  Installing MySQL and Redis...")
        run("sudo apt install -y mysql-server redis-server")
        run("sudo systemctl enable --now mysql", check=False)
        run("sudo systemctl enable --now redis-server", check=False)

        print("  Waiting for MySQL to be ready...", end="", flush=True)
        import time
        for _ in range(30):
            if run_quiet("sudo mysqladmin ping --silent").returncode == 0:
                break
            print(".", end="", flush=True)
            time.sleep(2)
        print()
        ok("MySQL is ready")

        # Read DB creds from .env
        db_pass = db_user = db_name = ""
        for line in env_dest.read_text().splitlines():
            if line.startswith("DB_PASSWORD="): db_pass = line.split("=", 1)[1]
            if line.startswith("DB_USERNAME="): db_user = line.split("=", 1)[1]
            if line.startswith("DB_NAME="): db_name = line.split("=", 1)[1]

        # Setup MySQL user and database
        print("  Configuring MySQL user and database...")
        sql_cmds = f"""
CREATE DATABASE IF NOT EXISTS \`{db_name}\`;
CREATE USER IF NOT EXISTS '{db_user}'@'localhost' IDENTIFIED BY '{db_pass}';
ALTER USER '{db_user}'@'localhost' IDENTIFIED BY '{db_pass}';
GRANT ALL PRIVILEGES ON \`{db_name}\`.* TO '{db_user}'@'localhost';
FLUSH PRIVILEGES;
"""
        run(f"sudo mysql -e \"{sql_cmds}\"")
        ok("MySQL user and database configured")

        # Configure Redis password
        redis_pass = ""
        for line in env_dest.read_text().splitlines():
            if line.startswith("REDIS_PASSWORD="): redis_pass = line.split("=", 1)[1]
        if redis_pass:
            run(f"sudo sed -i 's/^# *requirepass .*/requirepass {redis_pass}/' /etc/redis/redis.conf")
            run("sudo systemctl restart redis-server", check=False)
            ok("Redis password configured")

        # Seed DB
        sql_dump = extract_dir / "mysql-dump.sql"
        if sql_dump.exists():
            print("  Importing MySQL dump...")
            run(f"sudo mysql < {sql_dump}")
            ok("Database seeded")

        # Restore Cloudflare tunnel config and credentials
        cf_config = extract_dir / "cloudflared-config.yml"
        cf_origin_pem = extract_dir / "cloudflare-origin.pem"
        cf_origin_key = extract_dir / "cloudflare-origin.key"

        if cf_config.exists():
            print("  Restoring Cloudflare tunnel config...")
            run("sudo mkdir -p /etc/cloudflared")
            run(f"sudo cp {cf_config} /etc/cloudflared/config.yml")
            # Copy tunnel credential JSON files
            for json_file in extract_dir.glob("*.json"):
                run(f"sudo cp {json_file} /etc/cloudflared/{json_file.name}")
            ok("Cloudflare tunnel config restored")

        if cf_origin_pem.exists() and cf_origin_key.exists():
            print("  Restoring Cloudflare origin certificate...")
            run(f"sudo cp {cf_origin_pem} /etc/ssl/cloudflare-origin.pem")
            run(f"sudo cp {cf_origin_key} /etc/ssl/cloudflare-origin.key")
            run("sudo chmod 600 /etc/ssl/cloudflare-origin.key")
            ok("Cloudflare origin certificate restored")

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
    print("  [1/4] shado-cloud backend...")
    run(f"cd {cloud_app} && npm install && npm run build 2>/dev/null || cd {cloud_app} && npx nest build")
    ok("shado-cloud built")

    # Migrations
    print("  Running TypeORM migrations...")
    run("npx typeorm migration:run -d dist/ormconfig.js", check=False)

    # shado-auth-api
    print("  [2/4] shado-auth-api...")
    auth_api = INSTALL_DIR / "shado-auth-api"
    run(f"cd {auth_api} && npm install && npm run build")
    ok("shado-auth-api built")

    # shado-cloud frontend
    print("  [3/4] shado-cloud frontend...")
    frontend = INSTALL_DIR / "shado-cloud-frontend"
    run(f"cd {frontend} && npm install && npm run build")
    ok("shado-cloud frontend built")

    # shado-gym-app
    print("  [4/4] shado-gym-app...")
    gym = INSTALL_DIR / "shado-gym-app"
    run(f"cd {gym} && npm install && npm run build")
    ok("shado-gym-app built")

    # ── 10. Services (MediaMTX, Cloudflare Tunnel, PM2) ──────────────────────
    step("10/10", "Configuring services")

    # MediaMTX — a lightweight media server that re-publishes the screen capture
    # as a WebRTC stream. The browser connects to MediaMTX's WHEP endpoint to
    # get a low-latency live view of the server's desktop.
    print("  Installing MediaMTX...")
    arch_out = run_quiet("dpkg --print-architecture").stdout.strip()
    mtx_arch = "linux_arm64v8" if arch_out in ("arm64", "aarch64") else "linux_amd64"
    run(
        f"wget -q https://github.com/bluenviron/mediamtx/releases/download/{MTX_VERSION}/"
        f"mediamtx_{MTX_VERSION}_{mtx_arch}.tar.gz -O /tmp/mediamtx.tar.gz"
    )
    run("tar -xzf /tmp/mediamtx.tar.gz -C /tmp && sudo mv /tmp/mediamtx /usr/local/bin/")
    shutil.copy2(cloud_app / "setup-new-server-script" / "mediamtx.yml", Path.home() / "mediamtx.yml")
    ok("MediaMTX installed")

    # ffmpeg wrapper script for MediaMTX's runOnDemand.
    # Why a wrapper instead of an inline ffmpeg command in mediamtx.yml?
    #   - The X display number (e.g. :0, :1) can change across reboots depending
    #     on how GDM assigns it. Hardcoding ":0" breaks after some reboots.
    #   - The screen resolution may also change (e.g. if xrandr modeline applies
    #     differently). Hardcoding "1920x1080" would capture the wrong area.
    #   - This script detects both at runtime by:
    #     1. Reading /tmp/.X11-unix/ to find the actual X socket number
    #     2. Using xdotool getdisplaygeometry to get the real resolution
    #   - XAUTHORITY points to GDM's auth file at /run/user/<uid>/gdm/Xauthority
    #     because GDM auto-login creates the session there (not ~/.Xauthority).
    ffmpeg_wrapper = Path.home() / "mediamtx-ffmpeg.sh"
    ffmpeg_wrapper.write_text("""\
#!/bin/bash
# Auto-detect the X display number from the socket file
export DISPLAY=:$(ls /tmp/.X11-unix/ | grep -oP '\\d+' | tail -1)
# GDM stores Xauthority here (not ~/.Xauthority) when using auto-login
export XAUTHORITY=/run/user/$(id -u)/gdm/Xauthority
# Get actual screen resolution so ffmpeg captures the full display
RES=$(xdotool getdisplaygeometry | tr ' ' 'x')
exec ffmpeg -f x11grab -framerate 30 -video_size ${RES} -draw_mouse 1 -i ${DISPLAY} -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 30 -f rtsp rtsp://localhost:$RTSP_PORT/$MTX_PATH
""")
    ffmpeg_wrapper.chmod(0o755)
    ok("MediaMTX ffmpeg wrapper created (auto-detects display + resolution)")

    # MediaMTX systemd service.
    # Key details:
    #   - After=display-manager.service: ensures GDM starts first
    #   - ExecStartPre: busy-waits until an X socket appears in /tmp/.X11-unix/.
    #     This is necessary because GDM takes a few seconds after boot to create
    #     the X session. Without this wait, mediamtx would start before X is
    #     ready, and ffmpeg's x11grab would fail with "Can't open display".
    #   - RestartSec=3: avoids rapid restart loops if something goes wrong
    user = USER
    home = str(Path.home())
    run(f"""sudo tee /etc/systemd/system/mediamtx.service > /dev/null <<'EOF'
[Unit]
Description=MediaMTX
After=display-manager.service
Wants=display-manager.service

[Service]
User={user}
# Wait for X to be ready — GDM takes a few seconds to create the display
ExecStartPre=/bin/bash -c 'until ls /tmp/.X11-unix/X* >/dev/null 2>&1; do sleep 1; done; sleep 2'
ExecStart=/usr/local/bin/mediamtx {home}/mediamtx.yml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF""")
    run("sudo systemctl daemon-reload && sudo systemctl enable mediamtx", check=False)
    ok("MediaMTX service configured (auto-waits for X display)")

    # Cloudflare Tunnel (cloudflared)
    print("  Installing cloudflared...")
    if shutil.which("cloudflared") is None:
        run("curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null")
        run('echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list')
        run("sudo apt update && sudo apt install -y cloudflared")
    else:
        ok("cloudflared already installed")

    if Path("/etc/cloudflared/config.yml").exists():
        ok("Cloudflare tunnel config restored from backup")
    else:
        # Write default config — user must update tunnel ID and credentials-file
        run("sudo mkdir -p /etc/cloudflared")
        cf_config = """\
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json

ingress:
  # ── Shado Cloud ────────────────────────────
  - hostname: cloud.shadijiha.com
    service: http://localhost:3000
  - hostname: cloudapi.shadijiha.com
    service: http://localhost:9000

  # ── Shado Gym ──────────────────────────────
  - hostname: gym.shadijiha.com
    service: http://localhost:4000
  - hostname: gymapi.shadijiha.com
    service: http://localhost:15001

  # ── Auth & Shared Services ─────────────────
  - hostname: auth.shadijiha.com
    service: http://localhost:11001
  - hostname: metrics.shadijiha.com
    service: http://localhost:14001

  # ── Media ──────────────────────────────────
  - hostname: plex.shadijiha.com
    service: http://localhost:32400

  # ── Fallback ───────────────────────────────
  - service: http_status:404
"""
        run(f"echo '{cf_config}' | sudo tee /etc/cloudflared/config.yml > /dev/null")
        warn("Default cloudflared config written — update tunnel ID and credentials-file, then run:")
        warn("  cloudflared tunnel create <name>")
        warn("  sudo cloudflared service install")

    run("sudo cloudflared service install 2>/dev/null || true", check=False)
    run("sudo systemctl enable cloudflared", check=False)
    run("sudo systemctl restart cloudflared", check=False)
    ok("Cloudflare tunnel service configured")

    # PM2
    print("  Setting up PM2 processes...")
    run(f'cd {cloud_app} && pm2 start "npm run start:prod" --name "shado-cloud-backend"')
    run(f'cd {auth_api} && pm2 start "npm run start:prod" --name "shado-auth-api"')
    run(f'cd {frontend} && pm2 start "npm run start" --name "shado-cloud-frontend"')
    run(f'cd {gym} && pm2 start "npm run start" --name "shado-gym-app"')
    run("pm2 save")
    # pm2 startup prints a sudo command — capture and run it
    startup = run_quiet(f"pm2 startup systemd -u {user} --hp {home}")
    for line in startup.stdout.splitlines():
        if line.strip().startswith("sudo"):
            run(line.strip())
    ok("PM2 configured with startup")

    # ~/.xsessionrc runs automatically when the desktop session starts (on every
    # boot, thanks to GDM auto-login). It's the right place for display setup
    # that must happen inside the user's X session.
    xsession = Path.home() / ".xsessionrc"
    xsession.write_text(
        # xhost +local: allows any local user to connect to this X display.
        # Without this, processes running under PM2 or systemd (which may run
        # as the same user but in a different PAM session) get "Authorization
        # required" errors from xdotool/scrot because they lack the X cookie.
        "xhost +local: >/dev/null 2>&1\n"
        # Disable screen blanking and power management — on a headless server
        # the screen would go black after idle timeout, causing the WebRTC
        # stream to show a black screen until mouse movement wakes it up.
        "xset s off\n"
        "xset -dpms\n"
        "xset s noblank\n"
        # Set QHD resolution on the dummy display. The dummy driver doesn't
        # auto-detect modes like a real monitor, so we must manually create
        # the modeline and apply it. This runs on every session start to
        # ensure the resolution is correct even if xorg.conf modes didn't
        # apply during Xorg startup.
        'xrandr --newmode "2560x1440" 312.25 2560 2752 3024 3488 1440 1443 1448 1493 -hsync +vsync 2>/dev/null\n'
        'xrandr --addmode DUMMY0 "2560x1440" 2>/dev/null\n'
        'xrandr --output DUMMY0 --mode "2560x1440" 2>/dev/null\n'
    )
    ok("~/.xsessionrc configured: xhost, screen blanking, QHD resolution")

    # Cleanup
    Path("/tmp/mediamtx.tar.gz").unlink(missing_ok=True)

    # ── Done ──────────────────────────────────────────────────────────────────
    print(f"""
{G}╔══════════════════════════════════════════════╗
║   Setup Complete!                            ║
╚══════════════════════════════════════════════╝{N}

  Cloud files dir:  {C}{CLOUD_DIR}{N}
  Backend:          {C}https://cloudapi.shadijiha.com{N}
  Frontend:         {C}https://cloud.shadijiha.com{N}
  Gym App:          {C}https://gym.shadijiha.com{N}
  MediaMTX WebRTC:  {C}https://whep.shadijiha.com{N}

  {Y}pm2 status{N}   — check running processes
  {Y}docker ps{N}    — check containers
  {Y}sudo systemctl status cloudflared{N} — check tunnel

  {R}NOTE: Log out and back in for Docker group permissions.{N}
""")


if __name__ == "__main__":
    main()
