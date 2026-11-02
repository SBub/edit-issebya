#!/usr/bin/env bash
# Vercel Ignored Build Step. exit 0 = skip the build, exit 1 = build.
# ADW branches (...-adw-...) build only the commit the toolkit marked with
# the `Deploy-Preview: yes` trailer; everything else builds as usual.
[ "$VERCEL_ENV" = "production" ] && exit 1
case "$VERCEL_GIT_COMMIT_REF" in
  *-adw-*) ;;
  *) exit 1 ;;
esac
msg="$(git log -1 --format=%B 2>/dev/null)"
[ -n "$msg" ] || msg="$VERCEL_GIT_COMMIT_MESSAGE"
printf '%s\n' "$msg" | grep -q '^Deploy-Preview: yes' && exit 1
exit 0
