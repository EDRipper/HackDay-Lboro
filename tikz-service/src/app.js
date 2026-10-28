import express from 'express';
import { renderTikz, RenderError } from './render.js';

const MAX_TIKZ_LENGTH = 50_000;
const LIBRARY_PATTERN = /^[\w.\-, ]*$/;

export function createApp() {
  const app = express();
  // The web UI is served from llama-server on another port, so allow cross-origin calls.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'content-type, accept');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  // Also accept raw TikZ posted as text/plain.
  app.use(express.text({ type: ['text/plain', 'application/x-tex'], limit: '100kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/render', async (req, res, next) => {
    const body = typeof req.body === 'string' ? { tikz: req.body } : req.body ?? {};
    const { tikz, tikzLibraries = '', texPackages = {} } = body;

    if (typeof tikz !== 'string' || !tikz.trim()) {
      return res.status(400).json({ error: 'Body must include a non-empty "tikz" string' });
    }
    if (tikz.length > MAX_TIKZ_LENGTH) {
      return res.status(413).json({ error: `"tikz" exceeds ${MAX_TIKZ_LENGTH} characters` });
    }
    if (typeof tikzLibraries !== 'string' || !LIBRARY_PATTERN.test(tikzLibraries)) {
      return res.status(400).json({ error: '"tikzLibraries" must be a comma-separated list of names' });
    }
    if (typeof texPackages !== 'object' || Array.isArray(texPackages)) {
      return res.status(400).json({ error: '"texPackages" must be an object of { name: options }' });
    }

    try {
      const svg = await renderTikz(tikz, { tikzLibraries, texPackages });
      if (req.accepts(['json', 'image/svg+xml']) === 'image/svg+xml') {
        return res.type('image/svg+xml').send(svg);
      }
      res.json({ svg });
    } catch (err) {
      next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof RenderError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
