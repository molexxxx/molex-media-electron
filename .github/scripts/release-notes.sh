#!/usr/bin/env bash
# Prints the CHANGELOG.md section of one version as release notes: the section's own title as the heading, its body,
# and a compare link to the previous tag when one is given. Prints nothing when CHANGELOG.md has no such section.
# The changelog wraps its lines; GitHub renders every newline in a release body as a break, so paragraphs and list
# items are joined back into single lines (fenced code is left as it is).
#
#   .github/scripts/release-notes.sh <version> [previous-tag] [owner/repo]
set -euo pipefail

version="${1#v}"
previous="${2:-}"
repo="${3:-${GITHUB_REPOSITORY:-}}"

section=$(awk -v v="$version" '
  index($0, "## [" v "]") == 1 {
    found = 1
    title = $0
    sub(/^## \[[^]]*\]( - [0-9-]+)?( - )?/, "", title)
    if (title != "") print "## " title
    next
  }
  found && /^## \[/ { exit }
  found { print }
' CHANGELOG.md)

if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
  exit 0
fi

printf '%s\n' "$section" | awk '
  function flush() { if (buf != "") print buf; buf = "" }
  /^```/ { flush(); fenced = !fenced; print; next }
  fenced { print; next }
  /^[[:space:]]*$/ { flush(); print ""; next }
  /^#/ || /^\|/ { flush(); print; next }
  /^[-*] / || /^[0-9]+\. / { flush(); buf = $0; next }
  {
    line = $0
    sub(/^[[:space:]]+/, "", line)
    buf = (buf == "") ? line : buf " " line
  }
  END { flush() }
' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
if [ -n "$previous" ] && [ -n "$repo" ]; then
  printf '\n**Full changelog:** https://github.com/%s/compare/%s...v%s\n' "$repo" "$previous" "$version"
fi
