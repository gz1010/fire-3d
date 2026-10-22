#!/bin/bash
# Fire-3d: install the project's dependencies at the start of Claude Code CLOUD sessions only.
# On your own machine CLAUDE_CODE_REMOTE is not "true", so this exits at once and changes nothing.
# Progress and errors go to /tmp/fire3d-cloud-install.log (the cloud session reads it to confirm the setup).

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 0
log=/tmp/fire3d-cloud-install.log
{
  echo "== $(date -u +%FT%TZ) Fire-3d cloud install"

  # Backend: Python 3.12 and the locked dependencies (pyretechnics compiles from source with the pre-installed GCC).
  (cd backend && uv sync --frozen --python 3.12) || echo "!! backend: uv sync failed"

  # Web: the locked npm dependencies, skipped while package files and this script are unchanged.
  hashes=web/node_modules/.fire3d_install.sha256
  if ! sha256sum --check --status "$hashes" 2>/dev/null; then
    rm -f "$hashes"
    if (cd web && npm ci); then
      sha256sum .claude/hooks/cloud_install.sh web/package.json web/package-lock.json > "$hashes" || rm -f "$hashes"
    else
      echo "!! web: npm ci failed"
    fi
  fi

  echo "== $(date -u +%FT%TZ) done"
} >> "$log" 2>&1
exit 0
