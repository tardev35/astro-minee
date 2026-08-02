/**
 * Is `itemPath` the page currently being rendered?
 *
 * ── WHY THIS IS NOT INLINE IN THE NAVBAR ────────────────────────────────────
 * All 16 Navbar* variants shipped their own copy of this, and all 16 copies
 * were the same three broken lines:
 *
 *   if (path === "/") return currentPath === "/";
 *   return currentPath.startsWith(path);
 *
 * `Astro.url.pathname` is percent-encoded, and this template has Thai routes.
 * On /ทดลองเล่น the pathname is "/%E0%B8%97%E0%B8%94..." while the menu item
 * says "/ทดลองเล่น", so `startsWith` is false and NO menu item highlights —
 * confirmed in the built HTML on both Thai pages. Astro also emits directory
 * routes, so the pathname has a trailing slash the menu item does not.
 *
 * A rebrand switches to a different navbar variant every time, so fixing the
 * active one fixes nothing durable: the bug would return with whichever
 * variant is picked next. It lives here, in a file no rebrand rewrites, and
 * every variant imports it.
 *
 * `startsWith` also needs the boundary check. Without it a "/promo" item would
 * light up on "/promotion", which is the kind of thing nobody notices until a
 * brand happens to have both.
 */
export function isActivePath(currentPathname: string, itemPath: string): boolean {
  const normalise = (p: string) => {
    let decoded = p;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      // Malformed escape sequence — compare the raw string rather than throw.
    }
    return decoded.replace(/\/+$/, "") || "/";
  };

  const current = normalise(currentPathname);
  const item = normalise(itemPath);

  if (item === "/") return current === "/";
  return current === item || current.startsWith(`${item}/`);
}
