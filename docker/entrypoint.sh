#!/bin/sh
# First start: a daemon.yaml that offers every repository mounted under /projects.
set -eu
home="${SHIBAOX_HOME:-/data}"
if [ ! -f "$home/daemon.yaml" ]; then
  mkdir -p "$home"
  printf 'projects_dir: /projects\n' > "$home/daemon.yaml"
fi
exec shibaox "$@"
