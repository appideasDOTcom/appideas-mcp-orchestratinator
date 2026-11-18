# One Node major for what ships and what is tested (costmo's ruling on the
# milestone audit's finding 5, 2026-11-17): the release gate runs the suites
# on Node 24 (CLAUDE.md, Tests), and the host's LaunchAgent runs 24
# (host/install.sh). A change here is a change in all three places.
FROM node:24-bookworm-slim

# better-sqlite3 ships prebuilt binaries for common platforms; the toolchain
# below is only a fallback for when a prebuild isn't available for this arch.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The lockfile is what the suites ran on, so the image installs exactly it:
# `npm ci` fails the build when package.json and the lock disagree, and
# copying the lock here is what makes a lock-only change rebuild this layer.
# Before this, `npm install` resolved the caret ranges fresh at every deploy,
# and the board shipped an SDK and a better-sqlite3 no suite had run.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# The commit this image is built from, so the board can compare itself with
# the newest commit on GitHub (issue #40; src/build-info.js has the why).
# `gitmeta` is the clone's .git, handed over by docker-compose.yml as a build
# context of its own: bind-mounted for this one step, never copied into a
# layer, and not filtered by .dockerignore (which keeps .git out of the main
# context). Last, because .git changes on every commit and this step is the
# only one that should rerun for it. A plain `docker build .` has no such
# context and fails here — build through compose.
RUN --mount=type=bind,from=gitmeta,target=/gitmeta node src/build-info.js /gitmeta > BUILD_COMMIT

ENV NODE_ENV=production
ENV PORT=8787
ENV DB_PATH=/data/orchestratinator.db

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
