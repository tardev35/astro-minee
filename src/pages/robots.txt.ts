// robots.txt is generated rather than shipped as a static public/ file.
//
// Two reasons: the old file was byte-identical across every brand except its
// Sitemap line (see src/lib/brandProfile.ts), and the Sitemap line had to be
// hand-edited on every domain change — one of the three places a rebrand was
// expected to remember. Deriving it from `site` removes both problems.

import type { APIRoute } from "astro";
import { buildRobotsTxt } from "../lib/brandProfile";

export const GET: APIRoute = ({ site }) =>
  new Response(buildRobotsTxt(site), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
