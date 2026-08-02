/**
 * Numbers that drift around a base value, to suggest live activity.
 *
 * ── WHY THIS IS NOT INLINE IN THE COMPONENT ─────────────────────────────────
 * GameRankingBoard ran a recursive setTimeout per element — six of them — with
 * no guard of any kind: not for visibility, not for the tab being in the
 * background, not for prefers-reduced-motion. It ran for as long as the page
 * was open.
 *
 * The container it writes into is `hidden ... sm:flex`, so below the `sm`
 * breakpoint the timers woke the main thread roughly six times every 2.5
 * seconds to retype text inside a `display: none` element. That is every phone.
 *
 * A rebrand retherms these components and rewrites their markup, but it does
 * not touch src/lib — so the guards live here and the component keeps a
 * two-line <script>.
 *
 * ── WHAT THE GUARDS DO ──────────────────────────────────────────────────────
 * IntersectionObserver     covers both scrolled-away and `display: none` — a
 *                          hidden element never intersects, so the mobile case
 *                          is handled without duplicating the breakpoint here
 *                          (where it would go stale the moment someone edits
 *                          the class list).
 * visibilitychange         a backgrounded tab stops entirely.
 * prefers-reduced-motion   the number is rendered once and never animates.
 *                          Text changing on its own is motion, and WCAG 2.2.2
 *                          is about content that moves without the user asking.
 */

export interface LiveCounterOptions {
  /** Elements carrying the base value in a data attribute. */
  selector?: string;
  /** Attribute holding the starting number. */
  baseAttribute?: string;
  /** Milliseconds between updates; the actual delay is randomised in this range. */
  minDelay?: number;
  maxDelay?: number;
  /** Fraction of the base value a single step may move. */
  drift?: number;
  /** How strongly each step is pulled back toward the base value. */
  pull?: number;
}

export function startLiveCounters(options: LiveCounterOptions = {}): () => void {
  const { selector = "[data-players]", baseAttribute = "base", minDelay = 1500, maxDelay = 3500, drift = 0.02, pull = 0.15 } = options;

  const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
  if (elements.length === 0) return () => {};

  const format = new Intl.NumberFormat("en-US");
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  const timers = new Map<HTMLElement, number>();
  const visible = new Set<HTMLElement>();
  let stopped = false;

  const stopFor = (el: HTMLElement) => {
    const id = timers.get(el);
    if (id !== undefined) {
      clearTimeout(id);
      timers.delete(el);
    }
  };

  const state = new Map<HTMLElement, number>();
  for (const el of elements) {
    state.set(el, Number(el.dataset[baseAttribute]) || 0);
  }

  const tick = (el: HTMLElement) => {
    const base = Number(el.dataset[baseAttribute]) || 0;
    const current = state.get(el) ?? base;
    const step = Math.round((Math.random() - 0.5) * base * drift);
    const correction = Math.round((base - current) * pull);
    const next = Math.max(1, current + step + correction);
    state.set(el, next);
    el.textContent = format.format(next);
    schedule(el);
  };

  const schedule = (el: HTMLElement) => {
    if (stopped || document.hidden || !visible.has(el) || reduceMotion?.matches) return;
    stopFor(el);
    timers.set(el, window.setTimeout(() => tick(el), minDelay + Math.random() * (maxDelay - minDelay)));
  };

  const resumeAll = () => elements.forEach(schedule);
  const pauseAll = () => elements.forEach(stopFor);

  // An element that never becomes visible is never started, so the six timers
  // on a phone are six timers that never exist rather than six that idle.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        if (entry.isIntersecting) {
          visible.add(el);
          schedule(el);
        } else {
          visible.delete(el);
          stopFor(el);
        }
      }
    },
    { rootMargin: "100px" },
  );
  elements.forEach((el) => observer.observe(el));

  const onVisibility = () => (document.hidden ? pauseAll() : resumeAll());
  document.addEventListener("visibilitychange", onVisibility);

  // Someone turning reduced-motion on mid-session should be obeyed immediately.
  const onMotionChange = () => (reduceMotion?.matches ? pauseAll() : resumeAll());
  reduceMotion?.addEventListener?.("change", onMotionChange);

  return () => {
    stopped = true;
    pauseAll();
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    reduceMotion?.removeEventListener?.("change", onMotionChange);
  };
}
