import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    base: './',
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
        sourcemap: true,
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, './src'),
        },
    },
    publicDir: 'public',
});
