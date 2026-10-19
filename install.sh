#!/bin/bash
#
# Installs the Ask Claude Raycast extension, or brings an existing install up to date.
#
#   curl -fsSL https://raw.githubusercontent.com/KushalSomaliya/ask-claude-raycast/main/install.sh | bash
#
# Downloads the extension to ~/raycast-extensions/ask-claude-ext, installs its dependencies, and
# builds it into Raycast (the same as `npm install && npm run dev`, then Ctrl+C). Safe to run again:
# an existing install is updated, and a copy installed from a zip is moved aside and replaced.
# Your API key and chats are stored in Raycast, so they're kept either way.

# Everything runs inside main(), so a partly downloaded script never runs half-way.
main() {
  set -eu

  REPO="${ASK_CLAUDE_REPO:-https://github.com/KushalSomaliya/ask-claude-raycast.git}"
  DIR="${ASK_CLAUDE_DIR:-$HOME/raycast-extensions/ask-claude-ext}"
  BUILD_TIMEOUT=180 # seconds
  export GIT_TERMINAL_PROMPT=0

  if [ -t 1 ]; then
    BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
  else
    BOLD=""; DIM=""; GREEN=""; RED=""; RESET=""
  fi
  step() { printf '%s→%s %s\n' "$BOLD" "$RESET" "$1"; }
  note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
  fail() { printf '\n%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; [ -n "${2:-}" ] && printf '%s\n' "$2" >&2; exit 1; }

  printf '\n%sInstalling Ask Claude for Raycast%s\n\n' "$BOLD" "$RESET"

  # ---- what's needed ---------------------------------------------------------

  if [ -z "${ASK_CLAUDE_TEST:-}" ]; then
    [ "$(uname)" = "Darwin" ] || fail "Ask Claude is a Raycast extension, so it needs a Mac."
    [ -d /Applications/Raycast.app ] || [ -d "$HOME/Applications/Raycast.app" ] ||
      fail "Raycast isn't installed." "Get it from https://raycast.com, open it once, then run this again."
  fi

  if ! git --version >/dev/null 2>&1; then
    fail "git isn't installed yet." "macOS should show a window offering to install it (or run: xcode-select --install). Once that's done, run this again."
  fi

  # Node may come from Homebrew or nvm; make sure this shell can see it.
  PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
  if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  fi
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      fail "Node.js isn't installed." "Install it with:  brew install node   then run this again."
    fi
    fail "Node.js isn't installed." "Install the LTS version from https://nodejs.org, then run this again."
  fi
  NODE_VERSION=$(node -v 2>/dev/null | sed 's/^v//')
  NODE_MAJOR=${NODE_VERSION%%.*}
  if [ "${NODE_MAJOR:-0}" -lt 18 ] 2>/dev/null; then
    fail "Node.js $NODE_VERSION is too old." "Raycast needs Node.js 22 or newer. Update it (for example: brew upgrade node), then run this again."
  fi

  # ---- download ----------------------------------------------------------------

  BACKUP=""
  if [ -d "$DIR/.git" ]; then
    ORIGIN=$(git -C "$DIR" remote get-url origin 2>/dev/null || true)
    case "$ORIGIN" in
      "$REPO" | *KushalSomaliya/ask-claude-raycast*) ;;
      *) fail "$DIR already holds a different git project ($ORIGIN)." "Move it, or install somewhere else with:  ASK_CLAUDE_DIR=~/some/folder bash" ;;
    esac
    step "Updating the copy in $DIR"
    git -C "$DIR" fetch --quiet origin main || fail "Couldn't reach GitHub. Check your internet connection and try again."
    if ! git -C "$DIR" checkout --quiet main 2>/dev/null || ! git -C "$DIR" merge --quiet --ff-only origin/main 2>/dev/null; then
      fail "Files in $DIR were changed by hand, so it wasn't updated." "Keep your changes elsewhere, then delete the folder and run this again."
    fi
  else
    if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
      BACKUP="$DIR.backup-$(date +%Y%m%d-%H%M%S)"
      step "Moving the existing copy aside"
      mv "$DIR" "$BACKUP"
      note "It's now at $BACKUP (you can delete it once everything works)."
    elif [ -d "$DIR" ]; then
      rmdir "$DIR"
    fi
    step "Downloading Ask Claude"
    mkdir -p "$(dirname "$DIR")"
    git clone --quiet "$REPO" "$DIR" || fail "Couldn't download from GitHub. Check your internet connection and try again."
  fi
  cd "$DIR"

  # ---- dependencies ----------------------------------------------------------

  step "Installing dependencies (can take a minute the first time)"
  LOG=$(mktemp "${TMPDIR:-/tmp}/ask-claude-install.XXXXXX")
  if ! npm install --no-audit --no-fund --loglevel=error </dev/null >"$LOG" 2>&1; then
    if grep -q EACCES "$LOG"; then
      fail "npm couldn't write to its cache folder." "Fix it with:  sudo chown -R \$(id -u):\$(id -g) ~/.npm   then run this again."
    fi
    fail "npm install failed:" "$(tail -n 20 "$LOG")"
  fi

  # ---- build into Raycast --------------------------------------------------------

  # A development build of this folder that's still running would get in the way. Stop it and
  # the helper processes it started (found first, since they lose their parent once it stops).
  OLD_BUILDS=$(pgrep -f "$DIR/node_modules/.bin/ray develop" 2>/dev/null || true)
  if [ -n "$OLD_BUILDS" ]; then
    OLD_ALL="$OLD_BUILDS"
    for OLD in $OLD_BUILDS; do OLD_ALL="$OLD_ALL $(pgrep -P "$OLD" 2>/dev/null || true)"; done
    note "Stopping a development build of this folder that was still running."
    kill -INT $OLD_ALL >/dev/null 2>&1 || true
    sleep 1
    kill -KILL $OLD_ALL >/dev/null 2>&1 || true
  fi

  step "Building it into Raycast"
  : >"$LOG"
  set -m # run the build in its own process group, so it can be stopped as a whole (like Ctrl+C)
  (exec npm run dev) </dev/null >"$LOG" 2>&1 &
  BUILD_PID=$!
  set +m
  trap 'kill -INT -- "-$BUILD_PID" >/dev/null 2>&1 || true' INT TERM EXIT

  BUILT=""
  WAITED=0
  while [ "$WAITED" -lt $((BUILD_TIMEOUT * 2)) ]; do
    if grep -qi "built extension successfully" "$LOG"; then BUILT=1; break; fi
    kill -0 "$BUILD_PID" 2>/dev/null || break
    sleep 0.5
    WAITED=$((WAITED + 1))
  done

  [ -n "$BUILT" ] && sleep 1.5 # let Raycast finish loading the new build
  # Stop development mode the way Ctrl+C would, then make sure nothing is left running.
  kill -INT -- "-$BUILD_PID" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- "-$BUILD_PID" 2>/dev/null || break; sleep 0.5; done
  kill -TERM -- "-$BUILD_PID" >/dev/null 2>&1 || true
  sleep 0.5
  kill -KILL -- "-$BUILD_PID" >/dev/null 2>&1 || true
  wait "$BUILD_PID" 2>/dev/null || true
  trap - INT TERM EXIT

  if [ -z "$BUILT" ]; then
    HINT=""
    if [ "${NODE_MAJOR:-0}" -lt 22 ] 2>/dev/null; then
      HINT="Raycast needs Node.js 22 or newer and you have $NODE_VERSION; updating Node will likely fix this."
    fi
    fail "The build didn't finish." "$(tail -n 20 "$LOG")${HINT:+

$HINT}"
  fi
  rm -f "$LOG"

  # ---- done ----------------------------------------------------------------------

  printf '\n%s✓ Ask Claude is installed.%s\n\n' "$GREEN$BOLD" "$RESET"
  echo "  Open Raycast and search \"Ask Claude\". The first time, it asks for your Anthropic API key."
  echo "  New versions: Ask Claude shows when one is available; press ⌘U inside it to install."
  [ -n "$BACKUP" ] && echo "  Your old copy is at $BACKUP; delete it once everything works."
  echo
}

main "$@"
