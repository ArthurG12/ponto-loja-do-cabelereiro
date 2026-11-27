#!/usr/bin/env bash
set -Eeuo pipefail

# Downloads the official ICP-Brasil CAdES LPA and AD-RB 2.4 policy artifacts.
# This script does NOT establish trust: the Java signer must still validate the
# detached LPA CMS signature against independently pinned ICP-Brasil roots.
DESTINATION="${1:-}"
if [[ -z "$DESTINATION" ]]; then
  echo "Usage: $0 <external-artifact-directory>" >&2
  exit 2
fi

BASE_URL="https://politicas.icpbrasil.gov.br"
mkdir -p "$DESTINATION"
DESTINATION="$(cd "$DESTINATION" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

download_and_check() {
  local artifact="$1"
  local sidecar="$2"
  local expected actual
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    "$BASE_URL/$artifact" --output "$TMP/$artifact"
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    "$BASE_URL/$sidecar" --output "$TMP/$sidecar"

  expected="$(grep -Eio '[a-f0-9]{64}' "$TMP/$sidecar" | head -n 1 || true)"
  if [[ ! "$expected" =~ ^[[:xdigit:]]{64}$ ]]; then
    echo "Could not parse SHA-256 sidecar for $artifact" >&2
    return 1
  fi
  actual="$(sha256sum "$TMP/$artifact" | awk '{print $1}')"
  if [[ "${actual,,}" != "${expected,,}" ]]; then
    echo "SHA-256 mismatch for $artifact" >&2
    return 1
  fi
  install -m 0644 "$TMP/$artifact" "$DESTINATION/$artifact"
  install -m 0644 "$TMP/$sidecar" "$DESTINATION/$sidecar"
  printf 'verified sidecar hash: %s  %s\n' "$actual" "$artifact"
}

download_and_check "LPA_CAdES.der" "LPA_CAdES_der-sha256.txt"
download_and_check "LPA_CAdES.p7s" "LPA_CAdES_p7s-sha256.txt"
download_and_check "PA_AD_RB_v2_4.der" "PA_AD_RB_v2_4der-sha256.txt"

cat <<'NOTICE'
Artifacts downloaded and checked against ITI-published SHA-256 sidecars.
This is only an integrity check, not an independent trust decision.
Before signing, provision ICP-Brasil trust anchors through a separate trusted
channel and run the Java signer's CMS, PKIX, revocation, LPA and PA checks.
Do not commit these artifacts, certificates, keystores or secrets to Git.
NOTICE
