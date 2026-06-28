#!/usr/bin/env bash
#
# apply.sh — RETIRED.
#
# This fork is now installed directly as a pinned pi git package:
#   git:github.com/shashank-mugiwara/pi-mempalace@<commit>
#
# Do not patch ~/.pi/agent/npm/node_modules/pi-mempalace anymore. That older
# npm-runtime bridge was removed on 2026-06-28 because it made the installed
# package source ambiguous and could be silently reverted by package updates.
#
# To move pi to a newer fork commit, use:
#   pi install git:github.com/shashank-mugiwara/pi-mempalace@<new-commit>
#
set -euo pipefail

cat >&2 <<'MSG'
apply.sh is retired.

pi-mempalace is now loaded as a pinned git package, not by patching the npm
runtime directory. To update the installed fork, run:

  pi install git:github.com/shashank-mugiwara/pi-mempalace@<new-commit>

Then ensure ~/.pi/agent/settings.json contains only that git mempalace source.
MSG

exit 1
