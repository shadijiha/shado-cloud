#!/bin/bash
# Generates mediamtx.yml with the correct capture command based on the display server.
# Usage: ./generate-mediamtx-config.sh > ~/mediamtx.yml

SESSION_TYPE="${XDG_SESSION_TYPE:-}"

# Auto-detect if env var not set
if [ -z "$SESSION_TYPE" ]; then
    if [ "$(uname)" = "Darwin" ]; then
        SESSION_TYPE="macos"
    elif [ -n "$WAYLAND_DISPLAY" ]; then
        SESSION_TYPE="wayland"
    else
        SESSION_TYPE="x11"
    fi
fi

case "$SESSION_TYPE" in
    wayland)
        # PipeWire screen capture for Wayland
        CAPTURE_CMD="ffmpeg -f pipewire -framerate 30 -i default -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 30 -f rtsp rtsp://localhost:\$RTSP_PORT/\$MTX_PATH"
        echo "# Display server: Wayland (using PipeWire capture)" >&2
        ;;
    x11)
        CAPTURE_CMD="ffmpeg -f x11grab -framerate 30 -video_size 1920x1080 -draw_mouse 1 -i :0 -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 30 -f rtsp rtsp://localhost:\$RTSP_PORT/\$MTX_PATH"
        echo "# Display server: X11 (using x11grab)" >&2
        ;;
    *)
        echo "Unsupported display server: $SESSION_TYPE" >&2
        exit 1
        ;;
esac

cat <<EOF
# Auto-generated mediamtx config for $SESSION_TYPE
logLevel: warn
logDestinations: [stdout]

api: yes
apiAddress: 127.0.0.1:9997

rtsp: no
rtmp: no
hls: no
srt: no

webrtc: yes
webrtcAddress: :8889
webrtcAllowOrigin: '*'
webrtcICEServers2: []

paths:
  screen:
    source: publisher
    runOnDemand: $CAPTURE_CMD
    runOnDemandRestart: yes
EOF
