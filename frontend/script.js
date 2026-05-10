/**
 * Homework Solver UI — talks to a FastAPI (or compatible) backend.
 * Default: POST {apiBase}/solve  JSON body { problem, subject }
 * Optional: GET {apiBase}/health
 * Streaming: GET/POST with Accept: text/event-stream if your API implements SSE.
 *
 * Rich rendering: Markdown (marked UMD) + LaTeX (KaTeX auto-render) + code (highlight.js).
 * Loads after marked/dompurify scripts in index.html (defer order).
 */

(() => {
  const m = globalThis.marked;
  if (m && typeof m.use === "function") {
    m.use({ breaks: true });
  }
})();

const STORAGE_KEY = "homework_solver_api_base";

const DEFAULT_API_BASE = "";

function normalizeBase(url) {
  const trimmed = (url || "").trim().replace(/\/+$/, "");
  return trimmed;
}

function loadSavedBase() {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveBase(url) {
  try {
    sessionStorage.setItem(STORAGE_KEY, normalizeBase(url));
  } catch {
    /* ignore */
  }
}

const els = {
  apiBase: document.getElementById("apiBase"),
  btnHealth: document.getElementById("btnHealth"),
  form: document.getElementById("solveForm"),
  subject: document.getElementById("subject"),
  problem: document.getElementById("problem"),
  streamMode: document.getElementById("streamMode"),
  statusLine: document.getElementById("statusLine"),
  result: document.getElementById("result"),
  btnSubmit: document.getElementById("btnSubmit"),
  btnCopy: document.getElementById("btnCopy"),
};

els.apiBase.value = loadSavedBase() || DEFAULT_API_BASE;

els.apiBase.addEventListener("change", () => {
  saveBase(els.apiBase.value);
});

function setStatus(message, isError = false) {
  els.statusLine.textContent = message || "";
  els.statusLine.classList.toggle("error", Boolean(isError && message));
}

function setLoading(loading) {
  els.btnSubmit.disabled = loading;
  const spinner = els.btnSubmit.querySelector(".btn-spinner");
  const label = els.btnSubmit.querySelector(".btn-label");
  if (spinner) spinner.hidden = !loading;
  if (label) label.hidden = loading;
}

/**
 * @param {string} text
 * @param {{ plain?: boolean }} [opts]
 */
function renderResult(text, opts = {}) {
  const plain = opts.plain === true;
  const str = typeof text === "string" ? text : "";
  els.result.innerHTML = "";

  if (!str.trim()) {
    els.result.classList.remove("result-rich");
    els.result.innerHTML =
      '<p class="result-placeholder">Submit a problem to see steps and the final answer here.</p>';
    els.btnCopy.disabled = true;
    return;
  }

  els.result.classList.toggle("result-rich", !plain);

  if (plain) {
    const pre = document.createElement("pre");
    pre.className = "result-plain mono";
    pre.textContent = str;
    els.result.appendChild(pre);
    els.btnCopy.disabled = false;
    return;
  }

  try {
    renderRichMarkdownInto(els.result, str);
  } catch {
    const pre = document.createElement("pre");
    pre.className = "result-plain mono";
    pre.textContent = str;
    els.result.appendChild(pre);
    els.result.classList.remove("result-rich");
  }
  els.btnCopy.disabled = false;
}

/** Plain text only (e.g. streaming chunks before final Markdown pass). */
function renderPlainStreaming(text) {
  const str = typeof text === "string" ? text : "";
  els.result.innerHTML = "";
  els.result.classList.remove("result-rich");
  if (!str.trim()) {
    els.result.innerHTML =
      '<p class="result-placeholder">Submit a problem to see steps and the final answer here.</p>';
    els.btnCopy.disabled = true;
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "result-plain mono";
  pre.textContent = str;
  els.result.appendChild(pre);
  els.btnCopy.disabled = false;
}

/**
 * @param {HTMLElement} container
 * @param {string} markdown
 */
function renderRichMarkdownInto(container, markdown) {
  const wrap = document.createElement("div");
  wrap.className = "result-content";

  const m = globalThis.marked;
  if (m && typeof m.parse === "function") {
    const rawHtml = m.parse(markdown, { async: false });
    const purify = globalThis.DOMPurify;
    wrap.innerHTML = purify
      ? purify.sanitize(rawHtml, { USE_PROFILES: { html: true } })
      : rawHtml;
  } else {
    const pre = document.createElement("pre");
    pre.className = "result-plain mono";
    pre.textContent = markdown;
    wrap.appendChild(pre);
  }

  container.appendChild(wrap);

  if (globalThis.hljs) {
    wrap.querySelectorAll("pre code").forEach((block) => {
      try {
        globalThis.hljs.highlightElement(block);
      } catch {
        /* unknown language or empty block */
      }
    });
  }

  if (typeof globalThis.renderMathInElement === "function") {
    globalThis.renderMathInElement(wrap, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      throwOnError: false,
      strict: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "svg"],
    });
  }
}

/** @returns {string} */
function getApiBase() {
  const raw = normalizeBase(els.apiBase.value);
  if (raw) return raw;
  return "";
}

/**
 * Build solve URL — supports mounting under a path if user sets e.g. http://localhost:8000/api
 * @param {string} base
 */
function solveUrl(base) {
  return `${base}/solve`;
}

function healthUrl(base) {
  return `${base}/health`;
}

els.btnHealth.addEventListener("click", async () => {
  const base = getApiBase();
  if (!base) {
    setStatus("Set API base URL first (e.g. http://127.0.0.1:8000)", true);
    return;
  }
  setStatus("Checking…");
  try {
    const res = await fetch(healthUrl(base), { method: "GET" });
    const text = await res.text();
    if (!res.ok) {
      setStatus(`Health failed: ${res.status} ${text.slice(0, 120)}`, true);
      return;
    }
    setStatus(`OK (${res.status}) — ${text.slice(0, 200)}`);
  } catch (e) {
    setStatus(`Network error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
});

els.btnCopy.addEventListener("click", async () => {
  const plainPre = els.result.querySelector("pre.result-plain");
  const rich = els.result.querySelector(".result-content");
  const text = plainPre ? plainPre.textContent : rich ? rich.innerText : els.result.textContent;
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied to clipboard.");
  } catch {
    setStatus("Could not copy — select text manually.", true);
  }
});

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const problem = els.problem.value.trim();
  if (!problem) {
    setStatus("Enter a problem first.", true);
    return;
  }

  const base = getApiBase();
  if (!base) {
    setStatus("Set API base URL (e.g. http://127.0.0.1:8000).", true);
    return;
  }

  const subject = els.subject.value;
  const url = solveUrl(base);
  const payload = { problem, subject };

  setLoading(true);
  setStatus("Solving…");

  if (els.streamMode.checked) {
    try {
      await streamSolve(url, payload);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
      renderResult("");
    } finally {
      setLoading(false);
    }
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const contentType = res.headers.get("content-type") || "";
    let bodyText = await res.text();

    if (!res.ok) {
      setStatus(`Error ${res.status}: ${bodyText.slice(0, 200)}`, true);
      renderResult(bodyText || res.statusText, { plain: true });
      setLoading(false);
      return;
    }

    if (contentType.includes("application/json")) {
      try {
        const data = JSON.parse(bodyText);
        const formatted = formatJsonResponse(data);
        renderResult(formatted);
        setStatus("Done.");
      } catch {
        renderResult(bodyText, { plain: true });
        setStatus("Done (raw).");
      }
    } else {
      renderResult(bodyText, { plain: true });
      setStatus("Done.");
    }
  } catch (err) {
    setStatus(`Network error: ${err instanceof Error ? err.message : String(err)}`, true);
    renderResult("");
  } finally {
    setLoading(false);
  }
});

/**
 * @param {Record<string, unknown>} data
 */
function formatJsonResponse(data) {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    if ("solution" in data && typeof data.solution === "string") {
      return data.solution;
    }
    if ("answer" in data && typeof data.answer === "string") {
      return data.answer;
    }
    if ("result" in data && typeof data.result === "string") {
      return data.result;
    }
    if ("content" in data && typeof data.content === "string") {
      return data.content;
    }
  }
  return JSON.stringify(data, null, 2);
}

/**
 * Attempt SSE-style stream: expects newline-delimited data or `data: ...` lines.
 * Adjust parseStreamLine() if your FastAPI endpoint uses a different format.
 * @param {string} url
 * @param {object} payload
 */
async function streamSolve(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status}: ${t.slice(0, 200)}`);
  }

  if (!res.body) {
    const t = await res.text();
    renderResult(t);
    setStatus("Done.");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";

  renderPlainStreaming("");

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const piece = parseStreamLine(line);
      if (piece) {
        out += piece;
        renderPlainStreaming(out);
      }
    }
  }

  if (buffer.trim()) {
    const piece = parseStreamLine(buffer);
    if (piece) {
      out += piece;
      renderPlainStreaming(out);
    }
  }

  renderResult(out);
  setStatus("Done (stream).");
}

/**
 * @param {string} line
 */
function parseStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("data:")) {
    return trimmed.slice(5).trimStart() + "\n";
  }
  return trimmed + "\n";
}
