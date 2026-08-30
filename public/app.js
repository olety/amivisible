/* amivisible frontend — binds to /api/check, /api/fixkit */

const $ = (id) => document.getElementById(id);

const TIER_NAMES = {
  citation: "citation path — gets you cited in AI answers",
  index: "search index",
  secondary: "secondary assistant",
};

// mirrors the server's probe sequence (src/report.ts) — shown while the real probes run
const PROBE_STEPS = [
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

// probed crawlers, in server order — one stamped cell each
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

function startProbeLog() {
  const log = $("probe-log");
  log.innerHTML = "";
  const cellRow = document.createElement("div");
  cellRow.className = "probe-cells";
  const cells = PROBE_CELLS.map((name) => {
    const c = document.createElement("span");
    c.className = "cell";
    c.textContent = name;
    cellRow.appendChild(c);
    return c;
  });
  log.appendChild(cellRow);

  const steps = PROBE_STEPS.map((text) => {
    const div = document.createElement("div");
    div.className = "step";
    div.textContent = text;
    log.appendChild(div);
    return div;
  });
  let i = 0;
  steps[0].classList.add("active");
  probeTimer = setInterval(() => {
    if (i >= steps.length - 1) return; // hold the last step until the response lands
    steps[i].classList.replace("active", "done");
    i += 1;
    steps[i].classList.add("active");
  }, 1100);
  let ci = 0;
  cellTimer = setInterval(() => {
    if (ci >= cells.length - 1) return; // last cell lights when the response lands
    cells[ci].classList.add("lit");
    ci += 1;
  }, 620);
  return { steps, cells };
}

function finishProbeLog(probe) {
  clearInterval(probeTimer);
  clearInterval(cellTimer);
  probe.steps.forEach((s) => { s.classList.remove("active"); s.classList.add("done"); });
  probe.cells.forEach((c) => c.classList.add("lit"));
}

async function runScan(url, fresh = false) {
  if (scanInFlight) return;
  scanInFlight = true;
  currentUrl = url;
  $("scan-btn").setAttribute("aria-disabled", "true");
  $("report").hidden = true;
  $("check-error").hidden = true;
  $("fixkit").hidden = true;
  $("fixkit").innerHTML = "";

  // don't flash the probe UI on cache-fast responses; once shown, hold it briefly
  let probe = null;
  let shownAt = 0;
  const showTimer = setTimeout(() => {
    $("results").hidden = false;
    probe = startProbeLog();
    shownAt = performance.now();
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }, 120);

  try {
    const q = `url=${encodeURIComponent(url)}${fresh ? "&fresh=1" : ""}`;
    const res = await fetch(`/api/check?${q}`);
    const data = await res.json();
    clearTimeout(showTimer);
    if (probe) {
      finishProbeLog(probe);
      const held = performance.now() - shownAt;
      if (held < 600) await new Promise((r) => setTimeout(r, 600 - held));
    } else {
      $("results").hidden = false;
      $("probe-log").innerHTML = "";
      $("results").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (!res.ok || data.error) {
      showError(data.detail || data.error || `check failed (${res.status})`);
    } else {
      render(data);
    }
  } catch (err) {
    clearTimeout(showTimer);
    if (probe) finishProbeLog(probe);
    $("results").hidden = false;
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

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function render(data) {
  // verdict
  $("v-visible").textContent = data.headline.visible;
  $("v-total").textContent = data.headline.total;
  $("v-text").textContent = data.headline.text;
  $("v-url").textContent = data.finalUrl || data.url;
  document.querySelector(".verdict").classList.toggle(
    "all-clear", data.headline.visible === data.headline.total);

  // crawler passport stamps — click one for its story
  const groups = $("crawler-groups");
  groups.innerHTML = "";
  const field = el("div", "stamps");
  const detail = el("div", "stamp-detail");
  detail.hidden = true;
  let active = null;
  for (const c of data.crawlers) {
    const policy = !c.robots && !c.edge;
    const cls = c.canRead ? "ok" : policy ? "neutral" : c.trainingOnly ? "train" : "no";
    const mark = c.canRead ? "\u2713 " : policy ? "\u00b7 " : "\u2717 ";
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
      detail.appendChild(el("div", "sd-head", `${c.name} \u00b7 ${c.operator} \u00b7 ${kind}`));
      if (c.purpose) detail.appendChild(el("p", "sd-purpose", c.purpose));
      const rows = el("div", "sd-rows");
      const row = (k, v, good) => {
        const r = el("div", "sd-row");
        r.appendChild(el("span", "sd-k", k));
        r.appendChild(el("span", "sd-v" + (good === true ? " good" : good === false ? " bad" : ""), v));
        rows.appendChild(r);
      };
      if (policy) {
        row("probe", "policy token \u2014 sends no requests of its own; it only acts through robots.txt rules", null);
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
        detail.appendChild(el("p", "sd-note", "Training-only crawler \u2014 blocking it does not cost you visibility in AI answers."));
      detail.hidden = false;
    });
    field.appendChild(s);
  }
  groups.appendChild(field);
  groups.appendChild(detail);

  // findings
  const list = $("findings");
  list.innerHTML = "";
  for (const f of data.findings) {
    const card = el("div", `finding ${f.severity}`);
    const head = el("div", "finding-head");
    head.appendChild(el("span", `badge sev-${f.severity}`, f.severity));
    if (f.evidence) head.appendChild(el("span", "badge tier", f.evidence));
    head.appendChild(el("span", "finding-title", f.title));
    card.appendChild(head);
    card.appendChild(el("p", "finding-detail", f.detail));
    list.appendChild(card);
  }

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

$("copy-prompt").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("agent-prompt").textContent);
  $("copy-prompt").textContent = "copied ✓";
  setTimeout(() => { $("copy-prompt").textContent = "copy prompt"; }, 1600);
});

// reduced motion: freeze the robot on his poster frame
if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const rv = null;
  if (rv) { rv.removeAttribute("autoplay"); rv.pause(); rv.load(); }
}

// shareable links: /?url=… auto-runs
const initial = new URLSearchParams(location.search).get("url");
if (initial) {
  const url = normalizeUrl(initial);
  if (url) {
    $("url-input").value = url.replace(/^https:\/\//, "").replace(/\/$/, "");
    runScan(url);
  }
}
