#!/usr/bin/env bash
# Install Chrome Stable, or update it with --update. Profiles are never changed.
set -euo pipefail
mode=${1:-install}
[[ "$mode" == install || "$mode" == --update ]] || { echo 'Usage: setup-chrome.sh [--update]' >&2; exit 1; }
case $(uname -s) in
  Linux)
    [[ $(id -u) == 0 && $(uname -m) == x86_64 ]] || { echo 'Google Chrome Linux requires root installation on x86_64.' >&2; exit 1; }
    command -v apt-get >/dev/null || { echo 'Install google-chrome-stable with your distribution package manager.' >&2; exit 1; }
    status=$(dpkg-query -W -f='${Status}' google-chrome-stable 2>/dev/null || true)
    if [[ "$status" != 'install ok installed' ]]; then
      archive=$(mktemp --suffix=.deb)
      trap 'rm -f -- "$archive"' EXIT
      curl --fail --location --silent --show-error https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$archive"
      chmod 644 "$archive"
      apt-get update
      apt-get install -y "$archive"
    elif [[ "$mode" == --update ]]; then
      apt-get update
      apt-get install -y --only-upgrade google-chrome-stable
    fi
    /opt/google/chrome/chrome --version
    ;;
  Darwin)
    if [[ ! -x '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' && ! -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
      command -v brew >/dev/null || { echo 'Install Google Chrome in /Applications, or install Homebrew to use this helper.' >&2; exit 1; }
      brew install --cask google-chrome
    elif [[ "$mode" == --update ]]; then
      command -v brew >/dev/null && brew list --cask google-chrome >/dev/null || { echo 'This Chrome is not Homebrew-managed; update it with Google Updater.' >&2; exit 1; }
      # --greedy includes Chrome, whose cask is marked auto_updates.
      brew update
      brew upgrade --cask --greedy google-chrome
    fi
    ;;
  *) echo 'Use scripts/setup-chrome.ps1 on Windows.' >&2; exit 1 ;;
esac
