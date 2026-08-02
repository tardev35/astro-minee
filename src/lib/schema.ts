// The only JSON-LD builder in this project.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// Before this file, five pages each assembled their own structured data by
// concatenating strings, and all five got it wrong in a different way:
//
//   index.astro        url: Astro.url.origin + currentPath  → no trailing
//                      slash, so the WebPage claimed a different URL than the
//                      page's own <link rel=canonical>
//   contact-us.astro   homePage = "https://ufg8-brand.com"  → the domain typed
//                      out by hand, in a file the next rebrand rewrites
//   ทดลองเล่น.astro    the same wrong URL repeated 13 times, once per game
//
// A parser that sees a WebPage whose `url` is not the canonical URL does not
// treat it as a typo — it treats it as markup describing some other page. The
// fix is not "be careful"; it is to make the mistake unrepresentable. Nothing
// exported here accepts a host, so `homePage + "/contact-us"` can no longer be
// written, and abs() is the single place that decides what a URL looks like.
//
// ── TRAILING SLASH ──────────────────────────────────────────────────────────
// One rule, in one function: every route URL ends in "/", every asset URL does
// not. MainLayout's canonical comes from canonicalFor() below, so the canonical
// and the JSON-LD cannot disagree — and tools/verify-build.mjs compares them on
// every build in case someone reintroduces a hand-written one.
//
// ── DO NOT "TIDY" THE @id FRAGMENTS ─────────────────────────────────────────
// The fragment spellings and the order of nodes in @graph are varied per brand
// on purpose, by the same hash that varies the <head> (see brandProfile.ts).
// This repo ships one template under many unrelated domains; identical
// structured data across all of them is a stronger cross-portfolio fingerprint
// than any of the visible text, because it is exact and machine-readable.
// Making these canonical and consistent would undo that. They are already
// valid — @id is an opaque identifier and @graph is unordered.

import { BRAND_NAME, brandPick, orderForBrand } from "./brandProfile";

export interface SchemaCtx {
  /** The site's origin, from astro.config.mjs. */
  site: URL;
  /** This page's own pathname, exactly as the canonical uses it. */
  path: string;
  /** Per-brand @id fragment spellings. */
  frag: Record<FragKind, string>;
}

export type FragKind = "site" | "org" | "page" | "crumb";

/** Equally valid spellings for each anchor — @id is an opaque identifier, so
 *  nothing downstream can tell these apart. */
const FRAG_CHOICES: Record<FragKind, readonly string[]> = {
  site: ["website", "site", "w"],
  org: ["organization", "org", "publisher"],
  page: ["webpage", "page", "primary"],
  crumb: ["breadcrumb", "crumbs", "trail"],
};

export interface AstroLike {
  site: URL | undefined;
  url: URL;
}

export function schemaCtx(astro: AstroLike): SchemaCtx {
  if (!astro.site) {
    // Failing the build is the point. A silent fallback here would emit
    // structured data pointing at localhost — valid JSON, valid schema.org,
    // and completely wrong on the live site, with nothing to notice it.
    throw new Error("schema.ts: Astro.site is not set. Add `site:` to astro.config.mjs before building.");
  }
  const site = astro.site;
  const frag = {} as Record<FragKind, string>;
  for (const kind of Object.keys(FRAG_CHOICES) as FragKind[]) {
    const choices = FRAG_CHOICES[kind];
    frag[kind] = choices[brandPick(site, `frag-${kind}`, choices.length)];
  }
  return { site, path: astro.url.pathname, frag };
}

/**
 * The one URL builder. Takes a path — never a host — and returns an absolute
 * URL. Called with no path it returns this page's own URL, which is by
 * construction the same string as its canonical.
 */
export function abs(ctx: SchemaCtx, path?: string): string {
  return new URL(normalisePath(path ?? ctx.path), ctx.site).href;
}

/** Routes get a trailing slash; files keep their extension. Astro builds with
 *  directory-style output, so /contact-us is served from /contact-us/ and the
 *  canonical says so. */
function normalisePath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (/\.[a-z0-9]{2,5}$/i.test(p)) return p;
  return p.endsWith("/") ? p : `${p}/`;
}

export function nodeId(ctx: SchemaCtx, path: string, kind: FragKind): string {
  return `${abs(ctx, path)}#${ctx.frag[kind]}`;
}

/** The canonical URL for a page. MainLayout uses this so that the canonical
 *  and every self-referential URL in the JSON-LD come out of the same
 *  function — the class of bug this file exists to remove. */
export function canonicalFor(astro: AstroLike): string {
  return abs(schemaCtx(astro));
}

// ── node builders ──────────────────────────────────────────────────────────

type Node = Record<string, unknown>;

export interface ContactPointInput {
  contactType: string;
  /** Path on this site, e.g. "/line". Never an external short link: this page
   *  is indexed and Google stores structured data verbatim, so a shortener
   *  host here is the most exposed identifier the whole portfolio shares. */
  path: string;
  description?: string;
  availableLanguage?: string[];
}

export interface OrgOptions {
  logoPath?: string;
  alternateName?: string;
  contactPoints?: readonly ContactPointInput[];
}

export function organization(ctx: SchemaCtx, opts: OrgOptions = {}): Node {
  const node: Node = {
    "@type": "Organization",
    "@id": nodeId(ctx, "/", "org"),
    name: BRAND_NAME,
    url: abs(ctx, "/"),
    logo: abs(ctx, opts.logoPath ?? "/logo.webp"),
  };
  if (opts.alternateName) node.alternateName = opts.alternateName;
  if (opts.contactPoints?.length) {
    node.contactPoint = opts.contactPoints.map((cp) => ({
      "@type": "ContactPoint",
      contactType: cp.contactType,
      url: abs(ctx, cp.path),
      ...(cp.availableLanguage ? { availableLanguage: cp.availableLanguage } : {}),
      ...(cp.description ? { description: cp.description } : {}),
    }));
  }
  // No `sameAs`. Declaring shared social profiles across unrelated brands is
  // exactly the cross-portfolio link brandProfile.ts exists to prevent.
  return node;
}

export function website(ctx: SchemaCtx, opts: { alternateName?: string[] } = {}): Node {
  const node: Node = {
    "@type": "WebSite",
    "@id": nodeId(ctx, "/", "site"),
    url: abs(ctx, "/"),
    name: BRAND_NAME,
    inLanguage: "th",
    publisher: { "@id": nodeId(ctx, "/", "org") },
  };
  if (opts.alternateName?.length) node.alternateName = opts.alternateName;
  return node;
}

export interface FaqInput {
  q: string;
  a: string;
}

export interface WebPageOptions {
  name: string;
  description: string;
  /** ContactPage, CollectionPage, … Defaults to WebPage. */
  type?: string;
  primaryImagePath?: string;
  faqs?: readonly FaqInput[];
  hasBreadcrumb?: boolean;
}

export function webPage(ctx: SchemaCtx, opts: WebPageOptions): Node {
  // FAQPage is a subtype of WebPage, so a page with questions gets BOTH types
  // on one node rather than a second node claiming the same URL. Two nodes for
  // one URL is the thing that makes a parser pick one and discard the other.
  //
  // Since Google's August 2023 change, FAQ rich results are limited to
  // government and health sites. This is still worth emitting — it comes free
  // from the FAQ content the page already has, and it helps entity and passage
  // parsing — but do not expect a rich snippet from it.
  const types = opts.faqs?.length ? [opts.type ?? "WebPage", "FAQPage"] : (opts.type ?? "WebPage");

  const node: Node = {
    "@type": types,
    "@id": nodeId(ctx, ctx.path, "page"),
    url: abs(ctx),
    name: opts.name,
    description: opts.description,
    inLanguage: "th",
    isPartOf: { "@id": nodeId(ctx, "/", "site") },
  };
  if (opts.primaryImagePath) {
    node.primaryImageOfPage = { "@type": "ImageObject", url: abs(ctx, opts.primaryImagePath) };
  }
  if (opts.hasBreadcrumb) {
    node.breadcrumb = { "@id": nodeId(ctx, ctx.path, "crumb") };
  }
  if (opts.faqs?.length) {
    node.mainEntity = opts.faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    }));
  }
  return node;
}

export interface CrumbInput {
  name: string;
  path: string;
}

export function breadcrumb(ctx: SchemaCtx, trail: readonly CrumbInput[]): Node {
  return {
    "@type": "BreadcrumbList",
    "@id": nodeId(ctx, ctx.path, "crumb"),
    itemListElement: trail.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: abs(ctx, crumb.path),
    })),
  };
}

export interface ItemListEntry {
  name: string;
  /** Path to the item's image — pass an imported asset's `.src`, which is
   *  already a hashed /_astro/ path. */
  imagePath?: string;
  /** Where the item lives. Defaults to the page listing it. */
  path?: string;
}

export function itemList(
  ctx: SchemaCtx,
  opts: { name: string; alternateName?: string; itemType?: string; items: readonly ItemListEntry[] },
): Node {
  return {
    "@type": "ItemList",
    name: opts.name,
    ...(opts.alternateName ? { alternateName: opts.alternateName } : {}),
    url: abs(ctx),
    itemListElement: opts.items.map((entry, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": opts.itemType ?? "Thing",
        name: entry.name,
        ...(entry.imagePath ? { image: abs(ctx, entry.imagePath) } : {}),
        url: abs(ctx, entry.path ?? ctx.path),
      },
    })),
  };
}

// ── the entry point pages actually call ────────────────────────────────────

export interface PageGraphOptions extends Omit<WebPageOptions, "hasBreadcrumb"> {
  /** Trail from the site root to this page. Every page except the homepage
   *  should pass one — it is what puts the site's structure in front of a
   *  crawler that landed on a deep page from search. */
  breadcrumb?: readonly CrumbInput[];
  /** Extra options for the Organization node (contact points, etc.). */
  org?: OrgOptions;
  /** Extra options for the WebSite node. */
  website?: { alternateName?: string[] };
  /** Additional nodes, built with the exported builders above so they still
   *  go through abs(). */
  extra?: readonly Node[];
}

/**
 * Build the whole JSON-LD document for a page. One call per page:
 *
 *   const ctx = schemaCtx(Astro);
 *   const graph = pageGraph(Astro, { name, description, breadcrumb: [...] });
 *   ...
 *   <script type="application/ld+json" set:html={graph} />
 */
export function pageGraph(astro: AstroLike, opts: PageGraphOptions): string {
  const ctx = schemaCtx(astro);
  const { breadcrumb: trail, org, website: siteOpts, extra, ...pageOpts } = opts;

  const nodes: Node[] = [
    website(ctx, siteOpts ?? {}),
    organization(ctx, org ?? {}),
    webPage(ctx, { ...pageOpts, hasBreadcrumb: Boolean(trail?.length) }),
  ];
  if (trail?.length) nodes.push(breadcrumb(ctx, trail));
  if (extra?.length) nodes.push(...extra);

  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": orderForBrand(nodes, ctx.site, "jsonld"),
  });
}
