#!/bin/sh
# ACC installer for macOS and Linux.
#
#   ./install.sh                 install the latest release
#   ./install.sh --boot          also start ACC when you sign in
#   ./install.sh --version 0.2.0 install a specific release
#   ./install.sh --dir <path>    install somewhere else
#
# Windows users get a real installer instead: acc-setup.exe from the same release.

set -eu

REPO="tech-master33/acc"
VERSION=""
BOOT="no"
TARGET_DIR=""

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || { echo "--version needs a value" >&2; exit 2; }; VERSION="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || { echo "--dir needs a value" >&2; exit 2; }; TARGET_DIR="$2"; shift 2 ;;
    --boot) BOOT="yes"; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required. Install it from https://nodejs.org/ and try again." >&2
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required (found $(node -v))." >&2
  exit 1
fi

TARGET="${TARGET_DIR:-$HOME/.local/share/acc}"
if [ -n "$VERSION" ]; then
  URL="https://github.com/$REPO/releases/download/v$VERSION/acc.tar.gz"
else
  URL="https://github.com/$REPO/releases/latest/download/acc.tar.gz"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "Downloading $URL"
if ! curl -fsSL "$URL" -o "$TMP/acc.tar.gz"; then
  echo "Download failed. Check the version and your connection." >&2
  exit 1
fi

tar -xzf "$TMP/acc.tar.gz" -C "$TMP"
[ -d "$TMP/acc" ] || { echo "The archive did not contain an acc/ folder." >&2; exit 1; }

rm -rf "$TARGET/bin" "$TARGET/src"
mkdir -p "$TARGET"
cp -R "$TMP/acc/." "$TARGET/"

BINDIR="$HOME/.local/bin"
mkdir -p "$BINDIR"
cat > "$BINDIR/acc" <<EOF
#!/bin/sh
exec node "$TARGET/bin/acc.mjs" "\$@"
EOF
chmod +x "$BINDIR/acc"

echo
echo "Installed to $TARGET"
echo "Command:   $BINDIR/acc"
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "Note:      add $BINDIR to your PATH (for example in ~/.profile) to use the 'acc' command." ;;
esac

if [ "$BOOT" = "yes" ]; then
  node "$TARGET/bin/acc.mjs" boot on
fi

echo
echo "  1. Start it:       acc serve"
echo "  2. Open the panel: http://127.0.0.1:8788/"
echo "  3. Enable a provider, then: acc connect claude-desktop"
