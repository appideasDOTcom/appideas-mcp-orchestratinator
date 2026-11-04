FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilt binaries for common platforms; the toolchain
# below is only a fallback for when a prebuild isn't available for this arch.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

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
