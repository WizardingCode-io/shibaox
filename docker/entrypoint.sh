#!/bin/sh
# First start: a daemon.yaml that offers every repository mounted under /projects.
set -eu
home="${SHIBAOX_HOME:-/data}"
mkdir -p "$home" 2>/dev/null || true
# a real write: `-w` lies on some bind mounts (Docker Desktop maps permissions)
if ! ( : > "$home/.write-probe" ) 2>/dev/null; then
  echo "shibaox: $home is not writable by uid $(id -u). A bind mount must belong to that uid: chown -R $(id -u) <host dir>, or use a named volume (-v shibaox-data:/data)." >&2
  exit 1
fi
rm -f "$home/.write-probe"
if [ ! -f "$home/daemon.yaml" ]; then
  printf 'projects_dir: /projects\n' > "$home/daemon.yaml"
fi
exec shibaox "$@"
