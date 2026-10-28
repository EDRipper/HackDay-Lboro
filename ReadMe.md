*MLH Lboro Digitech Hackathon Project*

Drop a photo of a hand-drawn diagram, get a clean digital version back. Runs entirely on the laptop and works in airplane mode.

```
photo ──► Gemma 4 E4B (llama-server, vision) ──► TikZ code ──► tikz-service (TeX in WebAssembly) ──► SVG
```

If TeX can't compile Gemma's TikZ, the error is sent back to Gemma for one fix attempt.

## Run it

Needs Node.js. On Windows:

```powershell
# Once, with internet: downloads llama.cpp + Gemma weights (~5.6 GB, gitignored) and installs tikz-service
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

# Every time (offline is fine): starts tikz-service on :3001 and Gemma + the UI on :8080
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

Then open http://127.0.0.1:8080.

- `start.ps1 -GpuLayers 0` forces CPU only.
- Fonts (Nunito Sans, IBM Plex Mono, Computer Modern for the TeX output) and logos are bundled in `web/assets`, so nothing is fetched from the internet.
- The prompts live at the top of `web/app.js` (`SYSTEM_PROMPT`, `IMAGE_PROMPT`).
- See `tikz-service/README.md` for the renderer API.
