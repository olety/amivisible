// Minimal stateless MCP server over streamable HTTP (JSON-RPC 2.0).
// Hand-rolled: no SDK, no Durable Objects, no auth — fits "no accounts".
// Supports: initialize, notifications/initialized, ping, tools/list, tools/call.

import { runCheck } from "./report";
import { markdownView } from "./markdown";
import { buildFixKit } from "./fixkit";

const TOOLS = [
  {
    name: "check_site",
    description:
      "Check which AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Googlebot…) can actually see and read a URL. Reports robots.txt rules, edge/WAF blocks, JS-rendering blindness, and honest findings with evidence tiers. Deterministic HTTP probes, no LLM.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL or hostname to check" } },
      required: ["url"],
    },
  },
  {
    name: "get_markdown",
    description:
      "See a page through an agent's eyes: the markdown an AI actually extracts from it. Honors native Accept: text/markdown negotiation when the site supports it, otherwise extracts deterministically (Readability + DOM walk).",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to view as markdown" } },
      required: ["url"],
    },
  },
  {
    name: "get_fix_kit",
    description:
      "Generate a fix kit for a site: corrected robots.txt (citation bots allowed, training blocks preserved, aliases completed, fake tokens dropped), an llms.txt draft (honestly labeled speculative), and IndexNow setup steps.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL or hostname to fix" } },
      required: ["url"],
    },
  },
];

type Rpc = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Record<string, unknown> };

function rpcResult(id: Rpc["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: Rpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMcp(
  req: Rpc,
  validate: (raw: string) => { url: URL } | { error: string },
): Promise<unknown | null> {
  switch (req.method) {
    case "initialize":
      return rpcResult(req.id, {
        protocolVersion: (req.params?.protocolVersion as string) ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "amivisible", version: "1.0.0" },
        instructions:
          "amivisible checks whether AI crawlers can see a site. No accounts, no state: every call is a fresh deterministic probe. Re-run check_site after deploying fixes to verify the change.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response body
    case "ping":
      return rpcResult(req.id, {});
    case "tools/list":
      return rpcResult(req.id, { tools: TOOLS });
    case "tools/call": {
      const name = req.params?.name as string;
      const args = (req.params?.arguments ?? {}) as { url?: string };
      if (!args.url) return rpcError(req.id, -32602, "missing required argument: url");
      const target = validate(args.url);
      if ("error" in target) return rpcError(req.id, -32602, `invalid url: ${target.error}`);
      try {
        let payload: unknown;
        if (name === "check_site") payload = await runCheck(target.url.href);
        else if (name === "get_markdown") payload = await markdownView(target.url.href);
        else if (name === "get_fix_kit") payload = await buildFixKit(target.url.href);
        else return rpcError(req.id, -32602, `unknown tool: ${name}`);
        return rpcResult(req.id, { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
      } catch (e) {
        return rpcResult(req.id, {
          content: [{ type: "text", text: `check failed: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}
