// AI crawler registry. Every row is vendor-documented; UA strings live-verified
// 2026-08-29 where possible. No fabricated bots (no GrokBot — xAI publishes no token).

export type Tier = "citation" | "index" | "secondary" | "training";
export type Js = "yes" | "partial" | "no" | "unknown";

export interface Crawler {
  id: string;
  name: string;
  operator: string;
  /** robots.txt User-agent token(s); first entry is canonical, rest are live aliases */
  tokens: string[];
  /** full UA header we send when probing as this crawler; null = never probe (policy-only token) */
  ua: string | null;
  purpose: string;
  tier: Tier;
  /** true = blocking this only affects model training, not current citations */
  trainingOnly: boolean;
  js: Js;
  /** vendor-published IP range JSON, if live-verified */
  ipJson?: string;
  note?: string;
}

export const CRAWLERS: Crawler[] = [
  // ── Tier 1: blocking these loses you citations in AI answers ──
  {
    id: "oai-searchbot", name: "OAI-SearchBot", operator: "OpenAI",
    tokens: ["OAI-SearchBot"],
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
    purpose: "Builds the ChatGPT Search index — this is what gets you cited in ChatGPT",
    tier: "citation", trainingOnly: false, js: "no",
    ipJson: "https://openai.com/searchbot.json",
  },
  {
    id: "chatgpt-user", name: "ChatGPT-User", operator: "OpenAI",
    tokens: ["ChatGPT-User"],
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    purpose: "Fetches your page live when a ChatGPT user asks about it",
    tier: "citation", trainingOnly: false, js: "unknown",
    ipJson: "https://openai.com/chatgpt-user.json",
  },
  {
    id: "claude-searchbot", name: "Claude-SearchBot", operator: "Anthropic",
    tokens: ["Claude-SearchBot"],
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +claudebot@anthropic.com",
    purpose: "Builds Claude's search-grounding index",
    tier: "citation", trainingOnly: false, js: "no",
  },
  {
    id: "claude-user", name: "Claude-User", operator: "Anthropic",
    tokens: ["Claude-User"],
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +claudebot@anthropic.com",
    purpose: "Fetches your page live when a Claude user asks about it",
    tier: "citation", trainingOnly: false, js: "no",
  },
  {
    id: "perplexitybot", name: "PerplexityBot", operator: "Perplexity",
    tokens: ["PerplexityBot"],
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    purpose: "Builds Perplexity's answer/citation index",
    tier: "citation", trainingOnly: false, js: "no",
    ipJson: "https://www.perplexity.ai/perplexitybot.json",
  },
  {
    id: "perplexity-user", name: "Perplexity-User", operator: "Perplexity",
    tokens: ["Perplexity-User"],
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
    purpose: "Fetches your page live for a Perplexity user's question",
    tier: "citation", trainingOnly: false, js: "no",
  },

  // ── Tier 2: search indexes that AI surfaces are built on ──
  {
    id: "googlebot", name: "Googlebot", operator: "Google",
    tokens: ["Googlebot"],
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/126.0.0.0 Safari/537.36",
    purpose: "Google Search index — AI Overviews and AI Mode read from it (there is no separate AI Overviews bot)",
    tier: "index", trainingOnly: false, js: "yes",
    note: "The only AI-relevant crawler that renders JavaScript.",
  },
  {
    id: "bingbot", name: "Bingbot", operator: "Microsoft",
    tokens: ["bingbot"],
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/126.0.0.0 Safari/537.36",
    purpose: "Bing index — sole upstream for Microsoft Copilot and part of ChatGPT Search grounding (there is no CopilotBot)",
    tier: "index", trainingOnly: false, js: "partial",
    ipJson: "https://www.bing.com/toolbox/bingbot.json",
  },

  // ── Tier 3: smaller answer engines ──
  {
    id: "duckassistbot", name: "DuckAssistBot", operator: "DuckDuckGo",
    tokens: ["DuckAssistBot"],
    ua: "DuckAssistBot/1.0; (+http://duckduckgo.com/duckassistbot.html)",
    purpose: "Fetches sources for DuckDuckGo's AI answers (separate from DuckDuckBot)",
    tier: "secondary", trainingOnly: false, js: "no",
  },
  {
    id: "youbot", name: "YouBot", operator: "You.com",
    tokens: ["YouBot"],
    ua: "Mozilla/5.0 (compatible; YouBot (+http://www.you.com))",
    purpose: "You.com search + AI answer grounding",
    tier: "secondary", trainingOnly: false, js: "no",
  },
  {
    id: "mistralai-user", name: "MistralAI-User", operator: "Mistral AI",
    tokens: ["MistralAI-User"],
    ua: "Mozilla/5.0 (compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)",
    purpose: "Fetches your page live for a Le Chat user's question",
    tier: "secondary", trainingOnly: false, js: "unknown",
  },

  // ── Training-only: blocking these does NOT cost citations today ──
  {
    id: "gptbot", name: "GPTBot", operator: "OpenAI",
    tokens: ["GPTBot"],
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
    purpose: "Training-data crawl for future OpenAI models",
    tier: "training", trainingOnly: true, js: "no",
    ipJson: "https://openai.com/gptbot.json",
  },
  {
    id: "claudebot", name: "ClaudeBot", operator: "Anthropic",
    tokens: ["ClaudeBot", "anthropic-ai", "Claude-Web"],
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    purpose: "Training-data crawl for future Anthropic models",
    tier: "training", trainingOnly: true, js: "no",
    note: "anthropic-ai and Claude-Web are legacy aliases — blocking only one leaves the gap open.",
  },
  {
    id: "google-extended", name: "Google-Extended", operator: "Google",
    tokens: ["Google-Extended"],
    ua: null, // policy token only — Google-Extended never crawls with its own UA
    purpose: "Opt-out token for Gemini TRAINING use only. Blocking it does NOT remove you from Search, AI Overviews, or AI Mode",
    tier: "training", trainingOnly: true, js: "unknown",
  },
  {
    id: "applebot-extended", name: "Applebot-Extended", operator: "Apple",
    tokens: ["Applebot-Extended"],
    ua: null, // policy token; Applebot does the crawling
    purpose: "Opt-out for Apple Intelligence training; blocking it does not hurt Siri/Spotlight",
    tier: "training", trainingOnly: true, js: "unknown",
  },
  {
    id: "ccbot", name: "CCBot", operator: "Common Crawl",
    tokens: ["CCBot"],
    ua: "CCBot/2.0 (https://commoncrawl.org/faq/)",
    purpose: "Open crawl corpus used by many labs for training",
    tier: "training", trainingOnly: true, js: "no",
  },
  {
    id: "bytespider", name: "Bytespider", operator: "ByteDance",
    tokens: ["Bytespider"],
    ua: "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)",
    purpose: "ByteDance LLM training crawl",
    tier: "training", trainingOnly: true, js: "no",
  },
  {
    id: "meta-externalagent", name: "Meta-ExternalAgent", operator: "Meta",
    tokens: ["meta-externalagent"],
    ua: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
    purpose: "Meta AI (Llama) training/eval crawl",
    tier: "training", trainingOnly: true, js: "unknown",
  },
  {
    id: "amazonbot", name: "Amazonbot", operator: "Amazon",
    tokens: ["Amazonbot"],
    ua: "Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)",
    purpose: "Training crawl for Amazon Q / Alexa LLM",
    tier: "training", trainingOnly: true, js: "unknown",
  },
];

/** Tokens people copy into robots.txt that no vendor has ever documented — they block nothing. */
export const FAKE_TOKENS = ["GrokBot", "xAI-Bot", "CopilotBot", "Bing-Extended", "AIOverviewsBot", "GeminiBot", "OpenAIBot"];

/** Alias sets where blocking one but not the others is a half-block. */
export const ALIAS_SETS: string[][] = [
  ["ClaudeBot", "anthropic-ai", "Claude-Web"],
  ["Teclis", "KagiBot"],
];

export const PROBE_CRAWLERS = CRAWLERS.filter((c) => c.ua !== null);
