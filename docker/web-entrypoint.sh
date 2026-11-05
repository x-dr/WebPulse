#!/bin/sh
set -eu
case "${WEBPULSE_DOMAIN:-}" in
  ''|*[!a-zA-Z0-9.-]*) echo 'Invalid WEBPULSE_DOMAIN' >&2; exit 1 ;;
esac
envsubst '${WEBPULSE_DOMAIN}' < /etc/nginx/webpulse.conf.template > /tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'
