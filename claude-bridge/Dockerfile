FROM node:20-slim

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

RUN npm install -g @anthropic-ai/claude-code

# --dangerously-skip-permissions refuses to run as root/sudo, so run as the
# image's built-in "node" user, added to a group matching the host's docker
# GID so it can use the mounted docker.sock.
ARG DOCKER_GID=987
RUN (getent group ${DOCKER_GID} || groupadd -g ${DOCKER_GID} dockerhost) && \
    usermod -aG ${DOCKER_GID} node && \
    mkdir -p /home/node/.claude && \
    chown -R node:node /home/node/.claude

WORKDIR /app
COPY server.js package.json ./
RUN chown -R node:node /app

USER node

EXPOSE 8099
CMD ["node", "server.js"]
