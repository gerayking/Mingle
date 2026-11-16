#!/bin/sh
# Prepare the Node.js runtime used by Mingle Remote SSH. Run on the REMOTE host.
# Requires curl or wget, tar, gzip, and sha256sum or shasum. No sudo or shell edits.
# Installs only Node.js/npm, not Mingle, a harness, credentials, or a boot service.
# For a custom prefix, set MINGLE_NODE_PREFIX in the remote SSH environment too.
set -eu
umask 077

version=24.22.3
prefix=${MINGLE_NODE_PREFIX:-"${HOME:?HOME must be set}/.local/share/mingle"}
fail() { printf 'Mingle: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || fail '--prefix needs an absolute directory'; prefix=$2; shift 2 ;;
    --help) printf '%s\n' 'Usage: sh install-remote.sh [--prefix /absolute/directory]'; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
case "$prefix" in /*) ;; *) fail 'The installation prefix must be absolute' ;; esac
[ "$prefix" != / ] || fail 'The installation prefix cannot be /'

case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) fail 'Supported hosts: Linux (glibc) or macOS, x64 or arm64' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail 'Supported architectures: x64 or arm64' ;;
esac

for tool in tar gzip mktemp awk; do
  command -v "$tool" >/dev/null 2>&1 || fail "Install $tool on this host, then retry"
done
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail 'Install sha256sum or shasum on this host, then retry'
fi
if command -v curl >/dev/null 2>&1; then
  download() {
    curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
      --connect-timeout 20 --max-time 600 --retry 2 --output "$2" "$1"
  }
elif command -v wget >/dev/null 2>&1; then
  download() { wget --quiet --timeout=30 --tries=2 --https-only --output-document="$2" "$1"; }
else
  fail 'Install curl or wget on this host, then retry'
fi

mkdir -p "$prefix"
lock="$prefix/.node-install-lock"
mkdir "$lock" 2>/dev/null || fail "Another installation may be running. If it stopped, remove $lock and retry"
stage=''
cleanup() {
  [ -z "$stage" ] || rm -rf "$stage"
  rmdir "$lock" 2>/dev/null || :
}
trap cleanup 0
trap 'exit 130' 2
trap 'exit 143' 1 15
stage=$(mktemp -d "$prefix/.node-install.XXXXXX")
name="node-v$version-$platform-$arch"
release="$prefix/$name"
current="$prefix/node"
[ ! -e "$current" ] || [ -L "$current" ] || fail "Refusing to replace a non-symlink directory: $current"

check_runtime() {
  [ -x "$1/bin/node" ] && [ -x "$1/bin/npm" ] &&
    [ "$("$1/bin/node" --version 2>/dev/null)" = "v$version" ] &&
    PATH="$1/bin:$PATH" "$1/bin/npm" --version >/dev/null 2>&1
}

if [ -e "$release" ] || [ -L "$release" ]; then
  [ -f "$release/.mingle-node-ready" ] && check_runtime "$release" ||
    fail "An incomplete or incompatible runtime exists at $release. Move it aside, then retry"
  printf 'Mingle: reusing Node.js %s\n' "$version"
else
  archive="$name.tar.gz"
  base="https://nodejs.org/dist/v$version"
  printf 'Mingle: downloading Node.js %s for %s/%s\n' "$version" "$platform" "$arch"
  download "$base/SHASUMS256.txt" "$stage/SHASUMS256.txt" || fail 'Could not download the official checksum list'
  expected=$(awk -v name="$archive" '$2 == name {print $1}' "$stage/SHASUMS256.txt")
  [ "${#expected}" -eq 64 ] || fail 'The official checksum list has no unique entry for this archive'
  case "$expected" in *[!0-9a-f]*) fail 'Invalid SHA-256 checksum' ;; esac
  download "$base/$archive" "$stage/$archive" || fail 'Could not download Node.js; check network access to nodejs.org'
  [ "$(checksum "$stage/$archive")" = "$expected" ] || fail 'Node.js checksum mismatch; nothing was installed'
  tar -xzf "$stage/$archive" -C "$stage" || fail 'Could not unpack Node.js'
  check_runtime "$stage/$name" || fail 'Node.js cannot run on this host. Check OS compatibility (Linux requires glibc)'
  printf '%s\n' "$expected" > "$stage/$name/.mingle-node-ready"
  mv "$stage/$name" "$release"
fi

# Atomic symlink replacement works on both GNU and BSD systems. Plain `mv`
# may follow an existing directory symlink instead of replacing it.
ln -s "$release" "$stage/current"
"$release/bin/node" --input-type=module -e \
  'import { renameSync } from "node:fs"; renameSync(process.argv[1], process.argv[2]);' \
  "$stage/current" "$current"
printf '\nMingle: Node.js %s and npm are ready at %s\n' "$version" "$current"
printf '%s\n' 'Return to Mingle and choose Prepare and connect.' \
  'Install and sign in to your preferred harness on this host before creating an Agent.' \
  'No system Node.js, shell profile, SSH config, or boot service was changed.'
