ARG NODE_IMAGE=node:24-bookworm-slim
ARG NGINX_IMAGE=nginx:stable-alpine

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=10.20.0
WORKDIR /repo
RUN npm install --global pnpm@${PNPM_VERSION}
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
RUN pnpm --filter @webpulse/server deploy --prod --legacy /release

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /release/ ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM ${NGINX_IMAGE} AS web
COPY --from=build /repo/apps/dashboard/dist/ /usr/share/nginx/html/
COPY --from=build /repo/packages/tracker/dist/tracker.js /usr/share/nginx/html/tracker.js
COPY docker/nginx.conf /etc/nginx/nginx.conf
EXPOSE 80 443
ENTRYPOINT ["nginx", "-g", "daemon off;"]
