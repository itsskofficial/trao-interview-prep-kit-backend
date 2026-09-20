import * as cheerio from "cheerio";

export type LinkRegion = "nav" | "header" | "footer" | "body";

export interface PageLink {
  url: string;
  text: string;
  region: LinkRegion;
}

export interface CleanPage {
  title: string;
  description: string;
  /** Visible text only, one block per line. */
  text: string;
  /**
   * "embedded" when the page showed almost nothing without JavaScript and the text was read from what it ships for its
   * own scripts to render: noscript blocks, hydration JSON, structured data. The crawl says so in the research log.
   */
  textSource: "visible" | "embedded";
  links: PageLink[];
}

const NEVER_CONTENT = "script, style, noscript, template, svg, canvas, iframe, object, embed, form, select, button";
const HIDDEN_BY_ATTRIBUTE = '[hidden], [aria-hidden="true"], input[type="hidden"]';
const HIDDEN_BY_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/i;
const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, tr, dt, dd, blockquote, pre, section, article, div, br";

/**
 * Turns fetched HTML into text a person would actually see, plus its links.
 * Hidden elements and comments are removed because that is where instructions
 * aimed at a model are usually planted.
 */
export function cleanHtml(html: string, pageUrl: string, maxTextChars = 20_000): CleanPage {
  const $ = cheerio.load(html);

  const baseHref = $("base[href]").first().attr("href");
  const base = safeUrl(baseHref ?? "", pageUrl)?.href ?? pageUrl;

  // Links are read before anything is removed: a nav inside a hidden mobile menu is still a real link.
  const links = collectLinks($, base);
  // So is what the page ships for its own scripts, which is about to be removed with them.
  const shipped = shippedForScripts($);

  $(NEVER_CONTENT).remove();
  $(HIDDEN_BY_ATTRIBUTE).remove();
  $("[style]").each((_, element) => {
    if (HIDDEN_BY_STYLE.test($(element).attr("style") ?? "")) $(element).remove();
  });
  $("*").contents().each((_, node) => {
    if (node.type === "comment") $(node).remove();
  });

  const title = $("title").first().text().trim() || $("h1").first().text().trim();
  const description = $('meta[name="description"]').attr("content")?.trim() ?? "";

  // Prefer the page's own main content; chrome (nav, header, footer) is not what the company says about itself.
  const root = $($("main").get(0) ?? $("body").get(0) ?? $.root().get(0)!);
  root.find("nav, header, footer, aside").remove();
  root.find(BLOCKS).each((_, element) => {
    $(element).append("\n");
  });

  const visible = toLines(root.text()).join("\n").slice(0, maxTextChars);
  if (visible.length >= THIN_PAGE_CHARS) return { title, description, text: visible, textSource: "visible", links };

  // A page that renders in the browser shows a crawler next to nothing. Most still ship their content in the HTML, for
  // their own scripts to render: that is read instead of giving up, and it is no less a stranger's text than the rest.
  const embedded = proseFrom(shipped, description).join("\n").slice(0, maxTextChars);
  return embedded.length > visible.length ? { title, description, text: embedded, textSource: "embedded", links } : { title, description, text: visible, textSource: "visible", links };
}

/** Below this, a page has said nothing: a heading and a cookie notice. */
const THIN_PAGE_CHARS = 400;
const MAX_EMBEDDED_JSON_CHARS = 2_000_000;

const toLines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

interface Shipped {
  noscript: string[];
  json: unknown[];
}

/** What a client-rendered page carries in its HTML: noscript fallbacks, hydration state (Next.js and the like), structured data. */
function shippedForScripts($: cheerio.CheerioAPI): Shipped {
  const noscript = $("body noscript")
    .map((_, element) => $(element).text())
    .get();
  const json: unknown[] = [];
  $('script#__NEXT_DATA__, script[type="application/json"], script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).text();
    if (raw.length === 0 || raw.length > MAX_EMBEDDED_JSON_CHARS) return;
    try {
      json.push(JSON.parse(raw));
    } catch {
      // Not JSON after all; nothing to read.
    }
  });
  return { noscript, json };
}

/**
 * Words a person would read, as opposed to the ids, paths, class names and tokens that make up most of a hydration
 * payload. Deliberately short enough to keep a list item like "Recruiter call (30 minutes)": on a hiring page the
 * stages are exactly the short lines.
 */
function looksLikeProse(value: string): boolean {
  if (value.length < 15 || value.length > 5_000) return false;
  if (/^(https?:|\/|data:|#|[\w.-]+\.(js|css|png|jpe?g|svg|webp|woff2?)\b)/i.test(value)) return false;
  const words = value.split(/\s+/);
  if (words.length < 3) return false;
  // Minified code and encoded blobs have long unbroken runs and few ordinary words.
  const ordinary = words.filter((word) => /^[(“"']?[\p{L}'’-]{2,}[.,;:!?)”"']*$/u.test(word)).length;
  return ordinary / words.length >= 0.6;
}

function proseFrom(shipped: Shipped, description: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (text: string) => {
    // Content systems store rich text as HTML strings. It is cleaned like any other markup, hidden parts included.
    const plain = /<[a-z][^>]*>/i.test(text) ? cleanHtml(`<body>${text}</body>`, "http://embedded.invalid/", 20_000).text : text;
    for (const line of toLines(plain)) {
      if (!looksLikeProse(line) || seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  };

  for (const block of shipped.noscript) add(block);
  let budget = 5_000; // values visited, so a huge state tree cannot hold a crawl up
  const walk = (value: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > 12) return;
    if (typeof value === "string") add(value);
    else if (Array.isArray(value)) for (const entry of value) walk(entry, depth + 1);
    else if (value && typeof value === "object") for (const entry of Object.values(value)) walk(entry, depth + 1);
  };
  for (const tree of shipped.json) walk(tree, 0);

  if (lines.length === 0 && looksLikeProse(description)) lines.push(description);
  return lines;
}

function collectLinks($: cheerio.CheerioAPI, base: string): PageLink[] {
  const seen = new Set<string>();
  const links: PageLink[] = [];

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const url = safeUrl(anchor.attr("href") ?? "", base);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return;
    url.hash = "";
    if (seen.has(url.href)) return;
    seen.add(url.href);

    const text = (anchor.text() || anchor.attr("aria-label") || anchor.attr("title") || "").replace(/\s+/g, " ").trim();
    const region: LinkRegion = anchor.closest("nav").length
      ? "nav"
      : anchor.closest("footer").length
        ? "footer"
        : anchor.closest("header").length
          ? "header"
          : "body";
    links.push({ url: url.href, text, region });
  });
  return links;
}

/** Relative links resolve against the page (or its <base>); nothing assumes a particular host. */
function safeUrl(href: string, base: string): URL | undefined {
  try {
    return new URL(href.trim(), base);
  } catch {
    return undefined;
  }
}
