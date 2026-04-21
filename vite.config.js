import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    plugins: [
        tailwindcss(),
    ],
    root: 'public',
    build: {
        outDir: '../dist',
        emptyOutDir: true,
    },
    server: {
        proxy: {
            '/api': 'http://localhost:3099',
            '/socket.io': {
                target: 'http://localhost:3099',
                ws: true,
            },
            '/uploads': 'http://localhost:3099',
        },
    },
});
