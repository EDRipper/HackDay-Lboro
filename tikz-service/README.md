# tikz-service

Express microservice that compiles TikZ to SVG with [node-tikzjax](https://github.com/prinsss/node-tikzjax) (TeX running in WebAssembly, no LaTeX install needed), then optimises the result with SVGO.

```bash
npm install
npm start        # http://localhost:3001 (override with PORT)
npm test
```

## `POST /render`

JSON body:

| field           | type   | notes                                                                 |
| --------------- | ------ | --------------------------------------------------------------------- |
| `tikz`          | string | Required. A bare `tikzpicture` or a full `\begin{document}…` body.     |
| `tikzLibraries` | string | Optional, e.g. `"arrows.meta,positioning"`.                           |
| `texPackages`   | object | Optional, e.g. `{ "amsmath": "" }`. Value is the package options.     |

Returns `{ "svg": "<svg …>" }`. Send `Accept: image/svg+xml` to get the raw SVG instead. You can also POST the TikZ as `text/plain`.

```bash
curl -s localhost:3001/render -H 'content-type: application/json' \
  -d '{"tikz":"\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}"}'
```

Errors come back as `{ "error": "…" }`: `400` bad input, `413` too large, `422` TikZ failed to compile, `504` render timeout (`RENDER_TIMEOUT_MS`, default 20s).

## Notes

- Renders run one at a time, because node-tikzjax keeps the TeX engine in global state. Each one takes about 100–600ms.
- Text in the SVG uses Computer Modern font names (`cmr10`, `cmmi10`, …). To display it properly, the frontend should load `https://cdn.jsdelivr.net/npm/node-tikzjax@latest/css/fonts.css`.
