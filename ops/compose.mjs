import { resolve } from 'node:path';

export function composeArguments(env = process.env) {
  return [
    'compose',
    '--env-file',
    resolve(env.WEBPULSE_ENV_FILE ?? '.env.production'),
    '-f',
    resolve('compose.yml'),
    ...(env.WEBPULSE_COMPOSE_OVERRIDE_FILE
      ? ['-f', resolve(env.WEBPULSE_COMPOSE_OVERRIDE_FILE)]
      : []),
  ];
}
