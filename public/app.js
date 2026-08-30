/* amivisible frontend — binds to /api/check, /api/fixkit */

const $ = (id) => document.getElementById(id);

const TIER_NAMES = {
  citation: "citation path — gets you cited in AI answers",
  index: "search index",
  secondary: "secondary assistant",
};

// mirrors the server's probe sequence (src/report.ts) — one rotating line while the real probes run
const PROBE_LINES = [
  "GET / as a normal browser — control copy",
  "GET /robots.txt — parsing crawler groups",
  "GET /llms.txt · /llms-full.txt",
  "GET / with Accept: text/markdown — negotiation probe",
  "probing as OAI-SearchBot · ChatGPT-User · GPTBot",
  "probing as Claude-SearchBot · Claude-User · ClaudeBot",
  "probing as PerplexityBot · Perplexity-User · Googlebot · bingbot",
  "probing as DuckAssistBot · YouBot · MistralAI-User",
  "probing as CCBot · Bytespider · meta-externalagent · Amazonbot",
  "checking sitemaps",
  "comparing robots.txt verdicts against edge behavior",
];

// probed crawlers, in server order — the same stamps that later carry the verdicts
const PROBE_CELLS = [
  "OAI-SearchBot", "ChatGPT-User", "GPTBot", "Claude-SearchBot", "Claude-User", "ClaudeBot",
  "PerplexityBot", "Perplexity-User", "Googlebot", "bingbot", "DuckAssistBot", "YouBot",
  "MistralAI-User", "CCBot", "Bytespider", "meta-externalagent", "Amazonbot",
];

let currentUrl = null;
let probeTimer = null;
let cellTimer = null;
let scanInFlight = false;

function normalizeUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { return new URL(s).href; } catch { return null; }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* the grid IS the probe display: pending stamps light up while probes run,
   then settle into their verdicts in place — nothing else is left behind */
function startStage() {
  const stage = $("stage");
  stage.innerHTML = "";
  const field = el("div", "stamps");
  const cells = PROBE_CELLS.map((name) => {
    const s = el("span", "stamp pending", name);
    field.appendChild(s);
    return s;
  });
  stage.appendChild(field);

  const line = $("scanline");
  line.hidden = false;
  line.textContent = PROBE_LINES[0];
  let li = 0;
  probeTimer = setInterval(() => {
    if (li >= PROBE_LINES.length - 1) return; // hold the last line until the response lands
    li += 1;
    line.textContent = PROBE_LINES[li];
  }, 1100);
  let ci = 0;
  cellTimer = setInterval(() => {
    if (ci >= cells.length - 1) return; // last stamp settles when the response lands
    cells[ci].classList.add("scan");
    ci += 1;
  }, 620);
}

function stopStage() {
  clearInterval(probeTimer);
  clearInterval(cellTimer);
  $("scanline").hidden = true;
}

async function runScan(url, fresh = false) {
  if (scanInFlight) return;
  scanInFlight = true;
  currentUrl = url;
  $("scan-btn").setAttribute("aria-disabled", "true");
  $("verdict").hidden = true;
  $("report").hidden = true;
  $("check-error").hidden = true;
  $("fixkit").hidden = true;
  $("fixkit").innerHTML = "";
  $("stage").innerHTML = "";

  // don't flash the probe UI on cache-fast responses; once shown, hold it briefly
  let probing = false;
  let shownAt = 0;
  const showTimer = setTimeout(() => {
    $("results").hidden = false;
    startStage();
    probing = true;
    shownAt = performance.now();
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }, 120);

  try {
    const q = `url=${encodeURIComponent(url)}${fresh ? "&fresh=1" : ""}`;
    const res = await fetch(`/api/check?${q}`);
    const data = await res.json();
    clearTimeout(showTimer);
    if (probing) {
      const held = performance.now() - shownAt;
      if (held < 900) await new Promise((r) => setTimeout(r, 900 - held));
      stopStage();
    } else {
      $("results").hidden = false;
      $("results").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (!res.ok || data.error) {
      $("stage").innerHTML = "";
      showError(data.detail || data.error || `check failed (${res.status})`);
    } else {
      render(data);
    }
  } catch (err) {
    clearTimeout(showTimer);
    if (probing) stopStage();
    $("results").hidden = false;
    $("stage").innerHTML = "";
    showError(`network error — ${err.message}`);
  } finally {
    scanInFlight = false;
    $("scan-btn").removeAttribute("aria-disabled");
  }
}

function showError(msg) {
  const box = $("check-error");
  box.textContent = msg;
  box.hidden = false;
}

/* one stamp grid, verdict states baked in — click a stamp for its story */
function renderStage(data) {
  const stage = $("stage");
  stage.innerHTML = "";
  const field = el("div", "stamps");
  const detail = el("div", "stamp-detail");
  detail.hidden = true;
  let active = null;

  // problems first, then readable, then the policy/training paperwork
  const rank = (c) => {
    const policy = !c.robots && !c.edge;
    if (!c.canRead && !c.trainingOnly && !policy) return 0;
    if (c.canRead) return 1;
    return 2;
  };
  const crawlers = [...data.crawlers].sort((a, b) => rank(a) - rank(b));

  for (const c of crawlers) {
    const policy = !c.robots && !c.edge;
    const cls = c.canRead ? "ok" : policy ? "neutral" : c.trainingOnly ? "train" : "no";
    const mark = c.canRead ? "✓ " : policy ? "· " : "✗ ";
    const s = el("button", `stamp ${cls}`, mark + c.name);
    s.type = "button";
    s.setAttribute("aria-expanded", "false");
    s.addEventListener("click", () => {
      if (active === s) {
        detail.hidden = true;
        s.classList.remove("open");
        s.setAttribute("aria-expanded", "false");
        active = null;
        return;
      }
      if (active) { active.classList.remove("open"); active.setAttribute("aria-expanded", "false"); }
      active = s;
      s.classList.add("open");
      s.setAttribute("aria-expanded", "true");
      detail.innerHTML = "";
      const kind = c.trainingOnly ? "training-only" : (TIER_NAMES[c.tier] || c.tier);
      detail.appendChild(el("div", "sd-head", `${c.name} · ${c.operator} · ${kind}`));
      if (c.purpose) detail.appendChild(el("p", "sd-purpose", c.purpose));
      const rows = el("div", "sd-rows");
      const row = (k, v, good) => {
        const r = el("div", "sd-row");
        r.appendChild(el("span", "sd-k", k));
        r.appendChild(el("span", "sd-v" + (good === true ? " good" : good === false ? " bad" : ""), v));
        rows.appendChild(r);
      };
      if (policy) {
        row("probe", "policy token — sends no requests of its own; it only acts through robots.txt rules", null);
      } else {
        const rv = c.robots?.verdict || "unknown";
        row(
          "robots.txt",
          rv === "block"
            ? "blocked" + (c.robots?.matchedAgent ? ` (rule: ${c.robots.matchedAgent})` : "")
            : rv.replace(/-/g, " "),
          rv !== "block"
        );
        if (c.edge != null) row("edge, as this crawler", c.edge === "pass" ? "server sent the page" : String(c.edge), c.edge === "pass");
      }
      row("verdict", c.canRead ? "can read this page" : c.blockedBy || "cannot read this page", c.canRead ? true : c.trainingOnly ? null : false);
      detail.appendChild(rows);
      if (!c.canRead && c.trainingOnly)
        detail.appendChild(el("p", "sd-note", "Training-only crawler — blocking it does not cost you visibility in AI answers."));
      detail.hidden = false;
    });
    field.appendChild(s);
  }
  stage.appendChild(field);
  stage.appendChild(detail);
}

/* a finding = one collapsed row; the human story reveals on click */
function findingRow(f) {
  const d = el("details", `frow sev-${f.severity}`);
  const s = el("summary", "frow-sum");
  if (f.severity === "good") s.appendChild(el("span", "frow-check", "✓"));
  else s.appendChild(el("span", `badge sev-${f.severity}`, f.severity));
  if (f.evidence) s.appendChild(el("span", "badge tier", f.evidence));
  s.appendChild(el("span", "frow-title", f.title));
  d.appendChild(s);
  const body = el("div", "frow-body");
  body.appendChild(el("p", "finding-detail", f.detail));
  if (f.fix) {
    const fx = el("p", "frow-fix");
    fx.appendChild(el("b", null, "the fix: "));
    fx.append(f.fix);
    body.appendChild(fx);
  }
  d.appendChild(body);
  return d;
}

/* the fixes as one copy-paste prompt for the dev's own agent — facts baked in,
   guardrails on, and a verifiable goal so the agent can close its own loop */
function buildFixPrompt(data, url) {
  const clean = (data.finalUrl || url).replace(/\/$/, "");
  const enc = encodeURIComponent(clean);
  const probed = data.crawlers.length;
  const cant = data.crawlers.filter((c) => !c.trainingOnly && !c.canRead).map((c) => c.name);
  const good = data.findings.filter((f) => f.severity === "good").map((f) => f.title);
  const steps = data.findings
    .filter((f) => f.severity !== "good" && f.fix)
    .map((f) => `${f.title} — ${f.fix}`);
  steps.push(`GET https://amivisible.dev/api/fixkit?url=${enc} — it returns a ready-made robots.txt and an llms.txt draft. Apply what fits this repo.`);

  const allClear = data.headline.visible === data.headline.total;
  const lines = [];
  lines.push(`Fix the AI visibility of ${clean}.`);
  lines.push("");
  lines.push(`amivisible.dev checked it against ${probed} AI crawler identities — real HTTP probes, no guesses. Score: ${data.headline.visible}/${data.headline.total} citation-path crawlers can read it.`);
  if (cant.length) lines.push(`Can't read it: ${cant.join(", ")}.`);
  if (good.length) lines.push(`Already working — don't touch: ${good.join("; ")}.`);
  lines.push("");
  lines.push("Do this:");
  steps.forEach((st, i) => lines.push(`${i + 1}. ${st}`));
  lines.push("");
  lines.push("Rules:");
  lines.push("- Keep any deliberate training-bot blocks (GPTBot, ClaudeBot, CCBot…) — they don't cost AI-answer visibility. Only fix the citation path.");
  lines.push("- Show me the full diff before committing anything.");
  lines.push("");
  lines.push(
    allClear
      ? `Verify when done: GET https://amivisible.dev/api/check?url=${enc}&fresh=1 — the score should stay ${data.headline.total}/${data.headline.total}.`
      : `Verify when done: GET https://amivisible.dev/api/check?url=${enc}&fresh=1 — expect ${data.headline.total}/${data.headline.total}.`
  );
  return lines.join("\n");
}

function render(data) {
  // verdict
  $("v-visible").textContent = data.headline.visible;
  $("v-total").textContent = data.headline.total;
  $("v-text").textContent = data.headline.text;
  $("v-url").textContent = data.finalUrl || data.url;
  const verdict = $("verdict");
  verdict.classList.toggle("all-clear", data.headline.visible === data.headline.total);
  verdict.hidden = false;

  renderStage(data);

  // working for you — the good findings, one ✓ row each
  const goodFindings = data.findings.filter((f) => f.severity === "good");
  const working = $("working");
  working.innerHTML = "";
  for (const f of goodFindings) working.appendChild(findingRow(f));
  $("working-block").hidden = goodFindings.length === 0;

  // how to improve — the fix prompt + one row per remaining finding
  const improvables = data.findings.filter((f) => f.severity !== "good");
  const improve = $("improve");
  improve.innerHTML = "";
  for (const f of improvables) improve.appendChild(findingRow(f));

  const hasWork = improvables.some((f) => f.fix) || data.headline.visible < data.headline.total;
  $("fix-prompt-box").hidden = !hasWork;
  $("improve-lead").hidden = !hasWork;
  $("improve-clear").hidden = hasWork;
  if (hasWork) $("fix-prompt").textContent = buildFixPrompt(data, currentUrl);
  $("improve-block").hidden = !hasWork && improvables.length === 0;

  // signals
  const sig = $("signals");
  sig.innerHTML = "";
  const ex = data.extras || {};
  const html = data.html || {};
  const add = (label, val) => {
    const s = el("span", "signal");
    s.append(label + " ");
    s.appendChild(el("b", null, val));
    sig.appendChild(s);
  };
  if (data.platform?.platform) add("platform", data.platform.platform);
  add("robots.txt", ex.robotsTxtFound ? "found" : "none");
  add("sitemap", (ex.sitemaps?.length || 0) > 0 ? `${ex.sitemaps.length} found` : "none");
  add("llms.txt", ex.llmsTxt?.present ? "present" : "—");
  add("llms-full.txt", ex.llmsFullTxt?.present ? "present" : "—");
  add("markdown negotiation", ex.markdownNegotiation?.supported ? "supported" : "—");
  if (html.visibleTextChars != null) add("text without JS", `${html.visibleTextChars.toLocaleString()} chars`);
  if (ex.xRobotsTag) add("x-robots-tag", ex.xRobotsTag);

  // methodology
  const meth = $("methodology-list");
  meth.innerHTML = "";
  for (const m of data.methodology || []) meth.appendChild(el("li", null, m));

  // links + agent prompt personalization
  $("md-link").href = `/api/markdown?url=${encodeURIComponent(currentUrl)}&raw=1`;
  personalizePrompt(data.finalUrl || currentUrl);

  $("report").hidden = false;
}

function personalizePrompt(url) {
  const clean = url.replace(/\/$/, "");
  $("agent-prompt").textContent =
`Check the AI visibility of ${clean} and fix what you find:

1. GET https://amivisible.dev/api/check?url=${encodeURIComponent(clean)}
   Tell me which AI crawlers can read my site and which can't, and why.
2. GET https://amivisible.dev/api/fixkit?url=${encodeURIComponent(clean)}
   It returns a recommended robots.txt, an llms.txt draft, and IndexNow steps.
3. Apply the fixes that make sense in my repo, and show me the diff.`;
}

async function loadFixkit() {
  if (!currentUrl) return;
  const box = $("fixkit");
  box.hidden = false;
  box.innerHTML = "<p class='kit-note'>building the kit…</p>";
  try {
    const res = await fetch(`/api/fixkit?url=${encodeURIComponent(currentUrl)}`);
    const kit = await res.json();
    if (!res.ok || kit.error) {
      box.innerHTML = "";
      box.appendChild(el("p", "kit-note", kit.detail || kit.error || "fix kit failed"));
      return;
    }
    box.innerHTML = "";

    if (kit.robotsTxt) {
      box.appendChild(el("h3", null, "recommended robots.txt"));
      if (kit.robotsTxt.changes?.length) {
        const ul = el("ul", "change-list");
        for (const ch of kit.robotsTxt.changes) ul.appendChild(el("li", null, `${ch.action}: ${ch.detail}`));
        box.appendChild(ul);
      }
      box.appendChild(el("pre", null, kit.robotsTxt.recommended || kit.robotsTxt.content || ""));
    }
    if (kit.llmsTxt) {
      box.appendChild(el("h3", null, "llms.txt draft"));
      if (kit.llmsTxt.note) box.appendChild(el("p", "kit-note", kit.llmsTxt.note));
      box.appendChild(el("pre", null, kit.llmsTxt.draft || kit.llmsTxt.content || ""));
    }
    if (kit.indexNow) {
      box.appendChild(el("h3", null, "IndexNow"));
      if (kit.indexNow.note) box.appendChild(el("p", "kit-note", kit.indexNow.note));
      const steps = kit.indexNow.steps || [];
      if (steps.length) {
        const ol = el("ol", "change-list");
        for (const s of steps) ol.appendChild(el("li", null, s));
        box.appendChild(ol);
      }
      if (kit.indexNow.key) box.appendChild(el("pre", null, `key: ${kit.indexNow.key}`));
    }
  } catch (err) {
    box.innerHTML = "";
    box.appendChild(el("p", "kit-note", `fix kit failed — ${err.message}`));
  }
}

/* wiring */
$("scan-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = normalizeUrl($("url-input").value);
  if (!url) { $("url-input").focus(); return; }
  const params = new URLSearchParams(location.search);
  params.set("url", url);
  history.replaceState(null, "", `?${params}`);
  runScan(url);
});

$("fresh-btn").addEventListener("click", () => currentUrl && runScan(currentUrl, true));
$("fixkit-btn").addEventListener("click", loadFixkit);

const bindCopy = (btnId, srcId, label) => {
  $(btnId).addEventListener("click", async () => {
    await navigator.clipboard.writeText($(srcId).textContent);
    $(btnId).textContent = "copied ✓";
    setTimeout(() => { $(btnId).textContent = label; }, 1600);
  });
};
bindCopy("copy-prompt", "agent-prompt", "copy prompt");
bindCopy("copy-fix", "fix-prompt", "copy fix prompt");

// shareable links: /?url=… auto-runs
const initial = new URLSearchParams(location.search).get("url");
if (initial) {
  const url = normalizeUrl(initial);
  if (url) {
    $("url-input").value = url.replace(/^https:\/\//, "").replace(/\/$/, "");
    runScan(url);
  }
}
