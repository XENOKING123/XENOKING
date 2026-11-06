import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { svc: 'xenosaves-archive' },
  redact: {
    paths: ['*.authorization', '*.Authorization', '*.secretAccessKey', '*.token', '*.apiKey', 'headers.authorization'],
    censor: '[redacted]',
  },
});

export type Logger = typeof log;
