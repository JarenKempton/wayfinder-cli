#!/bin/sh
set -eu

REPOSITORY="${WAYFINDER_REPOSITORY:-JarenKempton/wayfinder-cli}"
VERSION="${WAYFINDER_VERSION:-latest}"
INSTALL_DIR="${WAYFINDER_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
OS="${WAYFINDER_OS:-$(uname -s)}"
ARCH="${WAYFINDER_ARCH:-$(uname -m)}"

case "$OS" in
  Darwin|darwin) platform=darwin ;;
  Linux|linux) platform=linux ;;
  *) echo "wayfinder: unsupported operating system: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64|x64) machine=x64 ;;
  arm64|aarch64) machine=arm64 ;;
  *) echo "wayfinder: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

asset="wayfinder-$platform-$machine"
if [ -n "${WAYFINDER_BASE_URL:-}" ]; then
  base=${WAYFINDER_BASE_URL%/}
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPOSITORY/releases/latest/download"
else
  case "$VERSION" in v*) tag=$VERSION ;; *) tag="v$VERSION" ;; esac
  base="https://github.com/$REPOSITORY/releases/download/$tag"
fi

command -v curl >/dev/null 2>&1 || {
  echo "wayfinder: curl is required" >&2
  exit 1
}

mkdir -p "$INSTALL_DIR"
tmp_binary=$(mktemp "$INSTALL_DIR/.wayfinder.XXXXXX")
tmp_checksums=$(mktemp "${TMPDIR:-/tmp}/wayfinder-checksums.XXXXXX")
cleanup() { rm -f "$tmp_binary" "$tmp_checksums"; }
trap cleanup EXIT HUP INT TERM

curl --fail --location --silent --show-error "$base/$asset" --output "$tmp_binary"
curl --fail --location --silent --show-error "$base/checksums.txt" --output "$tmp_checksums"

expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp_checksums")
if [ -z "$expected" ]; then
  echo "wayfinder: checksums.txt has no entry for $asset" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp_binary" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp_binary" | awk '{print $1}')
else
  echo "wayfinder: sha256sum or shasum is required" >&2
  exit 1
fi

if [ "$actual" != "$expected" ]; then
  echo "wayfinder: checksum verification failed for $asset" >&2
  exit 1
fi

chmod 755 "$tmp_binary"
mv -f "$tmp_binary" "$INSTALL_DIR/wayfinder"
trap - EXIT HUP INT TERM
rm -f "$tmp_checksums"

echo "Installed wayfinder to $INSTALL_DIR/wayfinder"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "$INSTALL_DIR is not on PATH. Add it to your shell profile:" >&2
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" >&2
    ;;
esac
