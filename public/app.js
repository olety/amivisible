/* amivisible frontend — binds to /api/check, /api/fixkit */

const $ = (id) => document.getElementById(id);

const TIER_LABELS = {
  citation: "citation path — these get you cited in AI answers",
  index: "search index",
  secondary: "secondary assistants",
  training: "training-only — blocking these does NOT hurt your visibility",
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

let currentUrl = null;
let probeTimer = null;

function normalizeUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { return new URL(s).href; } catch { return null; }
}

function startProbeLog() {
  const log = $("probe-log");
  log.innerHTML = "";
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
  return steps;
}

function finishProbeLog(steps) {
  clearInterval(probeTimer);
  steps.forEach((s) => { s.classList.remove("active"); s.classList.add("done"); });
}

async function runScan(url, fresh = false) {
  currentUrl = url;
  $("scan-btn").disabled = true;
  $("results").hidden = false;
  $("report").hidden = true;
  $("check-error").hidden = true;
  $("fixkit").hidden = true;
  $("fixkit").innerHTML = "";
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });

  const steps = startProbeLog();
  try {
    const q = `url=${encodeURIComponent(url)}${fresh ? "&fresh=1" : ""}`;
    const res = await fetch(`/api/check?${q}`);
    const data = await res.json();
    finishProbeLog(steps);
    if (!res.ok || data.error) {
      showError(data.detail || data.error || `check failed (${res.status})`);
    } else {
      render(data);
    }
  } catch (err) {
    finishProbeLog(steps);
    showError(`network error — ${err.message}`);
  } finally {
    $("scan-btn").disabled = false;
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

  // crawler chips by tier
  const groups = $("crawler-groups");
  groups.innerHTML = "";
  const byTier = {};
  for (const c of data.crawlers) {
    const key = c.trainingOnly ? "training" : c.tier;
    (byTier[key] ||= []).push(c);
  }
  for (const tier of ["citation", "index", "secondary", "training"]) {
    if (!byTier[tier]) continue;
    const g = el("div", "tier-group");
    g.appendChild(el("div", "tier-label", TIER_LABELS[tier] || tier));
    const chips = el("div", "chips");
    for (const c of byTier[tier]) {
      let cls, title;
      if (c.robots === null && c.edge === null) { // policy tokens (no UA to probe)
        cls = "neutral";
        title = `${c.name}: policy token — not probeable directly`;
      } else if (c.canRead) {
        cls = "ok";
        title = `${c.name} (${c.operator}): can read this page`;
      } else {
        cls = tier === "training" ? "neutral" : "blocked";
        title = `${c.name} (${c.operator}): blocked by ${c.blockedBy || "unknown"}`;
      }
      const chip = el("span", `chip ${cls}`, c.name);
      chip.title = title;
      chips.appendChild(chip);
    }
    g.appendChild(chips);
    groups.appendChild(g);
  }

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
  $("md-link").href = `/api/markdown?url=${encodeURIComponent(currentUrl)}`;
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

// shareable links: /?url=… auto-runs
const initial = new URLSearchParams(location.search).get("url");
if (initial) {
  const url = normalizeUrl(initial);
  if (url) {
    $("url-input").value = url.replace(/^https:\/\//, "").replace(/\/$/, "");
    runScan(url);
  }
}
