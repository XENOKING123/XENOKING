import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/api/dashboard', { recursive: true });
cpSync('src/api/dashboard', 'dist/api/dashboard', { recursive: true });
mkdirSync('dist/migrations', { recursive: true });
cpSync('migrations', 'dist/migrations', { recursive: true });
