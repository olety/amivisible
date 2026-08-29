// RFC 9309 robots.txt evaluation: group selection by most-specific user-agent
// match, rule selection by longest path match (Allow wins ties), * and $ wildcards.

export interface RobotsRule { allow: boolean; path: string }
export interface RobotsGroup { agents: string[]; rules: RobotsRule[] }
export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** every User-agent token that appears anywhere, verbatim */
  mentionedAgents: string[];
}

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const mentionedAgents: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
      mentionedAgents.push(value);
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      if (current) current.rules.push({ allow: field === "allow", path: value });
      lastWasAgent = false;
    } else if (field === "sitemap") {
      if (value) sitemaps.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps, mentionedAgents };
}

function pathRuleMatches(rulePath: string, path: string): boolean {
  if (rulePath === "") return false; // empty Disallow = allow everything
  // escape regex specials except * and $, then translate
  let re = "";
  for (const ch of rulePath) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^{}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re).test(path);
}

export type RobotsVerdict = "allow" | "block" | "default-allow";

/**
 * Evaluate one crawler token against parsed robots.txt.
 * Returns which group matched (specific token vs *) and the verdict for `path`.
 */
export function evaluateRobots(
  robots: ParsedRobots,
  token: string,
  path = "/",
): { verdict: RobotsVerdict; matchedAgent: string | null } {
  const lowerToken = token.toLowerCase();
  // most specific: longest agent string that is a prefix of (or contained in) the token
  let best: { group: RobotsGroup; agent: string } | null = null;
  let star: { group: RobotsGroup; agent: string } | null = null;
  for (const group of robots.groups) {
    for (const agent of group.agents) {
      const a = agent.toLowerCase();
      if (a === "*") { if (!star) star = { group, agent }; continue; }
      if (lowerToken.includes(a) || a.includes(lowerToken)) {
        if (!best || a.length > best.agent.toLowerCase().length) best = { group, agent };
      }
    }
  }
  const chosen = best ?? star;
  if (!chosen) return { verdict: "default-allow", matchedAgent: null };

  let winner: RobotsRule | null = null;
  for (const rule of chosen.group.rules) {
    if (!pathRuleMatches(rule.path, path)) continue;
    if (!winner || rule.path.length > winner.path.length ||
        (rule.path.length === winner.path.length && rule.allow && !winner.allow)) {
      winner = rule;
    }
  }
  if (!winner) return { verdict: best ? "allow" : "default-allow", matchedAgent: chosen.agent };
  return { verdict: winner.allow ? "allow" : "block", matchedAgent: chosen.agent };
}
