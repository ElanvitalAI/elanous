#!/usr/bin/env bash
set -euo pipefail

mode=dry-run
for arg in "$@"; do
  case "$arg" in
    --dry-run) mode=dry-run ;;
    --apply) mode=apply ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

os="${ROLE_WATCH_OS:-$(uname -s)}"
case "$os" in
  Darwin|macOS) os=Darwin; target="$HOME/Library/LaunchAgents/com.elanous.role-watch.plist" ;;
  Linux) target="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/elanous-role-watch.service" ;;
  *) echo "unsupported OS: $os" >&2; exit 2 ;;
esac

# Pin the installed CLI path, not the caller's checkout. PATH is unreliable in launchd/systemd.
cli="${ROLE_WATCH_CLI:-${ELANOUS_INSTALL_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/elanous}/bin/elanous}"
case "$cli" in /*) ;; *) echo "role watch CLI must be an absolute path" >&2; exit 2 ;; esac
case "$cli$target" in *$'\n'*|*$'\r'*) echo "newline in service path" >&2; exit 2 ;; esac
xml_escape() {
  local s="$1"
  s="${s//&/\&amp;}"; s="${s//</\&lt;}"; s="${s//>/\&gt;}"; s="${s//\"/\&quot;}"
  printf '%s' "$s"
}
render() {
  if [ "$os" = Darwin ]; then
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.elanous.role-watch</string>
  <key>ProgramArguments</key><array><string>$(xml_escape "$cli")</string><string>role</string><string>watch</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
EOF
  else
    # systemd ExecStart accepts a quoted absolute executable path.
    local escaped="$cli"
    escaped="${escaped//\\/\\\\}"; escaped="${escaped//\"/\\\"}"; escaped="${escaped//%/%%}"
    cat <<EOF
[Unit]
Description=elanous role watch
[Service]
Type=simple
ExecStart="$escaped" role watch
Restart=always
RestartSec=10
[Install]
WantedBy=default.target
EOF
  fi
}

echo "role watch unit: $target"
echo "command: $cli role watch"
if [ "$mode" = dry-run ]; then
  render
  if [ "$os" = Linux ]; then echo 'apply: verify or enable systemd user lingering (loginctl enable-linger) for boot-before-login'; fi
  echo 'dry-run: no files written'
  exit 0
fi
if [ ! -x "$cli" ]; then echo "installed elanous CLI not executable: $cli" >&2; exit 1; fi
if [ "$os" = Linux ]; then
  user="$(id -un)"
  linger="$(loginctl show-user "$user" --property=Linger --value)" || {
    echo "cannot verify systemd user lingering; boot watch not configured" >&2; exit 1;
  }
  if [ "$linger" != yes ]; then
    if ! loginctl enable-linger "$user"; then
      echo "cannot enable systemd user lingering; boot watch not configured" >&2; exit 1
    fi
    linger="$(loginctl show-user "$user" --property=Linger --value)" || {
      echo "cannot verify systemd user lingering; boot watch not configured" >&2; exit 1;
    }
  fi
  if [ "$linger" != yes ]; then
    echo "systemd user lingering is not enabled; boot watch not configured" >&2; exit 1
  fi
fi
mkdir -p "$(dirname "$target")"
render > "$target"
if [ "$os" = Darwin ]; then
  launchctl bootout "gui/$(id -u)/com.elanous.role-watch" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$target"
else
  systemctl --user daemon-reload
  systemctl --user enable --now elanous-role-watch.service
fi
"$cli" role watch --once
