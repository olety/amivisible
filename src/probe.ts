// Live probes: fetch the target as each crawler UA plus a browser control,
// and compare what the edge actually serves. All probes are idempotent GETs.

export interface ProbeResult {
  ua: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  cfMitigated: string | null;
  /** body carries a Cloudflare challenge/block page signature */
  cfChallengePage: boolean;
  /** URL after following redirects (empty on error) */
  finalUrl: string;
  payPerCrawl: boolean;
  bytes: number;
  error?: string;
}

export const CONTROL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MAX_BODY = 512 * 1024;

export async function probeAs(url: string, ua: string, accept?: string): Promise<ProbeResult & { body: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": ua,
        accept: accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en",
        "cache-control": "no-cache",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    const buf = await res.arrayBuffer();
    const body = new TextDecoder("utf-8").decode(buf.slice(0, MAX_BODY));
    const cfChallengePage = res.status >= 400 &&
      (/challenges\.cloudflare\.com|cf-chl|Attention Required!|<title>Just a moment/i.test(body.slice(0, 4000)));
    return {
      ua,
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get("content-type"),
      cfMitigated: res.headers.get("cf-mitigated"),
      cfChallengePage,
      finalUrl: res.url,
      payPerCrawl: res.status === 402 || res.headers.has("crawl-price") || res.headers.has("pay-per-crawl"),
      bytes: buf.byteLength,
      body,
      // keep headers accessible to the caller for fingerprinting
      ...( { headers: res.headers } as object ),
    } as ProbeResult & { body: string; headers: Headers };
  } catch (e) {
    return { ua, status: 0, ok: false, contentType: null, cfMitigated: null, cfChallengePage: false, finalUrl: "", payPerCrawl: false, bytes: 0, body: "", error: e instanceof Error ? e.message : String(e) };
  }
}

export type EdgeVerdict = "pass" | "blocked" | "challenged" | "pay-per-crawl" | "error" | "different-content";

/** Compare a crawler probe against the browser control to classify edge behavior. */
export function classifyEdge(control: ProbeResult, probe: ProbeResult): EdgeVerdict {
  if (probe.error) return "error";
  if (probe.payPerCrawl) return "pay-per-crawl";
  if (probe.cfMitigated === "challenge") return "challenged";
  if (probe.status === 403 || probe.status === 451) return control.ok ? "blocked" : "error";
  if (probe.status === 429 || probe.status === 503) return control.ok ? "challenged" : "error";
  if (probe.ok && control.ok) {
    // Served something, but a tenth of the control size → likely an interstitial/deny page
    if (control.bytes > 5000 && probe.bytes < control.bytes / 10 && probe.bytes < 3000) return "different-content";
    return "pass";
  }
  return probe.ok ? "pass" : "error";
}
