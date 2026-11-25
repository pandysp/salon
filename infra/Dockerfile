# Based on the infra spike's Dockerfile. Changed: pinned binaries downloaded and sha256-checked here (the single place for their versions); the app is
# the pre-built platform Worker (npm run build). Build from the repo root: docker build -f infra/Dockerfile -t artifacts-platform:core .
FROM debian:trixie-slim
ARG CELLD_V=0.6.3 CELLD_SHA=6d617cdf9f049e43ca6a4e37c4cce5d8e35395c8e86b371c984d32ba7d803bf5
ARG TS_V=1.104.7 TS_SHA=d6bed2720310b328b861f943d7b4016c5358a9bad60575eb51e8143b79068484
ARG ESBUILD_V=0.28.2 ESBUILD_SHA=a96dbfa41d3ef5dbd1ef22b1c10d5187be9267e86093a870f06402a7ec931596
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iproute2 curl procps && rm -rf /var/lib/apt/lists/* \
 && cd /tmp \
 && curl -fsSL -o celld.gz https://github.com/denoland/celld/releases/download/v$CELLD_V/celld-aarch64-unknown-linux-gnu.gz \
 && curl -fsSL -o ts.tgz https://pkgs.tailscale.com/stable/tailscale_${TS_V}_arm64.tgz \
 && curl -fsSL -o esbuild.tgz https://registry.npmjs.org/@esbuild/linux-arm64/-/linux-arm64-$ESBUILD_V.tgz \
 && printf '%s  celld.gz\n%s  ts.tgz\n%s  esbuild.tgz\n' $CELLD_SHA $TS_SHA $ESBUILD_SHA | sha256sum -c - \
 && gunzip -c celld.gz > /usr/local/bin/celld && chmod +x /usr/local/bin/celld \
 && tar -xzf ts.tgz --strip-components=1 -C /usr/local/bin tailscale_${TS_V}_arm64/tailscale tailscale_${TS_V}_arm64/tailscaled \
 && tar -xzf esbuild.tgz --strip-components=2 -C /usr/local/bin package/bin/esbuild \
 && rm -f /tmp/celld.gz /tmp/ts.tgz /tmp/esbuild.tgz
COPY app/wrangler.jsonc app/worker.js /app/
COPY infra/entrypoint.sh /entrypoint.sh
ENV CELLD_ESBUILD=/usr/local/bin/esbuild
WORKDIR /app
ENTRYPOINT ["/entrypoint.sh"]
