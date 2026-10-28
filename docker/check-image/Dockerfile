# AVEL's check image (AVEL_CHECK_IMAGE): the pinned Node image the gate
# already ran on, plus Debian's Chromium, so browser checks (Playwright,
# axe, Lighthouse) run with no download. The check container has no
# network and no capabilities, so Chromium runs with --no-sandbox
# --disable-dev-shm-usage, set by each project's configs; the container is
# the sandbox. apt versions are whatever bookworm serves at build time:
# the digest the build pushes is what AVEL pins, never this file.
FROM node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		chromium \
		fonts-liberation \
		fonts-noto-color-emoji \
		ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium \
	PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
