import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

function clientHtml(): Plugin {
  const favicon = '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E%3Crect width=\'32\' height=\'32\' rx=\'6\' fill=\'%23171717\'/%3E%3Ctext x=\'16\' y=\'22\' font-family=\'monospace\' font-size=\'16\' font-weight=\'bold\' fill=\'%23a5b4fc\' text-anchor=\'middle\'%3EMC%3C/text%3E%3C/svg%3E" />';
  const devHtml = '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />' + favicon + '</head><body><div id="root"></div><script type="module" src="/src/client/main.tsx"></script></body></html>';
  return {
    name: 'client-html',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/' || req.url?.startsWith('/?')) {
          res.setHeader('Content-Type', 'text/html');
          res.end(devHtml);
          return;
        }
        next();
      });
    },
    generateBundle(_, bundle) {
      const js = Object.keys(bundle).find((file) => file.endsWith('.js'));
      const css = Object.keys(bundle).find((file) => file.endsWith('.css'));
      if (!js) throw new Error('Client JavaScript bundle missing');
      this.emitFile({ type: 'asset', fileName: 'index.html', source: '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />' + favicon + (css ? '<link rel="stylesheet" crossorigin href="/' + css + '">' : '') + '</head><body><div id="root"></div><script type="module" crossorigin src="/' + js + '"></script></body></html>' });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), clientHtml()],
  server: { port: 5173, proxy: { '/api': { target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000', changeOrigin: false } } },
  build: { outDir: 'dist/client', emptyOutDir: true, rollupOptions: { input: 'src/client/main.tsx' } },
  base: '/',
});
