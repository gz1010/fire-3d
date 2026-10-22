#!/bin/bash
# Fire-3d cloud environment setup script.
# Paste this into the "Setup script" field of your cloud environment at claude.ai/code (see docs/cloud/SETUP.md).
# It runs as root on Ubuntu 24.04 before Claude starts, and is cached when it finishes within about five minutes.
# Project dependencies (uv sync, npm ci) install later, in .claude/hooks/cloud_install.sh.

# Python 3.12 for the backend (backend/pyproject.toml requires >=3.12,<3.13).
uv python install 3.12 || true

# Google Chrome and its system libraries for headless screenshots (web/scripts/shot.mjs uses the "chrome" channel).
# There is no GPU in the cloud, so WebGL runs in software: screenshots work, frame-rate checks don't.
npx -y playwright@1.64.1 install --with-deps chrome || true

exit 0
