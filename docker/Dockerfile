ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG RUNTIME_NODE_IMAGE=node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ARG NGINX_IMAGE=nginx:1.30.6-alpine@sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311
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

FROM ${RUNTIME_NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
# Production commands use Node directly. Do not ship package managers and their dependencies.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*
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
