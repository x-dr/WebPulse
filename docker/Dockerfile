ARG NODE_IMAGE=node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG NGINX_IMAGE=nginx:1.30.6-alpine@sha256:0e52bd054126cdc040b1276c0af347aeb02a41b9cfe305d6094767ac30e97949
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN npm install --global pnpm@10.20.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/tracker/package.json ./packages/tracker/package.json
RUN pnpm install --frozen-lockfile
COPY apps/ ./apps/
COPY packages/ ./packages/
RUN pnpm -r build
RUN pnpm --filter @webpulse/server deploy --prod --legacy /release

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /release/ ./
COPY --from=build --chown=node:node /repo/packages/tracker/dist/tracker.js ./tracker.js
ENV TRACKER_FILE=/app/tracker.js
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM ${NGINX_IMAGE} AS web
COPY --from=build /repo/apps/dashboard/dist/ /usr/share/nginx/html/
COPY --from=build /repo/packages/tracker/dist/tracker.js /usr/share/nginx/html/tracker.js
COPY docker/nginx.conf.template /etc/nginx/webpulse.conf.template
COPY --chmod=755 docker/web-entrypoint.sh /usr/local/bin/webpulse-web
USER 1000:1000
EXPOSE 8080 8443
ENTRYPOINT ["webpulse-web"]
