FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY packages/core packages/core
COPY apps/hub apps/hub
RUN bun install --frozen-lockfile --production \
 && bun build apps/hub/src/main.ts --target bun --outfile /out/hub.js

FROM litestream/litestream:0.5.17@sha256:4b02b9859a6b6b4087d8b8944e15f7e984bd7957cba322bbeee38b0e27b9656a AS litestream

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY apps/hub/docker/litestream.yml /etc/litestream.yml
COPY --chmod=0755 apps/hub/docker/entrypoint.sh /app/entrypoint.sh
COPY --from=build /out/hub.js /app/hub.js
RUN mkdir /data && chown bun:bun /data
USER bun
WORKDIR /app
ENV HUB_DATA=/data HUB_LISTEN=:8080
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=330s --start-interval=1s \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.HUB_LISTEN.split(':').pop()}/v1/version`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/app/entrypoint.sh"]
