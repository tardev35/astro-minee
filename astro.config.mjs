// @ts-check
import { defineConfig } from "astro/config";

import tailwindcss from "@tailwindcss/vite";

import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },

  image: {
    service: { entrypoint: "./tools/avif-quality-service.mjs" },
  },

  build: {
    // "auto" (Astro's default) externalises anything over ~4 kB and keeps the
    // genuinely tiny page-level blocks inline.
    //
    // This used to be "always", which is a good setting for a small stylesheet
    // and a bad one for this project's: the sheet is ~227 kB, so 82% of every
    // byte of HTML the site shipped was the same CSS pasted into each page —
    // 1.83 MB across the build, none of it cacheable, and re-downloaded on
    // every navigation. It also pushed the hero <img> ~230 kB down the
    // document, so the preload scanner reached the LCP image late on the one
    // request where it matters.
    //
    // The trade is one render-blocking request on a cold visit. With
    // public/_headers marking /_astro/* immutable for a year, that is paid once
    // per visitor instead of once per page view.
    inlineStylesheets: "auto",
  },

  redirects: {
    "/line": "https://tinyurl.com/tog191",
  },

  // The one place the domain is written. canonical, sitemap, robots.txt, the
  // JSON-LD and the contact mailbox host all derive from it — never retype a
  // domain anywhere else. (If a brand ever launches on an IDN again, write it
  // in Thai here: Node normalises it to punycode at new URL(), which is the
  // only form a crawler resolves, so do not "fix" it to the xn-- form.)
  site: "https://pattaya168-slot.co",
  integrations: [
    sitemap({
      // /login, /register and /line are forwarding pages that all ship
      // noindex. Listing a noindex URL in the sitemap is a contradiction —
      // it asks Google to crawl a page it is simultaneously told to drop, and
      // Search Console reports it as "Submitted URL marked noindex". These
      // three are also the only pages carrying the affiliate and LINE short
      // links, so there is nothing here to gain from the crawl either.
      // Match against the pathname, anchored at the front. The old form tested
      // the whole URL unanchored, so a future page whose path merely ENDED in
      // one of these words — /promotion/login, say — would have been dropped
      // from the sitemap silently.
      filter: (page) => !/^\/(login|register|line)\/?$/.test(new URL(page).pathname),
    }),
  ],
});
