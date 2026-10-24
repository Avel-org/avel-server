# Spike image (2026-10-24): the check runner's pinned Node image plus the
# Linux build of the Claude Code binary the SDK runs, at the SDK's version.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN npm install --prefix /opt/claude --ignore-scripts --no-audit --no-fund \
      @anthropic-ai/claude-agent-sdk-linux-x64@0.3.296 \
 && ln -s /opt/claude/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /usr/local/bin/claude \
 && mkdir /work && chown node:node /work
USER node
WORKDIR /work
