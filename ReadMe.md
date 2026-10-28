*MLH Lboro Digitech Hackathon Project*

Upload (or photograph) your handwritten notes and get them back clean and typeset, then get quizzed on them. Everything runs on the laptop and works in airplane mode.

```
photo ─► Gemma 4 E4B (vision OCR, llama-server) ─► JSON: headings, text, lists, maths, diagrams
                                                      │
                     maths + TikZ diagrams ─► tikz-service (TeX in WebAssembly) ─► SVG
                                                      │
                                     clean notes ─► "Quiz me" ─► Gemma asks, you type answers, Gemma marks
```

- Gemma's output is constrained to a JSON schema by llama-server, so it always parses.
- If TeX rejects a diagram, the error goes back to Gemma for one fix attempt.
- Every reply has a collapsible **Pipeline** panel showing each tool call, its timing, input and output.

## Run it

Needs Node.js. On Windows, once, with internet:

```powershell
# downloads llama.cpp + Gemma weights (~5.6 GB, gitignored) and installs tikz-service
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# puts a "HackDay Notes" shortcut (Lboro crest icon) on the desktop
powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
```

Then double-click **HackDay Notes** on the desktop (or run `scripts\launch.bat`). It starts Gemma and the TeX renderer in a minimised window and opens the app once they're ready (about 10-20 s). Close the "HackDay Notes - servers" window to shut everything down.

Manual start: `scripts\start.ps1`, then open http://127.0.0.1:8080. `start.ps1 -GpuLayers 0` forces CPU only.

## Notes

- Fonts (Nunito Sans, IBM Plex Mono, Computer Modern for TeX output), logos and the icon are bundled in `web/assets`, so nothing is fetched from the internet.
- Prompts and the JSON schema live at the top of `web/app.js`.
- See `tikz-service/README.md` for the renderer API.
