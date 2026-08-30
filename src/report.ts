// Orchestrates a full check: robots.txt layer + live edge layer + raw-HTML layer,
// then assembles per-crawler verdicts and honest findings. No LLM anywhere.

import { CRAWLERS, PROBE_CRAWLERS, FAKE_TOKENS, ALIAS_SETS, type Crawler } from "./crawlers";
import { parseRobots, evaluateRobots, type ParsedRobots, type RobotsVerdict } from "./robots";
import { analyzeHtml, fingerprintPlatform, type HtmlAnalysis, type PlatformFingerprint } from "./analyze";
import { probeAs, classifyEdge, CONTROL_UA, type EdgeVerdict } from "./probe";

export interface CrawlerReport {
  id: string;
  name: string;
  operator: string;
  tier: Crawler["tier"];
  trainingOnly: boolean;
  purpose: string;
  robots: { verdict: RobotsVerdict; matchedAgent: string | null };
  edge: EdgeVerdict | "not-probed";
  /** the bottom line: can this crawler actually read your content? */
  canRead: boolean;
  /** why not, in one sentence */
  blockedBy: string | null;
  note?: string;
}

export interface Finding {
  id: string;
  severity: "critical" | "warning" | "info" | "good";
  /** PROVEN | LIKELY | SPECULATIVE — evidence tier per our research */
  evidence: "PROVEN" | "LIKELY" | "SPECULATIVE" | "FACT";
  title: string;
  detail: string;
  fix?: string;
}

export interface CheckReport {
  url: string;
  finalUrl: string;
  checkedAt: string;
  version: 1;
  headline: { visible: number; total: number; text: string };
  platform: PlatformFingerprint;
  html: HtmlAnalysis | null;
  crawlers: CrawlerReport[];
  findings: Finding[];
  extras: {
    robotsTxtFound: boolean;
    sitemaps: string[];
    llmsTxt: { present: boolean; bytes: number };
    llmsFullTxt: { present: boolean; bytes: number };
    xRobotsTag: string | null;
    markdownNegotiation: { supported: boolean; contentType: string | null };
  };
  methodology: string[];
}

export async function runCheck(rawUrl: string): Promise<CheckReport> {
  const url = new URL(rawUrl);

  // Control fetch FIRST: it gates reachability and gives us the final origin —
  // an apex→www redirect would otherwise make us read the wrong robots.txt.
  const control = await probeAs(url.href, CONTROL_UA);
  if (control.status === 0 || control.status >= 500) {
    throw new Error(`could not reach ${url.href} (${control.status === 0 ? control.error ?? "no response" : `status ${control.status} — DNS failure or origin down`})`);
  }
  if (!control.ok) {
    throw new Error(`${url.href} returned ${control.status} even to a plain browser probe — the site blocks our datacenter requests entirely, so a crawler comparison would be meaningless`);
  }
  const finalUrl = new URL(control.finalUrl || url.href);
  const origin = finalUrl.origin;
  const path = finalUrl.pathname || "/";
  const xRobotsTag = ((control as unknown as { headers?: Headers }).headers)?.get("x-robots-tag") ?? null;

  const [robotsRes, llmsRes, llmsFullRes, mdRes, ...probes] = await Promise.all([
    probeAs(`${origin}/robots.txt`, CONTROL_UA),
    probeAs(`${origin}/llms.txt`, CONTROL_UA),
    probeAs(`${origin}/llms-full.txt`, CONTROL_UA),
    probeAs(finalUrl.href, CONTROL_UA, "text/markdown"),
    ...PROBE_CRAWLERS.map((c) => probeAs(url.href, c.ua!)),
  ]);

  const robotsTxtFound = robotsRes.ok && !!robotsRes.body && !/<html[\s>]/i.test(robotsRes.body.slice(0, 200));
  const robots: ParsedRobots = robotsTxtFound ? parseRobots(robotsRes.body) : { groups: [], sitemaps: [], mentionedAgents: [] };
  const html = control.body ? analyzeHtml(control.body) : null;
  const platform = fingerprintPlatform(((control as unknown as { headers?: Headers }).headers) ?? new Headers());

  // sitemap: declared in robots, else probe the conventional path
  let sitemaps = robots.sitemaps;
  if (sitemaps.length === 0) {
    const sm = await probeAs(`${origin}/sitemap.xml`, CONTROL_UA);
    if (sm.ok && /<(urlset|sitemapindex)[\s>]/i.test(sm.body.slice(0, 2000))) sitemaps = [`${origin}/sitemap.xml`];
  }

  const probeById = new Map(PROBE_CRAWLERS.map((c, i) => [c.id, probes[i]]));
  const crawlers: CrawlerReport[] = CRAWLERS.map((c) => {
    const rv = evaluateRobots(robots, c.tokens[0], path);
    const probe = probeById.get(c.id);
    const edge: CrawlerReport["edge"] = probe ? classifyEdge(control, probe) : "not-probed";

    let canRead = true;
    let blockedBy: string | null = null;
    if (rv.verdict === "block") { canRead = false; blockedBy = `robots.txt (User-agent: ${rv.matchedAgent})`; }
    if (edge === "blocked" || edge === "challenged" || edge === "different-content") {
      canRead = false;
      blockedBy = blockedBy
        ? `${blockedBy} + edge (${edge})`
        : `edge/WAF returns ${edge === "blocked" ? "403" : edge} to this bot even though robots.txt allows it`;
    }
    if (edge === "pay-per-crawl") { canRead = false; blockedBy = "Cloudflare Pay-Per-Crawl (402)"; }
    if (canRead && html?.csrShell && c.js !== "yes") {
      canRead = false;
      blockedBy = "content only exists after JavaScript runs — this crawler doesn't execute JS";
    }
    return {
      id: c.id, name: c.name, operator: c.operator, tier: c.tier,
      trainingOnly: c.trainingOnly, purpose: c.purpose,
      robots: rv, edge, canRead, blockedBy, note: c.note,
    };
  });

  const cfBlocking = probes.some((p) => p.cfMitigated !== null || p.cfChallengePage);
  // "present" = served as an actual text file, not a soft-404 HTML page
  const llmsPresent = llmsRes.ok && llmsRes.bytes > 0 && !/<html[\s>]/i.test(llmsRes.body.slice(0, 200));
  const llmsFullPresent = llmsFullRes.ok && llmsFullRes.bytes > 0 && !/<html[\s>]/i.test(llmsFullRes.body.slice(0, 200));
  const findings = buildFindings(robots, robotsTxtFound, html, crawlers, platform, xRobotsTag, {
    llmsPresent,
    llmsFullPresent,
    mdSupported: (mdRes.contentType ?? "").includes("text/markdown"),
    cfBlocking,
    sitemapFound: sitemaps.length > 0,
  });

  // Headline = citation-path crawlers only (tiers: citation + index + secondary)
  const scored = crawlers.filter((c) => !c.trainingOnly);
  const visible = scored.filter((c) => c.canRead).length;

  return {
    url: url.href,
    finalUrl: finalUrl.href,
    checkedAt: new Date().toISOString(),
    version: 1,
    headline: {
      visible, total: scored.length,
      text: visible === scored.length
        ? `All ${scored.length} citation-path AI crawlers can read this page.`
        : `${scored.length - visible} of ${scored.length} citation-path AI crawlers cannot read this page.`,
    },
    platform, html, crawlers, findings,
    extras: {
      robotsTxtFound,
      sitemaps,
      llmsTxt: { present: llmsPresent, bytes: llmsPresent ? llmsRes.bytes : 0 },
      llmsFullTxt: { present: llmsFullPresent, bytes: llmsFullPresent ? llmsFullRes.bytes : 0 },
      xRobotsTag,
      markdownNegotiation: { supported: (mdRes.contentType ?? "").includes("text/markdown"), contentType: mdRes.contentType },
    },
    methodology: [
      "Every result comes from real HTTP probes sent just now — no LLM, no stored data, no accounts.",
      "We read raw HTML only, exactly like every AI crawler except Googlebot. A rendered-vs-raw diff for Google specifically would need a headless browser and is out of scope for these probes.",
      "Cloudflare-vs-manual block attribution is behavioral (challenge signatures): the two are indistinguishable from outside.",
    ],
  };
}

function buildFindings(
  robots: ParsedRobots,
  robotsTxtFound: boolean,
  html: HtmlAnalysis | null,
  crawlers: CrawlerReport[],
  platform: PlatformFingerprint,
  xRobotsTag: string | null,
  extras: { llmsPresent: boolean; llmsFullPresent: boolean; mdSupported: boolean; cfBlocking: boolean; sitemapFound: boolean },
): Finding[] {
  const f: Finding[] = [];
  const mentioned = robots.mentionedAgents.map((a) => a.toLowerCase());

  // CSR shell — the proven headline check
  if (html?.csrShell) {
    f.push({
      id: "csr-shell", severity: "critical", evidence: "PROVEN",
      title: "Your content only exists after JavaScript runs",
      detail: `The raw HTML contains ${html.visibleTextChars} characters of readable text. Two independent studies (Vercel 2025, MERJ 2025) showed GPTBot, OAI-SearchBot, ClaudeBot and PerplexityBot completely miss client-rendered content — only Googlebot executes JavaScript. To every other AI crawler, this page is blank.`,
      fix: "Serve your primary content server-side (SSR/SSG). The MERJ study confirmed the same URL served SSR was captured by every bot tested.",
    });
  } else if (html && html.ssrSafe) {
    f.push({
      id: "ssr-ok", severity: "good", evidence: "PROVEN",
      title: "Your content is readable without JavaScript",
      detail: `${html.visibleTextChars} characters of text are present in the raw HTML — AI crawlers that don't render JS (all of them except Googlebot) can read this page.`,
    });
  }

  // Edge blocks robots.txt doesn't show
  const edgeBlocked = crawlers.filter((c) => c.robots.verdict !== "block" && (c.edge === "blocked" || c.edge === "challenged"));
  if (edgeBlocked.length > 0) {
    const names = edgeBlocked.map((c) => c.name).join(", ");
    f.push({
      id: "edge-block", severity: "critical", evidence: "FACT",
      title: `Your CDN/WAF blocks ${edgeBlocked.length} AI crawler(s) that robots.txt allows`,
      detail: `${names} get blocked at the edge even though your robots.txt permits them. ${extras.cfBlocking ? "The block responses carry Cloudflare challenge signatures — Cloudflare blocks AI bots by default on zones created since 2025-07-01 (or via the 'Block AI Bots' toggle); the block is edge-enforced and invisible in robots.txt." : "Your robots.txt is not the layer doing the blocking — check your CDN/WAF bot-management rules."}`,
      fix: extras.cfBlocking
        ? "Cloudflare dashboard → Security → Bots → allow the AI crawlers you want citing you (search/user-fetch bots), or keep blocking training-only bots — your call, but make it a decision, not a default."
        : "Review your WAF/bot-management rules for User-Agent based blocks on AI crawlers.",
    });
  }

  // Citation-critical robots blocks
  const citationBlocked = crawlers.filter((c) => !c.trainingOnly && c.robots.verdict === "block");
  if (citationBlocked.length > 0) {
    f.push({
      id: "citation-robots-block", severity: "critical", evidence: "FACT",
      title: `robots.txt blocks ${citationBlocked.length} crawler(s) that power AI citations`,
      detail: `${citationBlocked.map((c) => c.name).join(", ")}: these are search-index/user-fetch bots, not training bots. Blocking them removes you from AI answers without protecting anything from training.`,
      fix: "Allow the -SearchBot/-User tokens; block the training tokens (GPTBot, ClaudeBot, CCBot…) if training is your concern.",
    });
  }

  // Training-only blocks are a choice, not a problem — say so (pro-AI honesty)
  const trainingBlocked = crawlers.filter((c) => c.trainingOnly && c.robots.verdict === "block");
  if (trainingBlocked.length > 0) {
    f.push({
      id: "training-blocked", severity: "info", evidence: "FACT",
      title: `${trainingBlocked.length} training-only crawler(s) blocked — this does NOT hurt your AI visibility`,
      detail: `${trainingBlocked.map((c) => c.name).join(", ")} only collect training data. Blocking them doesn't remove you from ChatGPT/Claude/Perplexity answers today.`,
    });
  }

  // Alias gaps
  for (const aliases of ALIAS_SETS) {
    const present = aliases.filter((a) => mentioned.some((m) => m === a.toLowerCase()));
    if (present.length > 0 && present.length < aliases.length) {
      const missing = aliases.filter((a) => !present.includes(a));
      f.push({
        id: `alias-gap-${aliases[0].toLowerCase()}`, severity: "warning", evidence: "FACT",
        title: `Half-blocked crawler: ${present.join("/")} has active alias ${missing.join(", ")}`,
        detail: `Your robots.txt names ${present.join(", ")} but not ${missing.join(", ")} — these are the same crawler lineage under different tokens, so the rule only covers part of it.`,
        fix: `Add matching rules for: ${missing.join(", ")}.`,
      });
    }
  }

  // Fabricated tokens
  const fakes = FAKE_TOKENS.filter((t) => mentioned.includes(t.toLowerCase()));
  if (fakes.length > 0) {
    f.push({
      id: "fake-tokens", severity: "warning", evidence: "FACT",
      title: `robots.txt contains ${fakes.length} token(s) no vendor has ever documented`,
      detail: `${fakes.join(", ")}: these bots don't exist (xAI publishes no crawler token; Copilot uses bingbot; AI Overviews uses Googlebot). These lines block nothing.`,
      fix: "Remove them, or keep them as harmless placebo — but know they do nothing.",
    });
  }

  // Google-Extended misconception
  const ge = crawlers.find((c) => c.id === "google-extended");
  if (ge?.robots.verdict === "block") {
    f.push({
      id: "google-extended", severity: "info", evidence: "FACT",
      title: "Google-Extended is blocked — that's a training opt-out, not an AI-visibility loss",
      detail: "Blocking Google-Extended only opts you out of Gemini training. It does NOT remove you from Google Search, AI Overviews, or AI Mode — those read the Googlebot index. (Several other checkers score this backwards.)",
    });
  }

  // robots.txt missing entirely
  if (!robotsTxtFound) {
    f.push({
      id: "no-robots", severity: "info", evidence: "FACT",
      title: "No robots.txt found",
      detail: "Absence means default-allow for every crawler — fine if intentional. A robots.txt also gives you a place to declare sitemaps.",
    });
  }

  // noindex — kills Google indexing, and AI Overviews/AI Mode read the Google index
  const robotsDirectives = [html?.metaRobots, xRobotsTag].filter(Boolean).join(", ").toLowerCase();
  if (/\bnoindex\b/.test(robotsDirectives)) {
    f.push({
      id: "noindex", severity: "critical", evidence: "FACT",
      title: "This page is set to noindex — invisible to Google, and therefore to AI Overviews/AI Mode",
      detail: `Found ${html?.metaRobots && /noindex/i.test(html.metaRobots) ? "meta robots" : "X-Robots-Tag header"}: "${robotsDirectives}". Google AI surfaces ground in the Search index; a noindexed page cannot appear there no matter what else you fix. Bing honors it too, which also affects Copilot and part of ChatGPT Search.`,
      fix: "Remove the noindex directive if this page should be discoverable.",
    });
  }

  // noai meta tags — declared intent, honored by nobody
  if (html && html.noaiTags.length > 0) {
    f.push({
      id: "noai-tags", severity: "info", evidence: "SPECULATIVE",
      title: `noai meta tag present — no AI vendor honors this tag`,
      detail: `Found: ${html.noaiTags.join("; ")}. No crawler from OpenAI, Anthropic, Google, Perplexity or Bing documents respecting noai/noimageai. It declares intent but blocks nothing — robots.txt tokens are the mechanism vendors actually honor.`,
      fix: "If you want to block AI training, use robots.txt tokens (GPTBot, ClaudeBot, CCBot…) — our fix kit generates the stanza.",
    });
  }

  // answer-first structure — deterministic proxies for the one causal study
  if (html && !html.csrShell) {
    const st = html.structure;
    const problems: string[] = [];
    if (st.h1Count === 0) problems.push("no <h1>");
    if (st.h1Count > 1) problems.push(`${st.h1Count} <h1> tags`);
    if (st.h2Count === 0 && html.visibleTextChars > 1500) problems.push("no <h2> section headings");
    if (st.firstParaWords === 0 && html.visibleTextChars > 800) problems.push("no self-contained opening paragraph (15+ words)");
    if (problems.length > 0) {
      f.push({
        id: "structure", severity: "warning", evidence: "PROVEN",
        title: `Answer-first structure gaps: ${problems.join(", ")}`,
        detail: "The only controlled causal study in this space (Princeton/GT GEO, N=10K queries) showed self-contained, well-structured passages with stats and citations lift generative-engine visibility by 15-41%. We check the deterministic proxies: one clear H1, H2 sections, and a direct opening passage.",
        fix: "One H1 stating what the page answers; H2 per subtopic; open with a 40-120 word passage that answers the question on its own.",
      });
    } else if (html.visibleTextChars > 800) {
      f.push({
        id: "structure", severity: "good", evidence: "PROVEN",
        title: "Answer-first structure signals present",
        detail: `Clear heading hierarchy (${st.h1Count} h1, ${st.h2Count} h2) and a self-contained opening passage (${st.firstParaWords} words)${st.statsInOpening ? ", with concrete numbers up front" : ""}. These are the deterministic proxies for the one causally-proven visibility lever (+15-41%, Princeton GEO study).`,
      });
    }
  }

  // freshness signals — LIKELY, intent-dependent
  if (html && html.visibleTextChars > 800) {
    const fr = html.freshness;
    const has = fr.jsonLdDates || fr.metaDates || fr.timeTags;
    f.push({
      id: "freshness", severity: has ? "good" : "info", evidence: "LIKELY",
      title: has ? "Machine-readable dates present" : "No machine-readable dates found",
      detail: has
        ? `Found ${[fr.jsonLdDates && "JSON-LD datePublished/dateModified", fr.metaDates && "article meta dates", fr.timeTags && "<time datetime>"].filter(Boolean).join(", ")}. Perplexity documents recency weighting; Google weights freshness on time-sensitive queries. Correlational, not causal — useful, not magic.`
        : "datePublished/dateModified (JSON-LD), article:modified_time, or <time datetime> let engines judge recency. Matters mainly for time-sensitive queries; evergreen pages lose little.",
    });
  }

  // sitemap — proven crawl infrastructure, not a citation driver
  if (!extras.sitemapFound) {
    f.push({
      id: "no-sitemap", severity: "warning", evidence: "PROVEN",
      title: "No sitemap found (robots.txt declaration or /sitemap.xml)",
      detail: "Sitemaps are the documented crawl-priority mechanism for Google and Bing — foundational hygiene, same tier as HTTPS. They don't cause citations; they make sure the index that AI answers read from actually has your pages.",
      fix: "Generate a sitemap.xml and declare it in robots.txt with a Sitemap: line.",
    });
  }

  // llms.txt — pro-AI hospitality, honestly labeled (never scored)
  if (extras.llmsPresent) {
    f.push({
      id: "llms-txt", severity: "good", evidence: "SPECULATIVE",
      title: "llms.txt present — the welcome mat is out for the agent web",
      detail: "No major engine documents consuming llms.txt yet (an Ahrefs study across ~5,000 domains found zero attributable citations), so it never affects your score. But agents pointed at a site do fetch it, it costs one static file, and it tells every AI reader you want them here. We serve one ourselves.",
    });
  } else {
    f.push({
      id: "llms-txt", severity: "info", evidence: "SPECULATIVE",
      title: "No llms.txt — one static file would greet the agent web",
      detail: "No major engine documents consuming llms.txt yet (an Ahrefs study across ~5,000 domains found zero attributable citations), so this never affects your score. But coding agents and AI browsers pointed at your site do fetch it, it costs nothing to serve, and it's the friendly move. The fix kit drafts one for you.",
      fix: "Serve /llms.txt — a short markdown index of your key pages (the fix kit drafts one for you).",
    });
  }

  // Markdown negotiation
  if (extras.mdSupported) {
    f.push({
      id: "md-negotiation", severity: "good", evidence: "FACT",
      title: "Serves markdown to agents (Accept: text/markdown)",
      detail: "This site answers content negotiation with real markdown — agents get clean text without HTML parsing. Rare and genuinely agent-friendly.",
    });
  }

  // JSON-LD
  if (html && html.jsonLdTypes.length > 0) {
    f.push({
      id: "json-ld", severity: "good", evidence: "LIKELY",
      title: `Structured data present: ${html.jsonLdTypes.slice(0, 5).join(", ")}`,
      detail: "JSON-LD gives Google rich-result eligibility (documented) and machine-readable context. No AI engine documents consuming it for citations — treat as hygiene, not magic.",
    });
  }

  const order = { critical: 0, warning: 1, good: 2, info: 3 };
  return f.sort((a, b) => order[a.severity] - order[b.severity]);
}
