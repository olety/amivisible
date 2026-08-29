# amivisible

**Can AI see your site?**

Paste a URL. Find out which AI crawlers and agents can actually read it — and which ones your CDN or robots.txt is silently blocking. Pro-AI: the goal is to make your site *visible* to the agents that would cite it, not to block them.

No accounts. No tracking. No LLM at runtime — every check is a real HTTP probe.

Built solo for [Hackyard Yard #1](https://hackyard.dev) ("No accounts", 48h).

## What it checks

- Fetches your page as each major AI crawler (GPTBot, ClaudeBot, PerplexityBot, and friends) and reports who gets a 200 and who gets walled.
- Parses robots.txt per-bot: who you allow, who you block — including blocks you didn't know you shipped.
- Shows your page **through an agent's eyes**: the markdown an AI actually extracts from your HTML.
- Generates a fix kit: corrected robots.txt, llms.txt, and honest labels on every recommendation (proven vs speculative).
- Usable by agents: JSON API + MCP server, so your agent can re-check your site after every deploy.

## API (no accounts, no keys)

```sh
curl "https://amivisible.dev/api/check?url=yoursite.com"
curl "https://amivisible.dev/api/markdown?url=yoursite.com"
curl "https://amivisible.dev/api/fixkit?url=yoursite.com"
```

Reports are versioned JSON — diff two runs to see what a deploy changed.
Append `&fresh=1` to bypass the 1-hour cache after you ship a fix.

## MCP — let your agent re-check your site after every deploy

```sh
claude mcp add --transport http amivisible https://amivisible.dev/mcp
```

Tools: `check_site`, `get_markdown`, `get_fix_kit`. Stateless, no auth.

## Develop

```sh
bun install
bun run dev      # wrangler dev
bun run deploy   # wrangler deploy
```

## License

MIT
