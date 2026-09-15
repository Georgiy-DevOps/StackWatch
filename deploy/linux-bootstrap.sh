#!/usr/bin/env bash
# Invoked by connect-linux.mjs. Agent source travels inside the encrypted SSH session.
set -euo pipefail
umask 077
trap 'echo "Agent setup stopped; inspect the error above." >&2' ERR
[[ $(id -u) == 0 ]] || { echo 'Run the installer as root.' >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo 'This installer requires Linux with systemd.' >&2; exit 1; }
[[ -n ${AGENT_SOURCE_BASE64:-} ]] || { echo 'Use connect-linux.mjs to launch this installer.' >&2; exit 1; }
for tool in base64 tar sha256sum awk useradd getent install readlink; do command -v "$tool" >/dev/null || { echo "Missing required command: $tool" >&2; exit 1; }; done
agent_root=/opt/pulsewatch-agent
agent_env=/etc/pulsewatch-agent.env
agent_unit=/etc/systemd/system/pulsewatch-agent.service
if [[ -e "$agent_root" && ! -f "$agent_root/.pulsewatch-managed" ]]; then echo 'An unmanaged /opt/pulsewatch-agent already exists; it was not changed.' >&2; exit 1; fi
if [[ -e "$agent_unit" ]] && ! grep -q '^# Managed by Pulsewatch installer$' "$agent_unit"; then echo 'An unmanaged service already exists; it was not changed.' >&2; exit 1; fi
if [[ -e "$agent_env" && ! -f "$agent_root/.pulsewatch-managed" ]]; then echo 'An existing agent configuration was not changed.' >&2; exit 1; fi
install -d -m 755 "$agent_root"
printf '%s\n' 'StackWatch agent installer v1' > "$agent_root/.pulsewatch-managed"

# Reuse a system-wide Node 24+ or install an isolated official runtime for this agent.
node_binary=''
if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  candidate=$(readlink -f "$(command -v node)")
  case "$candidate" in /usr/*|/opt/*) node_binary=$candidate;; esac
fi
if [[ -z "$node_binary" && -x "$agent_root/runtime/node/bin/node" ]]; then node_binary="$agent_root/runtime/node/bin/node"; fi
if [[ -z "$node_binary" ]]; then
  case "$(uname -m)" in x86_64) node_arch=x64;; aarch64|arm64) node_arch=arm64;; *) echo 'Supported architectures: x86_64 and aarch64.' >&2; exit 1;; esac
  command -v xz >/dev/null || { echo 'Install xz-utils and retry.' >&2; exit 1; }
  if command -v curl >/dev/null; then
    fetch_file() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 "$1" -o "$2"; }
  elif command -v wget >/dev/null; then
    fetch_file() { wget -q --https-only --timeout=60 "$1" -O "$2"; }
  else echo 'Install curl or wget and retry.' >&2; exit 1; fi
  echo 'Downloading isolated Node.js 24 LTS from nodejs.org...' >&2
  install -d -m 755 "$agent_root/runtime"
  fetch_file https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt "$agent_root/runtime/SHASUMS256.txt"
  node_archive=$(awk -v arch="$node_arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") { print $2 }' "$agent_root/runtime/SHASUMS256.txt")
  [[ "$node_archive" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo 'Could not resolve an official Node.js 24 release.' >&2; exit 1; }
  fetch_file "https://nodejs.org/dist/latest-v24.x/$node_archive" "$agent_root/runtime/$node_archive"
  (cd "$agent_root/runtime" && awk -v file="$node_archive" '$2 == file' SHASUMS256.txt | sha256sum -c - >&2)
  tar --no-same-owner -xJf "$agent_root/runtime/$node_archive" -C "$agent_root/runtime"
  chmod -R a+rX "$agent_root/runtime/${node_archive%.tar.xz}"
  ln -sfn "$agent_root/runtime/${node_archive%.tar.xz}" "$agent_root/runtime/node"
  node_binary="$agent_root/runtime/node/bin/node"
fi
"$node_binary" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
if ! getent passwd pulsewatch-agent >/dev/null; then
  useradd --system --user-group --no-create-home --home-dir "$agent_root" --shell /usr/sbin/nologin pulsewatch-agent
fi
if [[ ! -f "$agent_env" ]]; then
  agent_token=$("$node_binary" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  printf 'AGENT_HOST=127.0.0.1\nAGENT_PORT=9109\nAGENT_DISK_PATH=/\nAGENT_TOKEN=%s\n' "$agent_token" > "$agent_env"
  chmod 600 "$agent_env"
fi
# Parse the existing token as data. Never source an environment file as shell code.
agent_token=$(awk -F= '$1 == "AGENT_TOKEN" { print $2 }' "$agent_env")
[[ "$agent_token" =~ ^[a-f0-9]{64}$ ]] || { echo 'Unexpected existing agent token format; configuration was preserved.' >&2; exit 1; }
grep -qx 'AGENT_HOST=127.0.0.1' "$agent_env" && grep -qx 'AGENT_PORT=9109' "$agent_env" || { echo 'Existing agent binding differs from the tunnel settings.' >&2; exit 1; }
printf '%s' "$AGENT_SOURCE_BASE64" | base64 --decode > "$agent_root/agent.mjs.new"
"$node_binary" --check "$agent_root/agent.mjs.new" >/dev/null 2>&1 || {
  # Node checks .mjs only, so parse the supplied source through stdin.
  "$node_binary" --input-type=module --check < "$agent_root/agent.mjs.new"
}
install -m 644 "$agent_root/agent.mjs.new" "$agent_root/agent.mjs"
cat > "$agent_unit" <<UNIT
# Managed by Pulsewatch installer
[Unit]
Description=StackWatch Linux metrics agent
After=network.target
[Service]
Type=simple
User=pulsewatch-agent
Group=pulsewatch-agent
WorkingDirectory=$agent_root
EnvironmentFile=$agent_env
ExecStart=$node_binary $agent_root/agent.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=192M
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
chmod 644 "$agent_unit"
systemctl daemon-reload
systemctl enable pulsewatch-agent.service >&2
systemctl restart pulsewatch-agent.service
sleep 3
systemctl is-active --quiet pulsewatch-agent.service || { echo 'Agent failed to start. Run: journalctl -u pulsewatch-agent -n 30' >&2; exit 1; }
# Validate fresh metrics before passing the token back through SSH to the local wizard.
AGENT_SETUP_TOKEN="$agent_token" "$node_binary" --input-type=module -e '
const token = process.env.AGENT_SETUP_TOKEN;
const r = await fetch("http://127.0.0.1:9109/health", {headers:{Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(5000)});
if (!r.ok) throw Error("Agent health check failed");
const m = await r.json();
if (![m.cpu,m.ram,m.disk].every(Number.isFinite) || m.platform !== "linux") throw Error("Invalid Linux metrics");
console.log("PULSEWATCH_RESULT:" + Buffer.from(JSON.stringify({token,platform:m.platform})).toString("base64"));
'
unset agent_token AGENT_SOURCE_BASE64
echo 'Agent ready. Keep this SSH connection open for local monitoring.' >&2
# Preserve the local port forward until the user closes the connection.
while :; do sleep 3600; done
