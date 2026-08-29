// Raw-HTML analysis: CSR-shell detection, structured data, meta signals.
// Everything here runs on unrendered bytes — exactly what a non-JS AI crawler sees.

export interface HtmlAnalysis {
  bytes: number;
  title: string | null;
  h1: string | null;
  /** visible text length after stripping tags/scripts/styles */
  visibleTextChars: number;
  /** first ~200 chars of visible text — "what the agent reads first" */
  textPreview: string;
  csrShell: boolean;
  emptyRootDiv: boolean;
  frameworkMarkers: string[];
  ssrSafe: boolean;
  jsonLdTypes: string[];
  canonical: string | null;
  metaRobots: string | null;
  noaiTags: string[];
  hasSitemapHint: boolean;
}

const MARKER_PATTERNS: [string, RegExp][] = [
  ["next", /__NEXT_DATA__/],
  ["nuxt", /__NUXT_DATA__|window\.__NUXT__/],
  ["react-ssr", /data-reactroot/],
  ["astro", /<astro-island|astro-static/],
  ["qwik", /q:container/],
  ["sveltekit", /data-sveltekit/],
  ["remix", /__remixContext/],
];

export function analyzeHtml(html: string): HtmlAnalysis {
  const bytes = html.length;
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? null;

  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? html;
  const visible = bodyMatch
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const emptyRootDiv = /<div[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*(<\/div>|<div[^>]*>\s*<\/div>\s*<\/div>)/i.test(html);
  const frameworkMarkers = MARKER_PATTERNS.filter(([, re]) => re.test(html)).map(([n]) => n);

  const jsonLdTypes: string[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]);
      const collect = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(collect);
        if (node && typeof node === "object") {
          const t = (node as Record<string, unknown>)["@type"];
          if (typeof t === "string") jsonLdTypes.push(t);
          if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && jsonLdTypes.push(x));
          const g = (node as Record<string, unknown>)["@graph"];
          if (g) collect(g);
        }
      };
      collect(parsed);
    } catch { /* invalid JSON-LD is itself a finding, but don't crash */ }
  }

  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ?? null;
  const metaRobots = html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? null;
  const noaiTags: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+content=["']([^"']*no(?:ai|imageai)[^"']*)["']/gi)) noaiTags.push(m[1]);

  // Binary per the Vercel/MERJ studies: shell markup with no real text = invisible to non-rendering bots
  const csrShell = (emptyRootDiv && visible.length < 300) || (visible.length < 150 && bytes > 2000);

  return {
    bytes, title, h1,
    visibleTextChars: visible.length,
    textPreview: visible.slice(0, 200),
    csrShell, emptyRootDiv, frameworkMarkers,
    ssrSafe: !csrShell && visible.length >= 300,
    jsonLdTypes: [...new Set(jsonLdTypes)],
    canonical, metaRobots, noaiTags,
    hasSitemapHint: false,
  };
}

export interface PlatformFingerprint { platform: string | null; evidence: string[] }

export function fingerprintPlatform(headers: Headers): PlatformFingerprint {
  const evidence: string[] = [];
  const server = headers.get("server")?.toLowerCase() ?? "";
  let platform: string | null = null;
  if (headers.get("cf-ray") || server.includes("cloudflare")) { platform = "cloudflare"; evidence.push("cf-ray/server header"); }
  else if (headers.get("x-vercel-id")) { platform = "vercel"; evidence.push("x-vercel-id header"); }
  else if (headers.get("x-nf-request-id")) { platform = "netlify"; evidence.push("x-nf-request-id header"); }
  else if (headers.get("x-amz-cf-id")) { platform = "aws-cloudfront"; evidence.push("x-amz-cf-id header"); }
  else if (server.includes("akamai") || headers.get("x-akamai-transformed")) { platform = "akamai"; evidence.push("akamai headers"); }
  else if (headers.get("x-served-by") && server.includes("varnish")) { platform = "fastly"; evidence.push("x-served-by + varnish"); }
  if (headers.get("cf-mitigated")) evidence.push(`cf-mitigated: ${headers.get("cf-mitigated")}`);
  return { platform, evidence };
}
