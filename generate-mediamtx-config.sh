#!/bin/bash
# Generates mediamtx.yml with the correct capture command based on the display server.
# Usage: ./generate-mediamtx-config.sh > ~/mediamtx.yml

# Detect the graphical session type (works even from SSH/tty)
detect_display_server() {
    if [ "$(uname)" = "Darwin" ]; then
        echo "macos"; return
    fi

    # Check if we're already in a graphical session
    case "${XDG_SESSION_TYPE:-}" in
        x11|wayland) echo "$XDG_SESSION_TYPE"; return ;;
    esac

    # From SSH/tty: inspect the graphical session on the machine
    local graphical_type
    graphical_type=$(loginctl list-sessions --no-legend 2>/dev/null \
        | while read -r sid rest; do
            type=$(loginctl show-session "$sid" -p Type --value 2>/dev/null)
            if [ "$type" = "wayland" ] || [ "$type" = "x11" ]; then
                echo "$type"; break
            fi
        done)

    if [ -n "$graphical_type" ]; then
        echo "$graphical_type"; return
    fi

    # Last resort: check for running display processes
    if pgrep -x Xwayland >/dev/null 2>&1 || pgrep -x gnome-shell >/dev/null 2>&1 && [ -n "$(pgrep -a gnome-shell | grep wayland)" ]; then
        echo "wayland"; return
    fi

    echo "x11"
}

SESSION_TYPE=$(detect_display_server)

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
