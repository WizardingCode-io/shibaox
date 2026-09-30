# The shibaox daemon, reachable over the network with a token (`shibaox serve`).
#   docker run -d -p 7433:7433 -e SHIBAOX_DAEMON_TOKEN=$(openssl rand -hex 32) \
#     -v shibaox-data:/data -v /srv/projects:/projects ghcr.io/wizardingcode-io/shibaox
# Then, from your machine: shibaox remote set http://<host>:7433 <token>
FROM node:22-bookworm-slim

ARG SHIBAOX_VERSION=latest

# git for the git cycle, gh for pull requests, ssh for remotes, python/build tools only if a
# prebuilt better-sqlite3 is missing for this platform
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssh-client \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# the CLI, the daemon and Claude Code (for anthropic-subscription roles; log in once, see the wiki)
RUN npm install -g "shibaox@${SHIBAOX_VERSION}" @anthropic-ai/claude-code \
  && npm cache clean --force

RUN useradd --create-home --shell /bin/bash shibaox \
  && mkdir -p /data /projects \
  && chown shibaox:shibaox /data /projects
USER shibaox

# mounted repositories may belong to another uid: git must still work in them
RUN git config --global --add safe.directory '*' \
  && git config --global user.name shibaox \
  && git config --global user.email shibaox@localhost

ENV SHIBAOX_HOME=/data \
    CLAUDE_CONFIG_DIR=/data/claude \
    SHIBAOX_NO_AUTOSTART=1
VOLUME ["/data", "/projects"]
WORKDIR /projects
EXPOSE 7433

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:7433/health || exit 1

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/shibaox-entrypoint
ENTRYPOINT ["shibaox-entrypoint"]
CMD ["serve", "--host", "0.0.0.0", "--port", "7433"]
