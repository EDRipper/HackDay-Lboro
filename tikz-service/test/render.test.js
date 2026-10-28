import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

const post = (body, headers = { 'content-type': 'application/json' }) =>
  fetch(`${base}/render`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('renders a bare tikzpicture to SVG', async () => {
  const res = await post({ tikz: '\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}' });
  assert.equal(res.status, 200);
  const { svg } = await res.json();
  assert.match(svg, /^<svg/);
  assert.match(svg, /viewBox=/);
});

test('handles concurrent requests', async () => {
  const shapes = ['circle (1)', 'rectangle (2,1)', '-- (3,3)'];
  const results = await Promise.all(
    shapes.map((s) => post({ tikz: `\\begin{tikzpicture}\\draw (0,0) ${s};\\end{tikzpicture}` })),
  );
  for (const res of results) assert.equal(res.status, 200);
});

test('accepts text/plain and returns raw SVG when asked', async () => {
  const res = await post('\\begin{tikzpicture}\\node {hi};\\end{tikzpicture}', {
    'content-type': 'text/plain',
    accept: 'image/svg+xml',
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await res.text(), /^<svg/);
});

test('supports tikz libraries', async () => {
  const res = await post({
    tikz: '\\begin{tikzpicture}\\draw[-{Stealth}] (0,0) -- (1,0);\\end{tikzpicture}',
    tikzLibraries: 'arrows.meta',
  });
  assert.equal(res.status, 200);
});

test('rejects missing tikz', async () => {
  const res = await post({});
  assert.equal(res.status, 400);
});

test('returns 422 for invalid TikZ', async () => {
  const res = await post({ tikz: '\\begin{tikzpicture}\\draw (0,0 -- ;\\end{tikzpicture}' });
  assert.equal(res.status, 422);
  assert.ok((await res.json()).error);
});
