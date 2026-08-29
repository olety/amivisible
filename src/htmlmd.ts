// Minimal deterministic HTML -> Markdown over a linkedom tree.
// Written in-house because generic converters embed their own DOM layer,
// which breaks in the Workers runtime. GFM headings/lists/tables/code/links.

type AnyNode = {
  nodeType: number;
  nodeName: string;
  textContent?: string | null;
  childNodes: ArrayLike<AnyNode> & Iterable<AnyNode>;
  getAttribute?: (name: string) => string | null;
};

const BLOCK_SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "SVG", "HEAD", "NAV", "FOOTER"]);

function text(node: AnyNode): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

function inline(node: AnyNode): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) { out += (child.textContent ?? "").replace(/\s+/g, " "); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.nodeName.toUpperCase();
    if (BLOCK_SKIP.has(tag)) continue;
    const inner = () => inline(child).trim();
    switch (tag) {
      case "STRONG": case "B": { const t = inner(); out += t ? `**${t}**` : ""; break; }
      case "EM": case "I": { const t = inner(); out += t ? `*${t}*` : ""; break; }
      case "CODE": { const t = text(child); out += t ? `\`${t}\`` : ""; break; }
      case "A": {
        const href = child.getAttribute?.("href") ?? "";
        const t = inner() || href;
        out += href && !href.startsWith("javascript:") ? `[${t}](${href})` : t;
        break;
      }
      case "IMG": {
        const src = child.getAttribute?.("src") ?? "";
        const alt = child.getAttribute?.("alt") ?? "";
        if (src && !src.startsWith("data:")) out += `![${alt}](${src})`;
        break;
      }
      case "BR": out += "\n"; break;
      default: out += inline(child);
    }
  }
  return out;
}

function block(node: AnyNode, depth = 0): string {
  const parts: string[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType !== 1) {
      const t = (child.textContent ?? "").trim();
      if (t) parts.push(t.replace(/\s+/g, " "));
      continue;
    }
    const tag = child.nodeName.toUpperCase();
    if (BLOCK_SKIP.has(tag)) continue;
    const h = /^H([1-6])$/.exec(tag);
    if (h) { const t = inline(child).trim(); if (t) parts.push(`${"#".repeat(+h[1])} ${t}`); continue; }
    switch (tag) {
      case "P": { const t = inline(child).trim(); if (t) parts.push(t); break; }
      case "HR": parts.push("---"); break;
      case "PRE": {
        const t = (child.textContent ?? "").replace(/\n$/, "");
        if (t.trim()) parts.push("```\n" + t + "\n```");
        break;
      }
      case "BLOCKQUOTE": {
        const t = block(child, depth + 1).trim();
        if (t) parts.push(t.split("\n").map((l) => `> ${l}`).join("\n"));
        break;
      }
      case "UL": case "OL": {
        const items: string[] = [];
        let i = 1;
        for (const li of Array.from(child.childNodes)) {
          if (li.nodeType !== 1 || li.nodeName.toUpperCase() !== "LI") continue;
          const marker = tag === "OL" ? `${i++}.` : "-";
          const inner = block(li, depth + 1).trim().split("\n\n").join("\n");
          if (inner) items.push(`${"  ".repeat(depth)}${marker} ${inner.split("\n").join(`\n${"  ".repeat(depth)}  `)}`);
        }
        if (items.length) parts.push(items.join("\n"));
        break;
      }
      case "TABLE": {
        const rows: string[][] = [];
        const walkRows = (n: AnyNode) => {
          for (const r of Array.from(n.childNodes)) {
            if (r.nodeType !== 1) continue;
            const rTag = r.nodeName.toUpperCase();
            if (rTag === "TR") {
              const cells: string[] = [];
              for (const c of Array.from(r.childNodes)) {
                if (c.nodeType === 1 && /^(TD|TH)$/.test(c.nodeName.toUpperCase())) cells.push(inline(c).trim().replace(/\|/g, "\\|"));
              }
              if (cells.length) rows.push(cells);
            } else if (/^(THEAD|TBODY|TFOOT)$/.test(rTag)) walkRows(r);
          }
        };
        walkRows(child);
        if (rows.length) {
          const width = Math.max(...rows.map((r) => r.length));
          const norm = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
          const lines = [`| ${norm[0].join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`,
            ...norm.slice(1).map((r) => `| ${r.join(" | ")} |`)];
          parts.push(lines.join("\n"));
        }
        break;
      }
      default: {
        const t = block(child, depth);
        if (t.trim()) parts.push(t.trim());
      }
    }
  }
  return parts.join("\n\n");
}

export function htmlToMarkdown(root: AnyNode): string {
  return block(root).replace(/\n{3,}/g, "\n\n").trim();
}
