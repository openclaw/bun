#!/bin/bash
# Signs the darwin executables of a release with a Developer ID and the
# hardened runtime, notarizes their zips, and records the result next to each
# zip as <target>.signing.json, which `release.ts manifest` reads.
#
#   scripts/openclaw-release/sign-macos.sh --dist <dir> --entitlements <plist> <target>...
#
# <dir> holds bun-darwin-<arch>.zip as `release.ts build` wrote it; each zip is
# replaced by one holding the signed executable. <target> is darwin-arm64 or
# darwin-x64. Runs on macOS, in CI or on a maintainer's Mac.
#
# Environment (the names openclaw's scripts/notarize-mac-artifact.sh uses):
#   SIGN_IDENTITY       codesign identity; default: the only "Developer ID Application" identity found
#   SIGN_KEYCHAIN       keychain to take the identity from, instead of the search list
#   NOTARYTOOL_PROFILE  notarytool keychain profile, or
#   NOTARYTOOL_KEY, NOTARYTOOL_KEY_ID, NOTARYTOOL_ISSUER  an App Store Connect API key (.p8 path, key id, issuer)
#   SKIP_NOTARIZE=1     sign only; the record says notarized: false

set -euo pipefail

dist=""
entitlements=""
targets=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dist) dist="$2"; shift 2 ;;
    --entitlements) entitlements="$2"; shift 2 ;;
    darwin-arm64 | darwin-x64) targets+=("$1"); shift ;;
    *) echo "sign-macos: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$dist" ] && [ -f "$entitlements" ] && [ ${#targets[@]} -gt 0 ] || {
  echo "usage: sign-macos.sh --dist <dir> --entitlements <plist> darwin-arm64|darwin-x64..." >&2
  exit 2
}
dist="$(cd "$dist" && pwd)"

keychain_args=()
[ -n "${SIGN_KEYCHAIN:-}" ] && keychain_args=(--keychain "$SIGN_KEYCHAIN")
identity="${SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  identities="$(security find-identity -v -p codesigning ${SIGN_KEYCHAIN:+"$SIGN_KEYCHAIN"} | sed -n 's/.*"\(Developer ID Application: .*\)"$/\1/p' | sort -u)"
  if [ "$(printf '%s\n' "$identities" | grep -c .)" -ne 1 ]; then
    echo "sign-macos: set SIGN_IDENTITY; the keychain has these Developer ID identities:" >&2
    printf '  %s\n' "$identities" >&2
    exit 1
  fi
  identity="$identities"
fi

notary_args=()
if [ "${SKIP_NOTARIZE:-}" != "1" ]; then
  if [ -n "${NOTARYTOOL_PROFILE:-}" ]; then
    notary_args=(--keychain-profile "$NOTARYTOOL_PROFILE")
  elif [ -n "${NOTARYTOOL_KEY:-}" ] && [ -n "${NOTARYTOOL_KEY_ID:-}" ] && [ -n "${NOTARYTOOL_ISSUER:-}" ]; then
    notary_args=(--key "$NOTARYTOOL_KEY" --key-id "$NOTARYTOOL_KEY_ID" --issuer "$NOTARYTOOL_ISSUER")
  else
    echo "sign-macos: set NOTARYTOOL_PROFILE or NOTARYTOOL_KEY/NOTARYTOOL_KEY_ID/NOTARYTOOL_ISSUER, or SKIP_NOTARIZE=1" >&2
    exit 1
  fi
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for target in "${targets[@]}"; do
  case "$target" in
    darwin-arm64) triplet=bun-darwin-aarch64 arch=arm64 ;;
    darwin-x64) triplet=bun-darwin-x64 arch=x86_64 ;;
  esac
  zip="$dist/$triplet.zip"
  rm -rf "${work:?}/$triplet"
  ditto -x -k "$zip" "$work"
  exe="$work/$triplet/bun"
  lipo "$exe" -verify_arch "$arch"

  codesign --force --timestamp --options runtime --entitlements "$entitlements" ${keychain_args[@]+"${keychain_args[@]}"} --sign "$identity" "$exe"
  codesign --verify --strict --verbose=2 "$exe"
  team="$(codesign -dv "$exe" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  granted="$(codesign -d --entitlements - --xml "$exe" 2>/dev/null)"
  case "$granted" in *com.apple.security.cs.allow-jit*) ;; *) echo "sign-macos: $target lost allow-jit" >&2; exit 1 ;; esac

  rm -f "$zip"
  ditto -c -k --norsrc --keepParent "$work/$triplet" "$zip"

  notarized=false
  submission=""
  if [ ${#notary_args[@]} -gt 0 ]; then
    result="$work/$target.notary.json"
    xcrun notarytool submit "$zip" "${notary_args[@]}" --no-s3-acceleration --wait --timeout 1h --output-format json > "$result"
    submission="$(plutil -extract id raw -o - "$result")"
    status="$(plutil -extract status raw -o - "$result")"
    if [ "$status" != "Accepted" ]; then
      echo "sign-macos: notarization of $target ended $status (submission $submission)" >&2
      xcrun notarytool log "$submission" "${notary_args[@]}" >&2 || true
      exit 1
    fi
    notarized=true
  fi

  # A bare executable has no place to staple a ticket: Gatekeeper looks the notarization up online by its cdhash.
  cat > "$dist/$target.signing.json" <<EOF
{
  "kind": "developer-id",
  "identity": "$identity",
  "teamId": "$team",
  "notarized": $notarized$( [ -n "$submission" ] && printf ',\n  "notarySubmissionId": "%s"' "$submission" )
}
EOF
  echo "sign-macos: $target signed by $identity (team $team), notarized: $notarized"
done
