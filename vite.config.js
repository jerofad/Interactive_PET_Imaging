import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, 'site');

// Absolute site URL, e.g. https://example.com/pet/ . Optional: enables canonical links, og:url and sitemap.xml.
const SITE_URL = (process.env.SITE_URL || '').replace(/\/?$/, process.env.SITE_URL ? '/' : '');

/** Every index.html under site/, excluding source folders. */
function pages(dir, found = {}) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!['src', 'node_modules'].includes(name)) pages(path, found);
    } else if (name === 'index.html') {
      const key = relative(root, dir).replace(/[\\/]/g, '-') || 'home';
      found[key] = path;
    }
  }
  return found;
}

/** Strict Content Security Policy, with hashes for the one inline theme script. Build only. */
function securityAndSeo() {
  const routes = Object.values(pages(root)).map((file) => relative(root, dirname(file)).replace(/\\/g, '/'));
  return {
    name: 'pet-security-and-seo',
    apply: 'build',
    transformIndexHtml(html, ctx) {
      const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`,
      );
      const policy = [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(' ')}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
      ].join('; ');
      let out = html.replace(
        '<meta charset="utf-8">',
        `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${policy}">`,
      );
      const route = relative(root, dirname(ctx.filename)).replace(/\\/g, '/');
      if (SITE_URL) {
        const url = SITE_URL + (route ? route + '/' : '');
        out = out
          .replace(
            '<meta name="twitter:card" content="summary">',
            '<meta name="twitter:card" content="summary_large_image">',
          )
          .replace(
            '</head>',
            `<link rel="canonical" href="${url}">\n<meta property="og:url" content="${url}">\n` +
              `<meta property="og:image" content="${SITE_URL}og-image.png">\n<meta property="og:image:width" content="1200">\n` +
              `<meta property="og:image:height" content="630">\n</head>`,
          );
      }
      return out;
    },
    generateBundle() {
      if (!SITE_URL) {
        this.emitFile({ type: 'asset', fileName: 'robots.txt', source: 'User-agent: *\nAllow: /\n' });
        return;
      }
      const urls = routes
        .sort()
        .map((r) => `  <url><loc>${SITE_URL}${r ? r + '/' : ''}</loc></url>`)
        .join('\n');
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      });
      this.emitFile({ type: 'asset', fileName: 'og-image.png', source: readFileSync(resolve(root, 'og-image.png')) });
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`,
      });
    },
  };
}

export default defineConfig({
  root,
  // './' makes the build portable: it works at a domain root or in any subfolder without rebuilding.
  base: process.env.BASE_PATH || './',
  publicDir: false,
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: pages(root) },
  },
  worker: { format: 'es' },
  plugins: [securityAndSeo()],
  test: {
    root: here,
    include: ['tests/unit/**/*.test.js'],
    testTimeout: 60000,
  },
});
