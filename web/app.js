// Photo of handwritten notes -> clean digital notes, all running locally:
//   photo --(Gemma OCR, llama-server)--> JSON blocks --(tikz-service, TeX in WebAssembly)--> rendered notes
// Gemma can then quiz you on the notes, with typed answers. Threads live in memory only.

// Served by llama-server itself (port 8080) -> same origin. Opened any other way
// (file://, another dev server, Vercel) -> talk to the local server directly.
const LLAMA_URL = "http://127.0.0.1:8080";
const ON_LLAMA_SERVER = ["127.0.0.1", "localhost"].includes(location.hostname) && location.port === "8080";
const API_BASE = ON_LLAMA_SERVER ? "" : LLAMA_URL;
// Browsers often block public https pages from calling services on this laptop.
const HOSTED_HINT =
  location.protocol === "https:" ? ` This page is hosted online, which browsers can block. Open ${LLAMA_URL} instead.` : "";
const TIKZ_BASE = "http://127.0.0.1:3001";
// TikZ libraries the model may use; passed to tikz-service on every diagram render.
const TIKZ_LIBRARIES = "arrows.meta,positioning,shapes.geometric,calc";
const MATH_PACKAGES = { amsmath: "", amssymb: "" };

const NOTES_PROMPT =
  "You digitise photos of handwritten study notes. Read the page top to bottom and return it as JSON blocks in order, " +
  "keeping the text separate from the diagrams. Block types: " +
  '"heading" (a title or section heading), "paragraph" (running text), ' +
  '"list" (bullet or numbered points: one item per line, without the bullet characters), ' +
  '"math" (a displayed equation, as LaTeX without $ delimiters), ' +
  '"diagram" (a drawing, as one complete \\begin{tikzpicture} ... \\end{tikzpicture}). ' +
  "Transcribe the text exactly as written, fixing only obvious spelling slips. Do not add, summarise or invent content. " +
  "Write maths inside text as $...$. If something is unreadable, write [unreadable]. " +
  "In maths, write proper LaTeX: \\rightarrow for arrows, subscripts for numbers in chemical formulas " +
  "(e.g. \\mathrm{CO_2}), \\times, \\frac and so on. " +
  `For diagrams use standard TikZ plus only these libraries, which are already loaded: ${TIKZ_LIBRARIES}. ` +
  "Draw each labelled shape as a named \\node (e.g. \\node[draw, circle] (sun) {Sun};), place nodes with " +
  "positioning (right=2cm of sun), and connect them with arrows between node names, e.g. \\draw[->] (sun) -- (leaf); " +
  "so lines never cross labels. Use plain black outlines, no fill colours. " +
  "circuitikz is NOT available: draw circuit components from plain shapes (a small rectangle for a resistor, " +
  "two short parallel lines for a battery, filled dots for nodes, straight lines for wires) and label them with nodes. " +
  "Use only ASCII characters: write symbols as LaTeX (\\Omega, ^\\circ, \\mu, \\rightarrow), never as Unicode. " +
  "Never use % comments, \\documentclass, \\usepackage, \\usetikzlibrary, align or equation environments, " +
  "\\ce, \\SI or \\si. " +
  'Set "title" to a short title for the page.';
const NOTES_IMAGE_PROMPT = "Digitise these notes.";
// llama-server constrains Gemma's output to this schema, so the reply is always valid JSON.
const NOTES_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { enum: ["heading", "paragraph", "list", "math", "diagram"] },
          content: { type: "string" },
        },
        required: ["type", "content"],
      },
    },
  },
  required: ["title", "blocks"],
};

const QUIZ_QUESTIONS = 5;
const quizPrompt = (notes) =>
  `You are quizzing a student on their own notes, given below. Ask exactly ${QUIZ_QUESTIONS} questions, one at a time, ` +
  "based only on the notes, mixing recall and understanding. Number each question. After each answer, say whether it is " +
  "correct, partly correct or wrong, explain briefly using the notes, then ask the next question. After the last answer, " +
  `give a score out of ${QUIZ_QUESTIONS} and one study tip, then stop. Be concise. ` +
  "Never use em dashes or en dashes, and never use emojis.\n\nNOTES:\n" + notes;

const FIX_PROMPT =
  "You fix TikZ code so it compiles and draws visibly. Keep the drawing the same. Reply with only the corrected complete " +
  `tikzpicture in a \`\`\`latex code block. Only these libraries are loaded: ${TIKZ_LIBRARIES}. ` +
  "circuitikz is not available, so draw components from plain shapes. Use black lines, only ASCII characters, " +
  "and never % comments.";
const MATH_FIX_PROMPT =
  "You fix a LaTeX maths expression so it compiles inside $\\displaystyle ...$ with only amsmath and amssymb. " +
  "Keep the meaning the same. Use only ASCII (\\rightarrow, ^2, \\Omega, ^\\circ), no align/equation environments " +
  "(use aligned), no \\ce, \\SI or \\si. Reply with only the corrected expression, no $ signs, no explanation.";

const MAX_IMAGE_SIDE = 1024; // downscale uploads; the model resizes anyway and big data URLs are slow
const MAX_FIX_ATTEMPTS = 1; // if TeX rejects a diagram, send the error back to Gemma this many times

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
  const visible = thread.messages.filter((m) => !m.hidden);
  emptyEl.hidden = visible.length > 0;
  for (const m of visible) {
    const el = document.createElement("div");
    el.className = `msg ${m.role}` + (m.kind ? ` msg-${m.kind}` : "") + (m.error ? " error" : "");
    for (const src of m.images || []) {
      const img = document.createElement("img");
      img.src = src;
      el.appendChild(img);
    }
    if (m.role === "user" && m.text) el.append(m.text);
    if (m.role === "assistant") {
      const body = document.createElement("div");
      body.className = "body";
      fillBody(body, m, thread);
      el.appendChild(body);
    }
    messagesEl.appendChild(el);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateComposer();
  placeLogo();
}

// Upload row normally; the answer box while a quiz is running.
function updateComposer() {
  const thread = activeThread();
  const busy = !!thread.busy;
  const quizzing = !!thread.quiz?.active;
  $("uploadRow").hidden = quizzing;
  $("quizRow").hidden = !quizzing;
  dropzone.classList.toggle("busy", busy);
  $("cameraBtn").disabled = busy;
  $("answerInput").disabled = busy;
  $("answerSend").disabled = busy;
  $("dropzoneText").innerHTML = busy
    ? "Digitising your notes…"
    : "<strong>Drop a photo of your notes</strong> or click to browse";
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

// Assistant messages come in two kinds:
//   notes: { stage: "reading" | "typesetting" | "done", chars, notes: { title, blocks }, error }
//   text:  { text, error }   (quiz turns)
function fillBody(body, m, thread) {
  body.innerHTML = "";
  if (m.trace?.length) body.appendChild(traceView(m));
  if (m.kind === "text") {
    const text = document.createElement("div");
    body.appendChild(text);
    body = text;
    if (m.error) body.textContent = m.error;
    else if (!m.text) body.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`;
    else body.innerHTML = formatMarkdown(cleanReply(m.text));
    return;
  }

  if (m.error || m.stage !== "done") {
    const status = document.createElement("div");
    status.className = "stage" + (m.error ? " failed" : "");
    if (m.error) {
      status.textContent = m.error;
    } else {
      status.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`;
      status.append(
        m.stage === "reading"
          ? `Gemma is reading your notes… ${m.chars ? `(${m.chars} characters)` : ""}`
          : "Typesetting maths and diagrams with TeX…",
      );
    }
    body.appendChild(status);
  }
  if (m.notes) body.appendChild(notesCard(m.notes));
  if (m.stage === "done" && m.notes) body.appendChild(notesActions(m, thread));
}

function notesCard(notes) {
  const card = document.createElement("article");
  card.className = "notes";
  const title = document.createElement("h2");
  title.textContent = notes.title;
  card.appendChild(title);
  for (const block of notes.blocks) {
    if (block.type === "heading") {
      const h = document.createElement("h3");
      h.innerHTML = formatInline(block.content);
      card.appendChild(h);
    } else if (block.type === "paragraph") {
      const p = document.createElement("p");
      p.innerHTML = formatInline(block.content);
      card.appendChild(p);
    } else if (block.type === "list") {
      const ul = document.createElement("ul");
      for (const item of listItems(block.content)) {
        const li = document.createElement("li");
        li.innerHTML = formatInline(item);
        ul.appendChild(li);
      }
      card.appendChild(ul);
    } else {
      // math / diagram: TeX-rendered SVG, a placeholder while waiting, or the source if it failed
      const fig = document.createElement("div");
      fig.className = block.type === "math" ? "math-block" : "diagram";
      if (block.svg) {
        fig.innerHTML = block.svg; // sanitised in sanitizeSvg()
      } else if (block.error) {
        fig.classList.add("failed");
        fig.innerHTML = "<p></p><pre></pre>";
        fig.querySelector("p").textContent = block.error;
        fig.querySelector("pre").textContent = block.content;
      } else {
        fig.classList.add("pending");
        fig.textContent = block.type === "math" ? "Typesetting equation…" : "Drawing diagram…";
      }
      card.appendChild(fig);
    }
  }
  return card;
}

function notesActions(m, thread) {
  const row = document.createElement("div");
  row.className = "notes-actions";
  if (!thread.quiz?.active) {
    const offer = document.createElement("span");
    offer.textContent = "Want to test yourself on these notes?";
    const quiz = document.createElement("button");
    quiz.type = "button";
    quiz.className = "primary";
    quiz.textContent = thread.quiz ? "Quiz me again" : "Quiz me";
    quiz.onclick = () => startQuiz(thread, m.notes);
    row.append(offer, quiz);
  }
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy as text";
  copy.onclick = async () => {
    await navigator.clipboard.writeText(notesToText(m.notes));
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy as text"), 1500);
  };
  row.appendChild(copy);
  return row;
}

const listItems = (content) =>
  content
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);

// Plain-text version of the notes: used for "Copy as text" and as the quiz's source material.
function notesToText(notes) {
  const lines = [notes.title, ""];
  for (const b of notes.blocks) {
    if (b.type === "heading") lines.push(`## ${b.content}`);
    else if (b.type === "paragraph") lines.push(b.content);
    else if (b.type === "list") lines.push(...listItems(b.content).map((i) => `- ${i}`));
    else if (b.type === "math") lines.push(`$$ ${b.content} $$`);
    else lines.push(`[Diagram, TikZ source]\n${b.content.slice(0, 1500)}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Escape text and show inline $maths$ in the Computer Modern italic font.
function formatInline(text) {
  return escapeHtml(text)
    .replace(/\$([^$\n]+)\$/g, '<span class="math-inline">$1</span>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

// Backstop for the quiz prompt: no em dashes or emojis, even if the model slips.
function cleanReply(text) {
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/–/g, "-")
    .replace(/ *[\p{Extended_Pictographic}\p{Emoji_Modifier}️‍⃣]+/gu, "");
}

// Just enough markdown for quiz replies: code blocks, inline code, bold, italics, headings.
function formatMarkdown(text) {
  return escapeHtml(text)
    .split(/```[\w-]*\n?/)
    .map((part, i) => {
      if (i % 2) return `<pre><code>${part.replace(/\n$/, "")}</code></pre>`;
      return part
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/^#{1,6} (.*)$/gm, "<strong>$1</strong>")
        .replace(/^(\s*)[*-] /gm, "$1• ");
    })
    .join("");
}

// JSON escapes swallow some LaTeX: "\text" parses as tab + "ext", "\frac" as form feed + "rac",
// "\beta" as backspace + "eta", "\rho" as carriage return + "ho". Put the backslashes back.
// "\n" is only restored in maths/diagrams (e.g. "\node", "\neq"), where a real newline before
// those letters is unlikely.
function repairLatex(s, isCode) {
  let out = s
    .replace(/\t(?=[a-zA-Z])/g, "\\t")
    .replace(/\u0008(?=[a-zA-Z])/g, "\\b")
    .replace(/\f(?=[a-zA-Z])/g, "\\f")
    .replace(/\r(?=[a-zA-Z])/g, "\\r");
  if (isCode) out = out.replace(/\n(?=(?:ode|ewline|abla|eq|ot|u|i)\b|ode[\s[({])/g, "\\n");
  return out;
}

// Clean a TikZ diagram from the model: unwrap code fences, drop % comments (which would
// comment out the rest of a single-line snippet), and keep just the tikzpicture.
function cleanTikz(s) {
  const fenced = s.match(/```[\w-]*\n([\s\S]*?)```/);
  let tikz = (fenced ? fenced[1] : s).replace(/(^|[^\\])%[^\n\\]*/g, "$1");
  const picture = tikz.match(/\\begin\{tikzpicture\}[\s\S]*\\end\{tikzpicture\}/);
  if (picture) tikz = picture[0];
  else tikz = `\\begin{tikzpicture}\n${tikz}\n\\end{tikzpicture}`;
  return texSafe(tikz.trim(), "text");
}

// The WebAssembly TeX only knows ASCII and a few packages, so translate what the model
// commonly writes instead. `mode` is "math" (inside $...$) or "text" (TikZ code / node labels).
const UNICODE_TO_LATEX = {
  "→": "\\rightarrow", "←": "\\leftarrow", "↔": "\\leftrightarrow", "⇒": "\\Rightarrow", "⇐": "\\Leftarrow",
  "⇔": "\\Leftrightarrow", "⇌": "\\rightleftharpoons", "↑": "\\uparrow", "↓": "\\downarrow",
  "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≈": "\\approx", "≡": "\\equiv", "∝": "\\propto", "∼": "\\sim",
  "×": "\\times", "÷": "\\div", "±": "\\pm", "∓": "\\mp", "·": "\\cdot", "•": "\\cdot", "−": "-", "–": "-", "—": "-",
  "∞": "\\infty", "√": "\\sqrt", "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∂": "\\partial", "∇": "\\nabla",
  "∈": "\\in", "∉": "\\notin", "⊂": "\\subset", "∪": "\\cup", "∩": "\\cap", "∀": "\\forall", "∃": "\\exists",
  "°": "^\\circ", "′": "'", "″": "''", "…": "\\ldots", "Ω": "\\Omega", "µ": "\\mu", "℃": "^\\circ C",
  "α": "\\alpha", "β": "\\beta", "γ": "\\gamma", "δ": "\\delta", "ε": "\\epsilon", "ζ": "\\zeta", "η": "\\eta",
  "θ": "\\theta", "ι": "\\iota", "κ": "\\kappa", "λ": "\\lambda", "μ": "\\mu", "ν": "\\nu", "ξ": "\\xi",
  "π": "\\pi", "ρ": "\\rho", "σ": "\\sigma", "τ": "\\tau", "υ": "\\upsilon", "φ": "\\phi", "χ": "\\chi",
  "ψ": "\\psi", "ω": "\\omega", "Γ": "\\Gamma", "Δ": "\\Delta", "∆": "\\Delta", "Θ": "\\Theta", "Λ": "\\Lambda",
  "Ξ": "\\Xi", "Π": "\\Pi", "Σ": "\\Sigma", "Φ": "\\Phi", "Ψ": "\\Psi",
  "½": "\\tfrac{1}{2}", "¼": "\\tfrac{1}{4}", "¾": "\\tfrac{3}{4}",
};
const SUPERSCRIPTS = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-", "ⁿ": "n" };
const SUBSCRIPTS = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9", "₊": "+", "₋": "-" };

function texSafe(s, mode) {
  const inMath = (latex) => (mode === "math" ? latex : `$${latex}$`);
  let out = s
    // runs of super/subscript digits: x²³ -> x^{23}
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿ]+/g, (r) => inMath(`^{${[...r].map((c) => SUPERSCRIPTS[c]).join("")}}`))
    .replace(/[₀₁₂₃₄₅₆₇₈₉₊₋]+/g, (r) => inMath(`_{${[...r].map((c) => SUBSCRIPTS[c]).join("")}}`))
    .replace(/[^\x00-\x7F]/g, (c) => {
      const latex = UNICODE_TO_LATEX[c];
      if (!latex) return c;
      if (latex === "-" || latex === "'" || latex === "''") return latex;
      return inMath(latex + (/[a-zA-Z]$/.test(latex) ? " " : ""));
    })
    // packages the renderer doesn't have
    .replace(/\\ce\{([^{}]*)\}/g, (_, f) => `\\mathrm{${f.replace(/(\d+)/g, "_{$1}")}}`)
    .replace(/\\SI\{([^{}]*)\}\{([^{}]*)\}/g, "$1\\,\\mathrm{$2}")
    .replace(/\\si\{([^{}]*)\}/g, "\\mathrm{$1}")
    .replace(/\\degree\b/g, "^\\circ")
    .replace(/\\celsius\b/g, "^\\circ\\mathrm{C}")
    .replace(/\\ohm\b/g, "\\Omega")
    .replace(/\\label\{[^{}]*\}|\\tag\{[^{}]*\}|\\nonumber/g, "");
  if (mode === "math") {
    // display environments can't sit inside $...$; use the inline-friendly versions
    out = out
      .replace(/\\(begin|end)\{(equation|displaymath)\*?\}/g, "")
      .replace(/\\(begin|end)\{(align|eqnarray|flalign)\*?\}/g, "\\$1{aligned}")
      .replace(/\\(begin|end)\{(gather|multline)\*?\}/g, "\\$1{gathered}");
  }
  // anything still non-ASCII: drop accents (é -> e), otherwise replace with ?
  return out.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x00-\x7F]/g, "?");
}

// Displayed maths -> a tikzpicture with one node, so the same TeX renderer can typeset it.
function mathToTikz(latex) {
  let m = texSafe(latex.trim(), "math").replace(/^\$\$?|\$\$?$/g, "").replace(/^\\\[|\\\]$/g, "").trim();
  if (m.includes("\\\\") && !/\\begin\{/.test(m)) m = `\\begin{gathered}${m}\\end{gathered}`;
  return `\\begin{tikzpicture}\\node {$\\displaystyle ${m}$};\\end{tikzpicture}`;
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
  // A diagram can compile yet draw nothing (e.g. everything in white, or zero size): treat as a failure.
  const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  const blank = (v) => /^(none|white|#fff|#ffffff|transparent)$/i.test(v || "");
  const marks = [...svg.querySelectorAll("path, use, line, rect, circle, ellipse, polygon, polyline, text")].filter((el) => {
    const stroke = el.getAttribute("stroke");
    const fill = el.getAttribute("fill");
    // SVG defaults: no stroke, black fill (groups usually set the colours, so missing attrs count as visible)
    return (stroke && !blank(stroke)) || !fill || !blank(fill);
  });
  if (!marks.length || (vb.length === 4 && (vb[2] < 2 || vb[3] < 2))) {
    throw new CompileError("TeX produced an empty picture (nothing visible was drawn)");
  }
  // Scale up from TeX's point size, but never past what fits.
  const w = parseFloat(svg.getAttribute("width"));
  if (w) svg.setAttribute("style", `max-width: min(100%, ${Math.round(w * 1.6)}px)`);
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
    if (save && title && title !== thread.title) {
      thread.title = title;
      thread.autoTitle = false; // don't overwrite a name the user chose
    }
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

// Streams a chat completion from Gemma, calling onDelta with each chunk of text.
async function streamReply(request, onDelta) {
  const res = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream: true, chat_template_kwargs: { enable_thinking: false }, ...request }),
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

const gemmaError = (err) =>
  err.message.startsWith("Couldn't reach")
    ? err.message
    : `Couldn't reach Gemma. Is the local server running (scripts\\start.ps1)? (${err.message})${HOSTED_HINT}`;

class CompileError extends Error {}

// TikZ -> SVG via tikz-service. Throws CompileError when TeX rejects the code.
async function renderTikz(tikz, extra = {}) {
  let res;
  try {
    res = await fetch(`${TIKZ_BASE}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tikz, ...extra }),
    });
  } catch {
    throw new Error(`Couldn't reach the TeX renderer. Is it running (scripts\\start.ps1)?${HOSTED_HINT}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 422) throw new CompileError(body.error || "TeX failed to compile");
  if (!res.ok) throw new Error(`TeX renderer returned ${res.status}: ${body.error || ""}`);
  return sanitizeSvg(body.svg);
}

// Ask Gemma (text only, no image) to fix a diagram TeX rejected.
async function fixTikz(tikz, error) {
  let raw = "";
  await streamReply(
    {
      messages: [
        { role: "system", content: FIX_PROMPT },
        { role: "user", content: `This TikZ failed to compile:\n\`\`\`latex\n${tikz}\n\`\`\`\nError: ${error}` },
      ],
      temperature: 0.2,
      max_tokens: 2048,
    },
    (d) => (raw += d),
  );
  return cleanTikz(raw);
}

// Same idea for an equation TeX rejected.
async function fixMath(latex, error) {
  let raw = "";
  await streamReply(
    {
      messages: [
        { role: "system", content: MATH_FIX_PROMPT },
        { role: "user", content: `This failed to compile:\n${latex}\nError: ${error}` },
      ],
      temperature: 0.2,
      max_tokens: 512,
    },
    (d) => (raw += d),
  );
  const fenced = raw.match(/```[\w-]*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : raw).trim();
}

// --- Tool-call trace: every model / renderer call is recorded on the message and shown in a
// collapsible "Pipeline" panel, so the demo can show exactly what ran, in what order, and how long it took.

const GEMMA_TOOL = "Gemma 4 E4B · llama-server :8080";
const TEX_TOOL = "TeX (WebAssembly) · tikz-service :3001";

function startStep(msg, step, update) {
  const s = { ...step, status: "running", start: performance.now() };
  msg.trace.push(s);
  update?.();
  return s;
}

function endStep(s, fields = {}, status = "ok") {
  Object.assign(s, fields, { status, ms: performance.now() - s.start });
}

// Mark anything still running as failed (used when the pipeline throws).
function failRunning(msg, error) {
  for (const s of msg.trace || []) if (s.status === "running") endStep(s, { output: error }, "error");
}

// Typeset one maths/diagram block, with a Gemma fix attempt when TeX rejects it.
async function typesetBlock(block, msg, update, label) {
  const isMath = block.type === "math";
  for (let attempt = 0; ; attempt++) {
    const tikz = isMath ? mathToTikz(block.content) : block.content;
    const step = startStep(msg, { label: `Typeset ${label}`, tool: TEX_TOOL, input: tikz }, update);
    try {
      block.svg = await renderTikz(
        tikz,
        isMath ? { texPackages: MATH_PACKAGES } : { tikzLibraries: TIKZ_LIBRARIES, texPackages: MATH_PACKAGES },
      );
      endStep(step, { output: `SVG, ${(block.svg.length / 1024).toFixed(1)} KB` });
      return;
    } catch (err) {
      endStep(step, { output: err.message }, "error");
      if (!(err instanceof CompileError)) {
        block.error = err.message;
        return;
      }
      if (attempt >= MAX_FIX_ATTEMPTS) {
        block.error = isMath ? "Couldn't typeset this equation, showing the LaTeX:" : "Couldn't draw this diagram, showing the TikZ:";
        return;
      }
      const fix = startStep(msg, { label: `Fix ${label} after TeX error`, tool: GEMMA_TOOL, input: err.message }, update);
      try {
        block.content = isMath ? await fixMath(block.content, err.message) : await fixTikz(block.content, err.message);
        endStep(fix, { output: block.content });
      } catch (fixErr) {
        endStep(fix, { output: fixErr.message }, "error");
        block.error = gemmaError(fixErr);
        return;
      }
    }
  }
}

// Load the image files, then: Gemma OCR -> JSON notes -> TeX for maths and diagrams.
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

  if (thread.quiz) thread.quiz.active = false; // new notes end any running quiz
  thread.messages.push({ role: "user", images });
  if (thread.title === "New thread") {
    const name = files[0].name.replace(/\.[^.]+$/, "") || "Notes";
    thread.title = files.length > 1 ? `${name} +${files.length - 1}` : name;
    thread.autoTitle = true;
  }

  const reply = { role: "assistant", kind: "notes", stage: "reading", chars: 0, trace: [] };
  thread.messages.push(reply);
  thread.busy = true;
  render();
  const update = bubbleUpdater(thread, reply);

  try {
    let raw = "";
    const ocr = startStep(
      reply,
      {
        label: "Read the notes (vision OCR → JSON)",
        tool: GEMMA_TOOL,
        input: `${images.length} image${images.length > 1 ? "s" : ""}, output constrained to the notes JSON schema\n\nSystem prompt:\n${NOTES_PROMPT}`,
      },
      update,
    );
    await streamReply(
      {
        messages: [
          { role: "system", content: NOTES_PROMPT },
          {
            role: "user",
            content: [
              ...images.map((url) => ({ type: "image_url", image_url: { url } })),
              { type: "text", text: NOTES_IMAGE_PROMPT },
            ],
          },
        ],
        response_format: { type: "json_schema", json_schema: { name: "notes", schema: NOTES_SCHEMA } },
        temperature: 0.2,
        max_tokens: 4096,
      },
      (delta) => {
        raw += delta;
        reply.chars = raw.length;
        ocr.output = raw;
        update();
      },
    );
    endStep(ocr, { output: raw });

    const parse = startStep(reply, { label: "Parse JSON and split text from maths/diagrams", tool: "Browser", input: `${raw.length} characters of JSON` });
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Gemma's reply was cut off before the notes were complete. Try a clearer or smaller photo.");
    }
    const blocks = (parsed.blocks || [])
      .filter((b) => b && typeof b.content === "string" && b.content.trim())
      .map((b) => {
        const isCode = b.type === "math" || b.type === "diagram";
        const content = repairLatex(b.content, isCode);
        return { type: b.type, content: b.type === "diagram" ? cleanTikz(content) : content };
      });
    const counts = {};
    for (const b of blocks) counts[b.type] = (counts[b.type] || 0) + 1;
    endStep(parse, { output: Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(", ") || "no content found" });

    reply.notes = { title: repairLatex(parsed.title || "Notes", false), blocks };
    if (thread.autoTitle && parsed.title) thread.title = reply.notes.title;
    reply.stage = "typesetting";
    render();

    // tikz-service renders one at a time anyway, so go in order and show each as it lands.
    const toTypeset = blocks.filter((b) => b.type === "math" || b.type === "diagram");
    const seen = { math: 0, diagram: 0 };
    for (const block of toTypeset) {
      const n = ++seen[block.type];
      await typesetBlock(block, reply, update, `${block.type === "math" ? "equation" : "diagram"} ${n}`);
      update();
    }
    reply.stage = "done";
  } catch (err) {
    reply.error = gemmaError(err);
    failRunning(reply, err.message);
  }
  thread.busy = false;
  render();
}

// Re-render just the message being worked on, unless the user switched threads.
function bubbleUpdater(thread, msg) {
  return () => {
    if (state.activeId !== thread.id) return;
    const el = messagesEl.querySelector(".msg:last-of-type .body");
    if (el) fillBody(el, msg, thread);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };
}

// Collapsible list of the tool calls behind a message. Open/closed state is stored on the
// message and steps, because the bubble is rebuilt on every streamed token.
function traceView(m) {
  const total = m.trace.reduce((sum, s) => sum + (s.ms || 0), 0);
  const running = m.trace.find((s) => s.status === "running");
  const failed = m.trace.some((s) => s.status === "error");
  const panel = document.createElement("details");
  panel.className = "trace";
  panel.open = !!m.traceOpen;
  panel.ontoggle = () => (m.traceOpen = panel.open);
  const summary = document.createElement("summary");
  summary.innerHTML = `<span class="trace-title">Pipeline</span>`;
  summary.append(
    ` ${m.trace.length} tool call${m.trace.length === 1 ? "" : "s"}` +
      (running ? ` · running: ${running.label}` : ` · ${(total / 1000).toFixed(1)} s`) +
      (failed && !running ? " · with errors" : ""),
  );
  panel.appendChild(summary);

  const list = document.createElement("ol");
  m.trace.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = `step ${s.status}`;
    const d = document.createElement("details");
    d.open = !!s.open;
    d.ontoggle = () => (s.open = d.open);
    const sum = document.createElement("summary");
    sum.innerHTML = `<span class="step-dot"></span><span class="step-num">${i + 1}</span><span class="step-label"></span><span class="step-tool"></span><span class="step-time"></span>`;
    sum.querySelector(".step-label").textContent = s.label;
    sum.querySelector(".step-tool").textContent = s.tool;
    sum.querySelector(".step-time").textContent =
      s.status === "running" ? "running…" : `${s.ms < 1000 ? Math.round(s.ms) + " ms" : (s.ms / 1000).toFixed(1) + " s"}`;
    d.appendChild(sum);
    for (const [name, value] of [["Input", s.input], ["Output", s.output]]) {
      if (!value) continue;
      const h = document.createElement("div");
      h.className = "step-io";
      h.textContent = name;
      const pre = document.createElement("pre");
      pre.textContent = value.length > 6000 ? value.slice(0, 6000) + "\n…" : value;
      d.append(h, pre);
    }
    li.appendChild(d);
    list.appendChild(li);
  });
  panel.appendChild(list);
  return panel;
}

// --- Quiz: a text conversation grounded in the notes ---

function startQuiz(thread, notes) {
  if (thread.busy) return;
  thread.quiz = { active: true, notesText: notesToText(notes) };
  // Quiz turns are tagged so only they are sent as history; the opener stays hidden.
  thread.messages.push({ role: "user", text: "Start the quiz.", quiz: true, hidden: true });
  quizTurn(thread);
}

function endQuiz(thread) {
  if (thread.quiz) thread.quiz.active = false;
  render();
}

async function sendAnswer() {
  const thread = activeThread();
  const text = $("answerInput").value.trim();
  if (!text || thread.busy || !thread.quiz?.active) return;
  $("answerInput").value = "";
  thread.messages.push({ role: "user", text, quiz: true });
  await quizTurn(thread);
  $("answerInput").focus();
}

async function quizTurn(thread) {
  const history = thread.messages
    .filter((m) => m.quiz && !m.error && m.text)
    .map((m) => ({ role: m.role, content: m.text }));
  const reply = { role: "assistant", kind: "text", text: "", quiz: true, trace: [] };
  thread.messages.push(reply);
  thread.busy = true;
  render();
  const update = bubbleUpdater(thread, reply);
  const lastUser = history[history.length - 1]?.content || "";
  const step = startStep(
    reply,
    {
      label: history.length <= 1 ? "Write the first quiz question" : "Mark the answer and ask the next question",
      tool: GEMMA_TOOL,
      input: `${history.length} quiz message${history.length === 1 ? "" : "s"} + the notes as context\n\nLatest: ${lastUser}`,
    },
    update,
  );
  try {
    await streamReply(
      {
        messages: [{ role: "system", content: quizPrompt(thread.quiz.notesText) }, ...history],
        temperature: 0.5,
        max_tokens: 1024,
      },
      (delta) => {
        reply.text += delta;
        update();
      },
    );
    endStep(step, { output: reply.text });
  } catch (err) {
    reply.error = gemmaError(err);
    failRunning(reply, err.message);
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

// Camera: live preview in a dialog, capture a frame and send it like a dropped file.
// getUserMedia needs a secure context; http://127.0.0.1 counts, so this works offline.
const camera = { stream: null, devices: [], index: 0 };
const cameraDialog = $("cameraDialog");
const cameraVideo = $("cameraVideo");

async function startCamera() {
  stopCamera();
  $("cameraError").hidden = true;
  const device = camera.devices[camera.index];
  try {
    camera.stream = await navigator.mediaDevices.getUserMedia({
      video: device
        ? { deviceId: { exact: device.deviceId }, width: { ideal: 1920 } }
        : { facingMode: { ideal: "environment" }, width: { ideal: 1920 } }, // rear camera on phones
    });
    cameraVideo.srcObject = camera.stream;
    // Labels/IDs are only listed after permission is granted.
    camera.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    $("cameraSwitch").hidden = camera.devices.length < 2;
  } catch (err) {
    const denied = err.name === "NotAllowedError";
    $("cameraError").textContent = denied
      ? "Camera access was blocked. Allow it in the browser's address bar and try again."
      : `Couldn't start the camera: ${err.message}`;
    $("cameraError").hidden = false;
  }
}

function stopCamera() {
  camera.stream?.getTracks().forEach((t) => t.stop());
  camera.stream = null;
  cameraVideo.srcObject = null;
}

$("cameraBtn").onclick = () => {
  if (activeThread().busy) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    alert(`The camera needs the page opened at ${LLAMA_URL} (or another secure address).`);
    return;
  }
  cameraDialog.showModal();
  startCamera();
};
$("cameraSwitch").onclick = () => {
  camera.index = (camera.index + 1) % camera.devices.length;
  startCamera();
};
$("cameraCancel").onclick = () => cameraDialog.close();
cameraDialog.addEventListener("close", stopCamera); // also covers Escape
$("cameraCapture").onclick = () => {
  if (!camera.stream || !cameraVideo.videoWidth) return;
  const canvas = document.createElement("canvas");
  canvas.width = cameraVideo.videoWidth;
  canvas.height = cameraVideo.videoHeight;
  canvas.getContext("2d").drawImage(cameraVideo, 0, 0);
  canvas.toBlob((blob) => {
    cameraDialog.close();
    const time = new Date().toTimeString().slice(0, 5).replace(":", "");
    sendFiles([new File([blob], `camera-${time}.jpg`, { type: "image/jpeg" })]);
  }, "image/jpeg", 0.92);
};

// Ctrl+V a copied image or screenshot.
window.addEventListener("paste", (e) => {
  if (e.target.closest?.("input, textarea")) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) sendFiles(files);
});

// Quiz answers: Enter sends, Shift+Enter for a new line.
$("quizRow").onsubmit = (e) => {
  e.preventDefault();
  sendAnswer();
};
$("answerInput").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendAnswer();
  }
};
$("endQuiz").onclick = () => endQuiz(activeThread());

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
