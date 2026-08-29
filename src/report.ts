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
    markdownNegotiation: { supported: boolean; contentType: string | null };
  };
}

export async function runCheck(rawUrl: string): Promise<CheckReport> {
  const url = new URL(rawUrl);
  const origin = url.origin;
  const path = url.pathname || "/";

  // Layer 0: control fetch + side files, in parallel with crawler probes
  const [control, robotsRes, llmsRes, mdRes, ...probes] = await Promise.all([
    probeAs(url.href, CONTROL_UA),
    probeAs(`${origin}/robots.txt`, CONTROL_UA),
    probeAs(`${origin}/llms.txt`, CONTROL_UA),
    probeAs(url.href, CONTROL_UA, "text/markdown"),
    ...PROBE_CRAWLERS.map((c) => probeAs(url.href, c.ua!)),
  ]);

  const robotsTxtFound = robotsRes.ok && !!robotsRes.body && !/<html[\s>]/i.test(robotsRes.body.slice(0, 200));
  const robots: ParsedRobots = robotsTxtFound ? parseRobots(robotsRes.body) : { groups: [], sitemaps: [], mentionedAgents: [] };
  const html = control.ok && control.body ? analyzeHtml(control.body) : null;
  const platform = fingerprintPlatform(((control as unknown as { headers?: Headers }).headers) ?? new Headers());

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
  const findings = buildFindings(robots, robotsTxtFound, html, crawlers, platform, {
    llmsPresent: llmsRes.ok && llmsRes.bytes > 0 && !/<html[\s>]/i.test(llmsRes.body.slice(0, 200)),
    mdSupported: (mdRes.contentType ?? "").includes("text/markdown"),
    cfBlocking,
  });

  // Headline = citation-path crawlers only (tiers: citation + index + secondary)
  const scored = crawlers.filter((c) => !c.trainingOnly);
  const visible = scored.filter((c) => c.canRead).length;

  return {
    url: url.href,
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
      sitemaps: robots.sitemaps,
      llmsTxt: { present: llmsRes.ok && llmsRes.bytes > 0, bytes: llmsRes.bytes },
      markdownNegotiation: { supported: (mdRes.contentType ?? "").includes("text/markdown"), contentType: mdRes.contentType },
    },
  };
}

function buildFindings(
  robots: ParsedRobots,
  robotsTxtFound: boolean,
  html: HtmlAnalysis | null,
  crawlers: CrawlerReport[],
  platform: PlatformFingerprint,
  extras: { llmsPresent: boolean; mdSupported: boolean; cfBlocking: boolean },
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

  // llms.txt — honestly labeled
  f.push({
    id: "llms-txt", severity: "info", evidence: "SPECULATIVE",
    title: extras.llmsPresent ? "llms.txt present (no engine is documented to read it)" : "No llms.txt (you're not missing much — no engine is documented to read it)",
    detail: "Zero of the five major AI engines document consuming llms.txt; an Ahrefs study across ~5,000 domains found zero attributable citations from it. We report it as info and never score it.",
  });

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
