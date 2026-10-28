import tikzjax from 'node-tikzjax';
import { optimize } from 'svgo';

// node-tikzjax is CommonJS with `exports.default`, so ESM sees it one level deep.
const tex2svg = tikzjax.default ?? tikzjax;

const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 20000);

// node-tikzjax keeps the TeX engine and its in-memory filesystem in module
// globals (input.tex/input.dvi), so concurrent renders would clobber each
// other. Chain every render onto a single queue.
let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RenderError(`Render timed out after ${ms}ms`, 504)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class RenderError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

// The model may return a bare tikzpicture; TikZJax needs a full document body.
export function toDocument(tikz) {
  const src = tikz.trim();
  if (src.includes('\\begin{document}')) return src;
  return `\\begin{document}\n${src}\n\\end{document}`;
}

export function optimizeSvg(svg) {
  return optimize(svg, {
    multipass: true,
    plugins: [
      {
        name: 'preset-default',
        params: {
          overrides: {
            // TikZJax glyph ids are referenced by <use>; keep them unique-safe.
            cleanupIds: { minify: false },
          },
        },
      },
    ],
  }).data;
}

export async function renderTikz(tikz, { tikzLibraries = '', texPackages = {} } = {}) {
  const input = toDocument(tikz);

  const raw = await enqueue(() =>
    withTimeout(
      tex2svg(input, {
        tikzLibraries,
        texPackages,
        // We run our own SVGO pass below with an explicit config.
        disableOptimize: true,
      }),
      RENDER_TIMEOUT_MS,
    ),
  ).catch((err) => {
    if (err instanceof RenderError) throw err;
    throw new RenderError(`TikZ compilation failed: ${err.message}`);
  });

  return optimizeSvg(raw);
}
