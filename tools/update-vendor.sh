#!/bin/sh
# Re-pins mods/plannotator/vendor/plannotator.js to the installed plannotator CLI's release.
# Usage: tools/update-vendor.sh [upstream-checkout] [version]
# The checkout defaults to .upstream/plannotator (cloned shallow on first use);
# the version defaults to `plannotator --version`.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
upstream=${1:-$here/.upstream/plannotator}
ver=${2:-$(plannotator --version | awk '{print $NF}')}
tag=v${ver#v}
if [ ! -d "$upstream/.git" ]; then
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" https://github.com/backnotprop/plannotator.git "$upstream"
fi
git -C "$upstream" fetch --quiet --depth 1 origin tag "$tag"
git -C "$upstream" checkout --quiet "$tag"
bun "$here/tools/build-vendor.ts" "$upstream" "$here/mods/plannotator/vendor/plannotator.js"
