// Hand-drawn diagram -> clean digital version, all running locally:
//   photo --(Gemma in llama-server)--> TikZ --(tikz-service, TeX in WebAssembly)--> SVG
// Threads live in memory only.

// Served by llama-server itself -> same origin. Opened any other way -> talk to the local server.
const API_BASE = ["127.0.0.1", "localhost"].includes(location.hostname) ? "" : "http://127.0.0.1:8080";
const TIKZ_BASE = "http://127.0.0.1:3001";
// TikZ libraries the model may use; passed to tikz-service on every render.
const TIKZ_LIBRARIES = "arrows.meta,positioning,shapes.geometric,calc";
const SYSTEM_PROMPT =
  "You convert photos of hand-drawn diagrams into clean TikZ code. Reproduce the diagram faithfully: " +
  "the same shapes, nodes, arrows, connections and relative layout, and transcribe every label exactly as written. " +
  "Do not add, remove or invent elements. If a label is unreadable, use a short placeholder like '?'. " +
  "Reply with only one complete \\begin{tikzpicture} ... \\end{tikzpicture} block in a ```latex code block, " +
  "with no explanation. Use standard TikZ plus only these libraries, which are already loaded: " +
  `${TIKZ_LIBRARIES}. Do not write \\documentclass, \\usepackage or \\usetikzlibrary. ` +
  "Keep labels as plain text or simple $math$.";
// Input is images only, so this is the instruction sent alongside every image.
const IMAGE_PROMPT = "Convert this hand-drawn diagram to TikZ.";
const MAX_IMAGE_SIDE = 1024; // downscale uploads; the model resizes anyway and big data URLs are slow
const MAX_FIX_ATTEMPTS = 1; // if TeX rejects the code, send the error back to Gemma this many times

const state = { threads: [], activeId: null };

const $ = (id) => document.getElementById(id);
const threadsEl = $("threads");
const messagesEl = $("messages");
const emptyEl = $("empty");
const fileInput = $("fileInput");
const dropzone = $("dropzone");

function newThread() {
  const thread = { id: crypto.randomUUID(), title: "New thread", messages: [] };
  state.threads.unshift(thread);
  state.activeId = thread.id;
  render();
}

function activeThread() {
  return state.threads.find((t) => t.id === state.activeId);
}

function render() {
  threadsEl.innerHTML = "";
  for (const t of state.threads) {
    const item = document.createElement("div");
    item.className = "thread" + (t.id === state.activeId ? " active" : "");
    item.innerHTML = `<span class="thread-title"></span><button class="rename" type="button" aria-label="Rename thread" title="Rename">${PENCIL}</button>`;
    item.querySelector(".thread-title").textContent = t.title;
    item.onclick = () => {
      state.activeId = t.id;
      $("sidebar").classList.remove("open");
      render();
    };
    item.ondblclick = () => startRename(t, item.querySelector(".thread-title"));
    item.querySelector(".rename").onclick = (e) => {
      e.stopPropagation();
      startRename(t, item.querySelector(".thread-title"));
    };
    threadsEl.appendChild(item);
  }

  const thread = activeThread();
  $("threadTitle").textContent = thread.title;
  messagesEl.querySelectorAll(".msg").forEach((el) => el.remove());
  emptyEl.hidden = thread.messages.length > 0;
  for (const m of thread.messages) {
    const el = document.createElement("div");
    el.className = `msg ${m.role}` + (m.error ? " error" : "");
    for (const src of m.images || []) {
      const img = document.createElement("img");
      img.src = src;
      el.appendChild(img);
    }
    if (m.role === "assistant") {
      const body = document.createElement("div");
      body.className = "body";
      fillBody(body, m);
      el.appendChild(body);
    }
    messagesEl.appendChild(el);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateDropzone();
  placeLogo();
}

function updateDropzone() {
  const busy = activeThread().busy;
  dropzone.classList.toggle("busy", !!busy);
  $("dropzoneText").innerHTML = busy
    ? "Digitising your diagram…"
    : "<strong>Drop a hand-drawn diagram</strong> or click to browse";
}

// Centre the MLH logo over the empty-state slot, or dock it small in the header's
// top-right corner. CSS transitions on left/top/width animate the move.
const LOGO_RATIO = 130.78 / 310.59;
const DOCKED_WIDTH = 56;
function placeLogo() {
  const chat = $("chat");
  const logo = $("mlhLogo");
  const chatRect = chat.getBoundingClientRect();
  const docked = emptyEl.hidden;
  chat.classList.toggle("docked", docked);

  let left, top, width;
  if (docked) {
    const header = chat.querySelector(".chat-header");
    width = DOCKED_WIDTH;
    left = chatRect.width - width - (window.innerWidth <= 760 ? 16 : 24);
    top = (header.offsetHeight - width * LOGO_RATIO) / 2;
  } else {
    const slot = $("logoSlot").getBoundingClientRect();
    width = slot.width;
    left = slot.left - chatRect.left;
    top = slot.top - chatRect.top;
  }
  Object.assign(logo.style, { left: `${left}px`, top: `${top}px`, width: `${width}px` });
}

// Assistant message: { stage: "writing" | "rendering" | "done", tikz, svg, error }
const STAGE_LABELS = {
  writing: "Gemma is writing TikZ…",
  fixing: "TeX found an error, Gemma is fixing it…",
  rendering: "Rendering with TeX…",
};
function fillBody(body, m) {
  body.innerHTML = "";
  if (m.svg) {
    const figure = document.createElement("div");
    figure.className = "diagram";
    figure.innerHTML = m.svg; // sanitised in sanitizeSvg()
    body.appendChild(figure);
    body.appendChild(diagramActions(m));
    return;
  }
  const status = document.createElement("div");
  status.className = "stage";
  if (m.error) {
    status.classList.add("failed");
    status.textContent = m.error;
  } else {
    status.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`;
    status.append(STAGE_LABELS[m.stage] || "");
  }
  body.appendChild(status);
  if (m.tikz) {
    const pre = document.createElement("pre");
    pre.className = "tikz-live";
    pre.textContent = m.tikz;
    body.appendChild(pre);
  }
}

function diagramActions(m) {
  const row = document.createElement("div");
  row.className = "diagram-actions";
  const button = (label, onclick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = onclick;
    row.appendChild(b);
    return b;
  };
  button("Download SVG", () => {
    const url = URL.createObjectURL(new Blob([m.svg], { type: "image/svg+xml" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "diagram.svg" });
    a.click();
    URL.revokeObjectURL(url);
  });
  const copy = button("Copy TikZ", async () => {
    await navigator.clipboard.writeText(m.tikz);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy TikZ"), 1500);
  });
  const details = document.createElement("details");
  details.innerHTML = "<summary>TikZ source</summary>";
  const pre = document.createElement("pre");
  pre.textContent = m.tikz;
  details.appendChild(pre);
  row.appendChild(details);
  return row;
}

// Pull the tikzpicture out of the model's reply (it usually wraps it in a code fence).
function extractTikz(reply) {
  const picture = reply.match(/\begin\{tikzpicture\}[\s\S]*?\end\{tikzpicture\}/);
  if (picture) return picture[0];
  const fenced = reply.match(/```[\w-]*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : reply).trim();
}

// The SVG comes from model-written TeX, so strip anything executable before inlining it.
// It has to be inlined (not an <img>) so the page's Computer Modern fonts apply to its text.
function sanitizeSvg(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.nodeName !== "svg") throw new Error("Renderer did not return an SVG");
  svg.querySelectorAll("script, foreignObject").forEach((n) => n.remove());
  for (const el of [svg, ...svg.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      const isHandler = attr.name.toLowerCase().startsWith("on");
      const isJsLink = /href$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value);
      if (isHandler || isJsLink) el.removeAttribute(attr.name);
    }
  }
  // Let CSS size it from the viewBox.
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  return new XMLSerializer().serializeToString(svg);
}

const PENCIL = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;

// Swap a title element for an input. Enter/blur saves, Escape cancels.
function startRename(thread, titleEl) {
  const field = document.createElement("input");
  field.className = "rename-input";
  field.value = thread.title;
  field.maxLength = 80;
  titleEl.hidden = true;
  titleEl.after(field);
  field.focus();
  field.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const title = field.value.trim();
    if (save && title) thread.title = title;
    field.remove();
    titleEl.hidden = false;
    render();
  };
  field.onclick = (e) => e.stopPropagation();
  field.ondblclick = (e) => e.stopPropagation();
  field.onkeydown = (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  field.onblur = () => finish(true);
}

// Each drop is handled on its own: only the latest images are sent, not the whole
// thread, since re-encoding earlier images would make every reply slower.
// `fix` (optional) carries a failed attempt and TeX's error so Gemma can correct it.
function toApiMessages(images, fix) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        { type: "text", text: IMAGE_PROMPT },
      ],
    },
  ];
  if (fix) {
    messages.push(
      { role: "assistant", content: "```latex\n" + fix.tikz + "\n```" },
      {
        role: "user",
        content: `That failed to compile:\n${fix.error}\nReply with the corrected complete tikzpicture only.`,
      },
    );
  }
  return messages;
}

// Streams Gemma's reply, calling onDelta with each chunk of text.
async function streamReply(messages, onDelta) {
  const res = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      stream: true,
      temperature: 0.2, // code output: keep it predictable
      max_tokens: 3072,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok) throw new Error(`Model server returned ${res.status}: ${await res.text()}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) onDelta(delta);
    }
  }
}

class CompileError extends Error {}

// TikZ -> SVG via tikz-service. Throws CompileError when TeX rejects the code.
async function renderTikz(tikz) {
  let res;
  try {
    res = await fetch(`${TIKZ_BASE}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tikz, tikzLibraries: TIKZ_LIBRARIES }),
    });
  } catch {
    throw new Error("Couldn't reach the TikZ renderer. Is it running (scripts\start.ps1)?");
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 422) throw new CompileError(body.error || "TikZ failed to compile");
  if (!res.ok) throw new Error(`TikZ renderer returned ${res.status}: ${body.error || ""}`);
  return sanitizeSvg(body.svg);
}

// Load the image files, then run them through Gemma -> TikZ -> SVG.
async function sendFiles(fileList) {
  const thread = activeThread();
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (!files.length || thread.busy) return;

  const images = [];
  for (const file of files) {
    try {
      images.push(await loadImage(file));
    } catch {
      alert(`Couldn't read ${file.name} as an image.`);
    }
  }
  if (!images.length) return;

  thread.messages.push({ role: "user", images });
  if (thread.title === "New thread") {
    const name = files[0].name.replace(/\.[^.]+$/, "") || "Diagram";
    thread.title = files.length > 1 ? `${name} +${files.length - 1}` : name;
  }

  const reply = { role: "assistant", stage: "writing", tikz: "" };
  thread.messages.push(reply);
  thread.busy = true;
  render();

  // Update only the reply bubble while working, unless the user switched threads.
  const updateBubble = () => {
    if (state.activeId !== thread.id) return;
    const body = messagesEl.querySelector(".msg:last-of-type .body");
    if (body) fillBody(body, reply);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  let fix = null;
  try {
    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      reply.stage = fix ? "fixing" : "writing";
      let raw = "";
      reply.tikz = "";
      updateBubble();
      await streamReply(toApiMessages(images, fix), (delta) => {
        raw += delta;
        reply.tikz = raw;
        updateBubble();
      });
      reply.tikz = extractTikz(raw);
      reply.stage = "rendering";
      updateBubble();
      try {
        reply.svg = await renderTikz(reply.tikz);
        break;
      } catch (err) {
        if (!(err instanceof CompileError) || attempt === MAX_FIX_ATTEMPTS) throw err;
        fix = { tikz: reply.tikz, error: err.message };
      }
    }
  } catch (err) {
    reply.error =
      err instanceof CompileError
        ? `TeX couldn't compile Gemma's TikZ: ${err.message}`
        : err.message.startsWith("Couldn't reach")
          ? err.message
          : `Couldn't reach Gemma. Is the local server running (scripts\start.ps1)? ${err.message}`;
  }
  thread.busy = false;
  render();
}

// Downscale an image file to a JPEG data URL no larger than MAX_IMAGE_SIDE.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

fileInput.onchange = () => {
  const files = [...fileInput.files];
  fileInput.value = "";
  sendFiles(files);
};

// Drag and drop anywhere in the chat area. The counter handles dragenter/leave
// firing for every child element the cursor crosses.
const chatEl = $("chat");
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
chatEl.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  chatEl.classList.add("dragging");
});
chatEl.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = activeThread().busy ? "none" : "copy";
});
chatEl.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    chatEl.classList.remove("dragging");
  }
});
chatEl.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  chatEl.classList.remove("dragging");
  sendFiles(e.dataTransfer.files);
});
// Stop a drop outside the chat area from navigating the browser to the image.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// Ctrl+V a copied image or screenshot.
window.addEventListener("paste", (e) => {
  if (e.target.closest?.("input")) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) sendFiles(files);
});

$("newThread").onclick = newThread;
$("menuBtn").onclick = () => $("sidebar").classList.toggle("open");
$("threadTitle").ondblclick = () => startRename(activeThread(), $("threadTitle"));

newThread();
// Enable the animation only after the first placement, so the logo doesn't fly in on load.
requestAnimationFrame(() => $("mlhLogo").classList.add("animate"));
// Re-place without animating when the layout shifts (e.g. window resize).
new ResizeObserver(() => {
  const logo = $("mlhLogo");
  logo.classList.remove("animate");
  placeLogo();
  requestAnimationFrame(() => logo.classList.add("animate"));
}).observe(messagesEl);
