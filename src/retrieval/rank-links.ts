import type { PageLink } from "./html";

/**
 * Link ranking. Companies put their hiring process in different places, so no
 * path is assumed: every same-site link is scored from the words in its anchor
 * text and its path, where on the page it sits, and how deep it is, and the
 * crawler fetches the best-scoring ones first.
 */

interface Signal {
  phrases: string[];
  weight: number;
}

/** Evidence that a link leads to how the company hires. Strongest first. */
const HIRING_SIGNALS: Signal[] = [
  { weight: 10, phrases: ["interview", "how we hire", "hiring process", "hiring", "recruiting", "recruitment", "candidate", "applicant"] },
  { weight: 7, phrases: ["careers", "career", "jobs", "join us", "join our", "join the team", "joining", "work with us", "work at", "working at", "open roles", "open positions", "vacancies", "opportunities", "we are hiring", "we're hiring"] },
  // Rarely the answer themselves, but often one click away from it.
  { weight: 4, phrases: ["handbook", "people", "talent", "culture", "life at", "team", "engineering", "values"] },
  { weight: 2, phrases: ["blog", "company", "about"] },
];

/** Evidence that a link explains what the company does. */
const ABOUT_SIGNALS: Signal[] = [
  { weight: 8, phrases: ["about", "who we are", "our story", "our mission", "mission", "what we do", "company"] },
  { weight: 5, phrases: ["product", "products", "platform", "solutions", "services", "customers", "how it works", "features"] },
  { weight: 2, phrases: ["team", "values", "culture"] },
];

const NOISE = ["privacy", "terms", "legal", "cookie", "cookies", "login", "log in", "signin", "sign in", "signup", "sign up", "register", "cart", "checkout", "press", "investors", "status", "sitemap", "rss", "feed", "unsubscribe", "download"];
const NOT_A_PAGE = /\.(pdf|png|jpe?g|gif|svg|webp|ico|zip|gz|mp4|mp3|css|js|json|xml|docx?|xlsx?|pptx?)$/i;

export interface RankedLink extends PageLink {
  depth: number;
  hiringScore: number;
  aboutScore: number;
  /** The better of the two intents, after position and depth adjustments. */
  score: number;
}

function words(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim()} `;
}

function strongestSignal(haystack: string, signals: Signal[]): number {
  for (const { phrases, weight } of signals) {
    if (phrases.some((phrase) => haystack.includes(` ${phrase} `))) return weight;
  }
  return 0;
}

/** A page, and not one of the pages every site has that are never the answer. Says nothing about whether it is worth fetching. */
export function isFollowable(link: PageLink): boolean {
  const url = new URL(link.url);
  if (NOT_A_PAGE.test(url.pathname)) return false;
  const path = words(safeDecode(url.pathname));
  const anchor = words(link.text);
  return !NOISE.some((phrase) => anchor.includes(` ${phrase} `) || path.includes(` ${phrase} `));
}

export function rankLink(link: PageLink, depth: number, parentHiringScore = 0): RankedLink | undefined {
  if (!isFollowable(link)) return undefined;
  const url = new URL(link.url);
  const path = words(safeDecode(url.pathname));
  const anchor = words(link.text);

  // Anchor text is what the company chose to call the page, so it counts a little more than the path.
  const intent = (signals: Signal[]) => {
    const fromAnchor = strongestSignal(anchor, signals);
    return Math.max(fromAnchor ? fromAnchor + 1 : 0, strongestSignal(path, signals));
  };
  const hiring = intent(HIRING_SIGNALS);
  const about = intent(ABOUT_SIGNALS);

  // A link found on a page that is already about hiring is worth following even if its own words are vague.
  const inherited = Math.floor(parentHiringScore / 3);
  const position = link.region === "body" ? 0 : 1; // careers and about links live in navigation and footers
  const hiringScore = hiring + inherited;
  const best = Math.max(hiringScore, about);
  if (best === 0) return undefined;

  return { ...link, depth, hiringScore, aboutScore: about, score: best + position - depth };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Highest score first; ties go to the shallower link, then to the order found, so the crawl is deterministic. */
export function byScore(a: RankedLink, b: RankedLink): number {
  return b.score - a.score || a.depth - b.depth;
}
