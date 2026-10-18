#!/usr/bin/env bash
set -euo pipefail

# Audit all git-tracked files for leaked tokens, private keys, Netscape cookies, and public IPv4s.
mapfile -t FILES < <(git ls-files)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "[check-secrets] No tracked files found."
  exit 0
fi

FAILED=0

# 1. Secret / Token / Private Key patterns
TOKEN_REGEX='(eyJ[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,})'

TOKEN_HITS=$(grep -nE "$TOKEN_REGEX" "${FILES[@]}" 2>/dev/null | grep -v '^scripts/check-secrets\.sh:' || true)
if [ -n "$TOKEN_HITS" ]; then
  echo "[check-secrets] ERROR: Token or private key pattern detected:"
  echo "$TOKEN_HITS"
  FAILED=1
fi

# 2. Netscape cookies format (.youtube.com<TAB>TRUE)
COOKIE_REGEX=$'\\.youtube\\.com\tTRUE'
COOKIE_HITS=$(grep -nE "$COOKIE_REGEX" "${FILES[@]}" 2>/dev/null | grep -v '^scripts/check-secrets\.sh:' || true)
if [ -n "$COOKIE_HITS" ]; then
  echo "[check-secrets] ERROR: Netscape YouTube cookie line detected:"
  echo "$COOKIE_HITS"
  FAILED=1
fi

# 3. Public IPv4 addresses (excluding loopback, RFC1918 private ranges, and link-local/broadcast)
# Scan all tracked files except package-lock.json and binary images/icons
NON_LOCK_FILES=()
for f in "${FILES[@]}"; do
  case "$f" in
    package-lock.json|scripts/check-secrets.sh|*.png|*.ico|*.webp|*.jpg|*.jpeg)
      continue
      ;;
    *)
      NON_LOCK_FILES+=("$f")
      ;;
  esac
done

if [ "${#NON_LOCK_FILES[@]}" -gt 0 ]; then
  IPV4_CANDIDATES=$(grep -nEo '(^|[^0-9.])((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])([^0-9.]|$)' "${NON_LOCK_FILES[@]}" 2>/dev/null || true)
  if [ -n "$IPV4_CANDIDATES" ]; then
    PUBLIC_IPS=""
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      ip=$(echo "$line" | grep -Eo '((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])' | head -n 1)
      [ -z "$ip" ] && continue
      case "$ip" in
        0.0.0.0|*.0.0.0|127.*|10.*|192.168.*|169.254.*|255.255.255.255|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*)
          continue
          ;;
        *)
          PUBLIC_IPS+="${line}"$'\n'
          ;;
      esac
    done <<< "$IPV4_CANDIDATES"

    if [ -n "$PUBLIC_IPS" ]; then
      echo "[check-secrets] ERROR: Public IPv4 address detected in tracked files:"
      printf "%s" "$PUBLIC_IPS"
      FAILED=1
    fi
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  echo "[check-secrets] FAILED: Sensitive data or public IPv4 found."
  exit 1
fi

echo "[check-secrets] OK: 0 secrets, cookies, or public IPv4s found in ${#FILES[@]} tracked files."
