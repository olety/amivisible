// "Through an agent's eyes": what a page looks like as markdown.
// Native negotiation (Accept: text/markdown) is honored first; otherwise we
// extract deterministically with Readability + Turndown. No LLM.

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { htmlToMarkdown } from "./htmlmd";
import { probeAs, CONTROL_UA } from "./probe";

export interface MarkdownView {
  url: string;
  /** "native" = site served text/markdown itself; "extracted" = our pipeline */
  source: "native" | "extracted" | "none";
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  markdown: string;
  markdownChars: number;
  /** chars of readable text in the raw HTML — what a non-JS crawler gets */
  rawTextChars: number;
  negotiation: { supported: boolean; contentType: string | null };
}

const MAX_MD = 200_000;

export async function markdownView(url: string): Promise<MarkdownView> {
  const [native, html] = await Promise.all([
    probeAs(url, CONTROL_UA, "text/markdown"),
    probeAs(url, CONTROL_UA),
  ]);

  const negotiated = (native.contentType ?? "").includes("text/markdown");
  if (negotiated && native.body.trim()) {
    return {
      url, source: "native",
      title: null, byline: null, excerpt: null,
      markdown: native.body.slice(0, MAX_MD),
      markdownChars: native.body.length,
      rawTextChars: native.body.length,
      negotiation: { supported: true, contentType: native.contentType },
    };
  }

  if (!html.ok || !html.body) {
    return {
      url, source: "none", title: null, byline: null, excerpt: null,
      markdown: "", markdownChars: 0, rawTextChars: 0,
      negotiation: { supported: false, contentType: native.contentType },
    };
  }

  const { document } = parseHTML(html.body);
  let article: { title?: string | null; byline?: string | null; excerpt?: string | null; content?: string | null } | null = null;
  try {
    // linkedom's document is close enough to a DOM Document for Readability
    article = new Readability(document as never, { charThreshold: 100 }).parse();
  } catch { /* fall through to whole-body conversion */ }

  let markdown = "";
  try {
    const source = article?.content ?? html.body;
    const { document: mdDoc } = parseHTML(`<html><body>${source}</body></html>`);
    markdown = htmlToMarkdown(mdDoc.body as never);
  } catch (e) {
    markdown = `<!-- extraction failed: ${e instanceof Error ? e.message : String(e)} -->`;
  }
  markdown = markdown.replace(/\n{4,}/g, "\n\n\n").trim();

  const rawText = html.body
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  return {
    url,
    source: markdown ? "extracted" : "none",
    title: article?.title ?? null,
    byline: article?.byline ?? null,
    excerpt: article?.excerpt ?? null,
    markdown: markdown.slice(0, MAX_MD),
    markdownChars: markdown.length,
    rawTextChars: rawText.length,
    negotiation: { supported: false, contentType: native.contentType },
  };
}
