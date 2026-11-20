FROM node:22-bookworm-slim
# Exact agent versions, always given: setup.py passes this core's tested ones
# (agents.json) or a host layer's pinned ones, and checks the image has them.
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
RUN test -n "$CLAUDE_CODE_VERSION" && test -n "$CODEX_VERSION" \
    || { echo "CLAUDE_CODE_VERSION and CODEX_VERSION are required" >&2; exit 1; }
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 curl ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
RUN mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV HOME=/home/node CODEX_HOME=/home/node/.codex
