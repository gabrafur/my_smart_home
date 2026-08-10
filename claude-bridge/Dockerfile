FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin git && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    @anthropic-ai/claude-code@2.1.197 \
    @openai/codex@0.147.0

# --dangerously-skip-permissions refuses to run as root/sudo, so run as the
# image's built-in "node" user. Compose adds the host docker socket GID at
# runtime, avoiding a host-specific rebuild.
RUN mkdir -p /home/node/.claude /home/node/.codex && \
    chown -R node:node /home/node/.claude /home/node/.codex

WORKDIR /app
COPY server.js history.js package.json ./
RUN chown -R node:node /app

USER node

EXPOSE 8099
CMD ["node", "server.js"]
