/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    base: '/hdb_resale_map/',
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
        sourcemap: true,
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, './src'),
            'child_process': resolve(__dirname, './src/shims/child_process.ts'),
        },
    },
    publicDir: 'public',
    test: {
        globals: true,
        environment: 'node',
    },
});
