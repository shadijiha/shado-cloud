# Shado Cloud

A fully featured cloud drive with remote desktop streaming.

## Features

- File upload, download, and sharing
- Secure JWT authentication
- Remote desktop streaming via WebRTC
- Admin panel

## Screenshots

![](https://github.com/shadijiha/shado-cloud/blob/nest-js-backend/readme%20images/Capture.PNG?raw=true)
![](https://github.com/shadijiha/shado-cloud/blob/nest-js-backend/readme%20images/upload.png?raw=true)
![](https://github.com/shadijiha/shado-cloud/blob/nest-js-backend/readme%20images/share.png?raw=true)
![](https://github.com/shadijiha/shado-cloud/blob/nest-js-backend/readme%20images/manage%20shared.PNG?raw=true)
![](https://github.com/shadijiha/shado-cloud/blob/nest-js-backend/readme%20images/auth.PNG?raw=true)

---

## Remote Desktop Streaming Setup

This guide explains how to set up remote desktop streaming on a fresh Linux (Ubuntu/Debian) machine.

### Prerequisites

```bash
sudo apt update
sudo apt install -y xorg xdotool scrot ffmpeg apache2
```

### 1. X11 Dummy Display Setup

For headless operation (no physical monitor), configure a virtual display.

Create `/etc/X11/xorg.conf`:

```
Section "Device"
    Identifier "DummyDevice"
    Driver "dummy"
    VideoRam 256000
EndSection

Section "Monitor"
    Identifier "DummyMonitor"
    HorizSync 28-80
    VertRefresh 48-75
    Modeline "1920x1080" 148.50 1920 2008 2052 2200 1080 1084 1089 1125 +hsync +vsync
EndSection

Section "Screen"
    Identifier "DummyScreen"
    Device "DummyDevice"
    Monitor "DummyMonitor"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Modes "1920x1080"
    EndSubSection
EndSection
```

Install the dummy driver:

```bash
sudo apt install -y xserver-xorg-video-dummy
```

Enable display manager to start on boot:

```bash
sudo systemctl enable gdm   # or lightdm
sudo reboot
```

Verify resolution after reboot:

```bash
xdpyinfo | grep dimensions
# Should show: 1920x1080
```

### 2. MediaMTX Setup

Download and install [MediaMTX](https://github.com/bluenviron/mediamtx/releases):

```bash
wget https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_linux_arm64v8.tar.gz
tar -xzf mediamtx_v1.9.3_linux_arm64v8.tar.gz
sudo mv mediamtx /usr/local/bin/
```

Create `~/mediamtx.yml`:

```yaml
logLevel: warn
api: yes
apiAddress: 127.0.0.1:9997

rtsp: yes
rtspAddress: 127.0.0.1:8554
rtmp: no
hls: no
srt: no

webrtc: yes
webrtcAddress: :8889
webrtcAllowOrigins:
  - '*'

paths:
  screen:
    source: publisher
    runOnDemand: ffmpeg -f x11grab -framerate 15 -video_size 1920x1080 -draw_mouse 1 -i :0 -c:v libx264 -preset ultrafast -tune zerolatency -b:v 1500k -pix_fmt yuv420p -g 15 -f rtsp rtsp://127.0.0.1:8554/screen
    runOnDemandRestart: yes
    runOnDemandCloseAfter: 5s
```

Run MediaMTX:

```bash
mediamtx ~/mediamtx.yml &
```

To run on startup, create `/etc/systemd/system/mediamtx.service`:

```ini
[Unit]
Description=MediaMTX
After=network.target

[Service]
User=your-username
ExecStart=/usr/local/bin/mediamtx /home/your-username/mediamtx.yml
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl enable mediamtx
sudo systemctl start mediamtx
```

### 3. Apache2 Reverse Proxy

Enable required modules:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers
```

Create `/etc/apache2/sites-available/shado-cloud.conf`:

```apache
<VirtualHost *:80>
    ServerName your-domain.com

    # Frontend
    DocumentRoot /var/www/html/shado-cloud-frontend/build

    # API proxy
    ProxyPreserveHost On
    ProxyPass /apinest http://127.0.0.1:3000
    ProxyPassReverse /apinest http://127.0.0.1:3000

    # WebSocket proxy for Socket.IO
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/apinest/socket.io/(.*) ws://127.0.0.1:3000/socket.io/$1 [P,L]

    <Directory /var/www/html/shado-cloud-frontend/build>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted

        # SvelteKit SPA routing
        FallbackResource /index.html
    </Directory>
</VirtualHost>
```

Enable and restart:

```bash
sudo a2ensite shado-cloud.conf
sudo systemctl restart apache2
```

### 4. Environment Variables

Create `.env` in the shado-cloud directory with required variables (see `.env.example`).

### 5. Running the Application

```bash
# Install dependencies
npm install

# Build
npm run build

# Start
npm run start:prod
```

---

## WebRTC: Local Network vs Internet Access

### Current Limitation

WebRTC streaming currently only works on the local network. The frontend connects to `http://<local-ip>:8889/screen/whep` which is not accessible from the internet.

### Making WebRTC Work From Anywhere

To enable remote access over the internet:

#### Option 1: Port Forwarding

1. Forward port `8889` on your router to the machine running MediaMTX
2. Use your public IP or a dynamic DNS service (e.g., DuckDNS, No-IP)
3. Update the gateway to use your public hostname:

```typescript
// In remote-desktop.gateway.ts
const webrtcUrl = `http://your-public-domain.com:8889/screen/whep`;
```

#### Option 2: Reverse Proxy with Apache (Recommended)

Add WebRTC proxy to your Apache config:

```apache
# WebRTC WHEP endpoint
ProxyPass /whep http://127.0.0.1:8889/screen/whep
ProxyPassReverse /whep http://127.0.0.1:8889/screen/whep

# Required headers for WebRTC
<Location /whep>
    Header set Access-Control-Allow-Origin "*"
    Header set Access-Control-Allow-Methods "POST, OPTIONS"
    Header set Access-Control-Allow-Headers "Content-Type"
</Location>
```

Then update the gateway:

```typescript
const webrtcUrl = "/whep";
```

And update the frontend to use the same origin:

```typescript
const url = `${window.location.origin}/whep`;
```

#### Option 3: TURN Server (For Restrictive NATs)

If direct connections fail due to NAT/firewall, you need a TURN server:

1. Install coturn:
   ```bash
   sudo apt install coturn
   ```

2. Configure `/etc/turnserver.conf`:
   ```
   listening-port=3478
   realm=your-domain.com
   server-name=your-domain.com
   lt-cred-mech
   user=turnuser:turnpassword
   ```

3. Update mediamtx.yml:
   ```yaml
   webrtcICEServers2:
     - urls: [turn:your-domain.com:3478]
       username: turnuser
       credential: turnpassword
   ```

4. Forward port 3478 (TCP/UDP) on your router

---

## Troubleshooting

### High CPU Usage

- Lower framerate in mediamtx.yml: `-framerate 10`
- Use a lighter desktop environment (XFCE instead of GNOME)
- Close unnecessary applications

### Display Resolution Issues

Check X11 logs:
```bash
cat /var/log/Xorg.0.log | grep -i "1920x1080"
```

If resolution is rejected, verify the Modeline in xorg.conf matches your target resolution.

### WebRTC Not Connecting

1. Check MediaMTX is running: `ps aux | grep mediamtx`
2. Test WHEP endpoint: `curl -I http://localhost:8889/screen/whep`
3. Check browser console for connection errors
4. Verify firewall allows port 8889
