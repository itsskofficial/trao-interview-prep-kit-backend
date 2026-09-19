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

  const text = root
    .text()
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, maxTextChars);

  return { title, description, text, links };
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
