#!/usr/bin/env bash
# Keep the bootstrap in a function so a truncated curl response cannot run it.
set -euo pipefail
libertty_install() {
  local version= archive= supplied_sha= repository=${LIBERTTY_REPOSITORY:-${TERMAI_REPOSITORY:-nick1udwig/libertty}}
  local argument platform machine asset temporary digest expected
  local arguments=("$@")
  while [[ $# -gt 0 ]]; do
    argument=$1; shift
    case "$argument" in
      --version|--archive|--sha256|--prefix|--port|--base-path)
        [[ $# -gt 0 ]] || { echo "Missing value for $argument" >&2; return 1; }
        case "$argument" in --version) version=$1;; --archive) archive=$1;; --sha256) supplied_sha=$1;; esac
        shift ;;
      --yes|--no-service|--no-companions|--no-tailscale) ;;
      --help) echo 'Usage: install.sh [--version vX.Y.Z] [--yes] [--no-service] [--no-companions] [--no-tailscale] [--port PORT] [--base-path /t] [--prefix DIRECTORY] [--archive FILE --sha256 DIGEST]'; return 0 ;;
      *) echo "Unknown option: $argument" >&2; return 1 ;;
    esac
  done
  case "$(uname -s)" in Linux) platform=linux;; Darwin) platform=darwin;; *) echo 'Supported: Linux x86_64/ARM64 and macOS Apple Silicon.' >&2; return 1;; esac
  case "$(uname -m)" in x86_64|amd64) machine=x64;; arm64|aarch64) machine=arm64;; *) echo 'Unsupported CPU architecture.' >&2; return 1;; esac
  [[ "$platform-$machine" != darwin-x64 ]] || { echo 'macOS Intel is not a release target.' >&2; return 1; }
  if [[ "$platform" == linux ]]; then
    local libc
    libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
    if [[ ! "$libc" =~ ^glibc\ ([0-9]+)\.([0-9]+)$ ]] ||
        (( BASH_REMATCH[1] < 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] < 39) )); then
      echo 'Linux release bundles require glibc 2.39 or newer (Ubuntu 24.04+); nothing installed.' >&2
      return 1
    fi
  fi
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid LIBERTTY_REPOSITORY.' >&2; return 1; }
  command -v tar >/dev/null || { echo 'Install tar first.' >&2; return 1; }
  if ! command -v sha256sum >/dev/null && ! command -v shasum >/dev/null; then echo 'Install sha256sum or shasum first.' >&2; return 1; fi
  temporary=$(mktemp -d "${TMPDIR:-/tmp}/libertty-install.XXXXXXXX")
  trap "$(printf 'rm -rf -- %q' "$temporary")" EXIT
  if [[ -z "$archive" ]]; then
    command -v curl >/dev/null || { echo 'Install curl first.' >&2; return 1; }
    if [[ -z "$version" ]]; then
      version=$(curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 10 --max-time 30 "https://api.github.com/repos/$repository/releases/latest" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    fi
    [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || { echo 'No valid published release found; use --version vX.Y.Z for a prerelease.' >&2; return 1; }
    asset="libertty-$version-$platform-$machine.tar.gz"
    archive=$temporary/$asset
    echo "Downloading Libertty $version for $platform-$machine…"
    curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --connect-timeout 10 --max-time 600 "https://github.com/$repository/releases/download/$version/$asset" -o "$archive"
    curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 10 --max-time 30 "https://github.com/$repository/releases/download/$version/$asset.sha256" -o "$temporary/checksum"
    expected=$(awk -v asset="$asset" '$2 == asset {print $1}' "$temporary/checksum")
  else
    [[ -f "$archive" ]] || { echo 'Archive does not exist.' >&2; return 1; }
    expected=$supplied_sha
  fi
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'A valid SHA-256 checksum is required before executing the release.' >&2; return 1; }
  if command -v sha256sum >/dev/null; then digest=$(sha256sum "$archive"); else digest=$(shasum -a 256 "$archive"); fi
  [[ "${digest%% *}" == "$expected" ]] || { echo 'Release checksum mismatch; nothing installed.' >&2; return 1; }
  if tar -tzf "$archive" | awk '/^\// || /(^|\/)\.\.(\/|$)/ {bad=1} END {exit !bad}'; then echo 'Unsafe archive paths; nothing installed.' >&2; return 1; fi
  mkdir "$temporary/app"
  tar -xzf "$archive" -C "$temporary/app"
  [[ -x "$temporary/app/bin/node" && -f "$temporary/app/scripts/setup.mjs" ]] || { echo 'Incomplete release archive.' >&2; return 1; }
  LIBERTTY_ARCHIVE_SHA256=$expected "$temporary/app/bin/node" "$temporary/app/scripts/setup.mjs" "${arguments[@]}"
}
libertty_install "$@"
