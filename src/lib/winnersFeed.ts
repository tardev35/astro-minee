/**
 * The rolling "latest transactions" feed, shared by every LatestWinners*
 * variant.
 *
 * ── WHY THIS IS NOT INLINE IN THE COMPONENT ─────────────────────────────────
 * Every variant used to carry `<script define:vars={{ bankPool }}>`.
 * define:vars forces `is:inline`, which strips type/async/defer — so the
 * result was a parser-blocking <script> sitting about 80% of the way down the
 * document, running several innerHTML builds and prepends synchronously before
 * the parser could continue.
 *
 * It also rendered the feed container EMPTY in the HTML and filled it from JS,
 * which means the rows were invisible to a crawler, invisible with JS
 * disabled, and guaranteed to shift the layout when they appeared. And the
 * setInterval had no stop condition: it ran forever, background tabs included.
 *
 * The rows are server-rendered now and this module only takes over the
 * updating, gated on the feed being on screen and the tab being visible. With
 * no JS the page keeps the rows it shipped with.
 *
 * ── WHERE THE CONFIGURATION LIVES ───────────────────────────────────────────
 * On the markup, not in this file. The feed element carries `data-*` for the
 * numbers (interval, row cap, amount range) and each row carries `data-*` for
 * its own text and classes. That is deliberate: a rebrand rewrites the
 * component and never opens src/lib, so anything it might want to change has
 * to be reachable from the component. It also means adding the seventh variant
 * needs no edit here at all.
 *
 * Bank list and (for the lottery variant) market list arrive as
 * `<script type="application/json">` — inert data the parser skips, so it
 * costs nothing and does not force an inline script.
 */

export interface BankEntry {
  name: string;
  /** Utility class for the badge behind the logo. */
  color: string;
  /** Resolved image path. */
  icon: string;
}

export interface WinnersFeedOptions {
  feedSelector?: string;
  /** Element holding the JSON bank list. */
  dataSelector?: string;
  /** Optional JSON list of pre-formatted market labels (lottery variant). */
  marketSelector?: string;
  /** Element whose markup is cloned for each new row. */
  rowSelector?: string;
  /** Fallbacks only — `data-interval` / `data-max-rows` on the feed win. */
  intervalMs?: number;
  maxRows?: number;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";

const randomFrom = (chars: string, length: number) =>
  Array.from({ length })
    .map(() => chars.charAt(Math.floor(Math.random() * chars.length)))
    .join("");

const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

/** The same shapes the server rendered, so a JS row is indistinguishable.
 *  `phone` produces 08***1234 / 09***1234; `letters` produces ab***1234. */
export function randomUser(style: "letters" | "phone" = "letters", digits = 4): string {
  const head = style === "phone" ? `0${randomFrom("89", 1)}` : randomFrom(LETTERS, 2);
  return `${head}***${digits > 0 ? randomFrom(DIGITS, digits) : ""}`;
}

export function randomAmount(min = 15000, max = 95000): string {
  return randomInt(min, max).toLocaleString("en-US");
}

const num = (el: HTMLElement, name: string, fallback: number) => {
  const raw = el.dataset[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readJson = <T>(selector: string | undefined): T[] => {
  if (!selector) return [];
  const el = document.querySelector<HTMLScriptElement>(selector);
  if (!el) return [];
  try {
    const parsed = JSON.parse(el.textContent || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** Swap one class list for another without disturbing the rest of the element.
 *  The two lists come from the row's own data-* attributes, so the component
 *  keeps every Tailwind class it uses in its own markup — which is also what
 *  keeps Tailwind's scanner able to see them. */
const swapClasses = (el: HTMLElement, remove: string, add: string) => {
  for (const c of remove.split(/\s+/)) if (c) el.classList.remove(c);
  for (const c of add.split(/\s+/)) if (c) el.classList.add(c);
};

export function startWinnersFeed(options: WinnersFeedOptions = {}): () => void {
  const {
    feedSelector = "[data-winners-feed]",
    dataSelector = "[data-winners-banks]",
    marketSelector = "[data-winners-markets]",
    rowSelector = "[data-winner-row]",
    intervalMs = 4000,
    maxRows = 5,
  } = options;

  const feed = document.querySelector<HTMLElement>(feedSelector);
  if (!feed) return () => {};

  const banks = readJson<BankEntry>(dataSelector);
  if (banks.length === 0) return () => {};
  const markets = readJson<string>(marketSelector);

  const template = feed.querySelector<HTMLElement>(rowSelector);
  if (!template) return () => {};

  // Everything below is read once, from the markup the component shipped.
  const interval = num(feed, "interval", intervalMs);
  const cap = num(feed, "maxRows", maxRows);
  const amountMin = num(feed, "amountMin", 15000);
  const amountMax = num(feed, "amountMax", 95000);
  const pendingChance = num(feed, "pendingChance", 0.4);
  const userDigits = num(feed, "userDigits", 4);
  const userStyle = feed.dataset.userStyle === "phone" ? "phone" : "letters";
  const scatter = feed.dataset.insert === "scatter";
  const bigWinAbove = num(feed, "bigWinAbove", Number.POSITIVE_INFINITY);

  // The HUD counters continue from what the server rendered rather than
  // resetting to zero the moment JS runs — otherwise the page visibly counts
  // down from a real figure to ฿0 before climbing again.
  const totalEl = document.querySelector<HTMLElement>("[data-winners-total]");
  const countEl = document.querySelector<HTMLElement>("[data-winners-count]");
  let runningTotal = totalEl ? num(totalEl, "seed", 0) : 0;
  let runningCount = countEl ? num(countEl, "seed", 0) : 0;

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  let timer: number | undefined;
  let onScreen = false;

  const buildRow = (): HTMLElement => {
    // Clone a row the server already rendered rather than assembling HTML from
    // a string. The markup and its classes then live in exactly one place —
    // the component — so a rebrand restyling the row does not have to find and
    // update a matching template hidden in a script.
    const row = template.cloneNode(true) as HTMLElement;
    const bank = banks[Math.floor(Math.random() * banks.length)];
    const pending = Math.random() < pendingChance;
    const amount = randomInt(amountMin, amountMax);

    const badge = row.querySelector<HTMLElement>("[data-winner-bank]");
    if (badge) {
      for (const cls of [...badge.classList]) {
        if (cls.startsWith("bg-[")) badge.classList.remove(cls);
      }
      badge.classList.add(bank.color);
    }

    const icon = row.querySelector<HTMLImageElement>("[data-winner-icon]");
    if (icon) {
      icon.src = bank.icon;
      icon.alt = "";
    }

    const user = row.querySelector<HTMLElement>("[data-winner-user]");
    if (user) user.textContent = randomUser(userStyle, userDigits);

    const amountEl = row.querySelector<HTMLElement>("[data-winner-amount]");
    if (amountEl) amountEl.textContent = amount.toLocaleString("en-US");

    const ref = row.querySelector<HTMLElement>("[data-winner-ref]");
    if (ref) ref.textContent = randomFrom(DIGITS, num(ref, "refLength", 8));

    const time = row.querySelector<HTMLElement>("[data-winner-time]");
    if (time) {
      const d = new Date();
      time.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    }

    const market = row.querySelector<HTMLElement>("[data-winner-market]");
    if (market && markets.length > 0) market.textContent = markets[Math.floor(Math.random() * markets.length)];

    const status = row.querySelector<HTMLElement>("[data-winner-status]");
    if (status) {
      status.textContent = (pending ? status.dataset.pendingText : status.dataset.doneText) ?? status.textContent;
      const pendingClass = status.dataset.pendingClass ?? "is-pending";
      const doneClass = status.dataset.doneClass ?? "is-verified";
      swapClasses(status, pending ? doneClass : pendingClass, pending ? pendingClass : doneClass);
    }

    // Elements that react to the row's own value — the "big withdrawal" look.
    // Any number of them; each says for itself which classes and which text it
    // wants in either state. With no data-big-win-above on the feed the
    // threshold is Infinity, so a variant that has no such state pays nothing.
    const isBig = amount > bigWinAbove;
    for (const el of row.querySelectorAll<HTMLElement>("[data-winner-big]")) {
      const normal = el.dataset.normalClass ?? "";
      const bigClass = el.dataset.bigClass ?? "";
      swapClasses(el, isBig ? normal : bigClass, isBig ? bigClass : normal);
      const text = isBig ? el.dataset.bigText : el.dataset.normalText;
      if (text !== undefined) el.textContent = text;
    }

    runningTotal += amount;
    runningCount += 1;
    if (totalEl) totalEl.textContent = `${totalEl.dataset.prefix ?? ""}${runningTotal.toLocaleString("en-US")}`;
    if (countEl) countEl.textContent = runningCount.toLocaleString("en-US");

    return row;
  };

  const push = () => {
    const row = buildRow();
    if (!reduceMotion?.matches) row.classList.add("is-entering");

    // "scatter" drops the new row somewhere near the front instead of always
    // at index 0 — the pill-cloud variant reads as a crowd rather than a
    // queue, and a strict prepend makes it look like a single column moving.
    const at = scatter && feed.children.length > 0 ? feed.children[Math.floor(Math.random() * Math.min(3, feed.children.length))] : feed.firstChild;
    feed.insertBefore(row, at);

    if (!reduceMotion?.matches) {
      requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove("is-entering")));
    }
    while (feed.children.length > cap) feed.lastElementChild?.remove();
  };

  const start = () => {
    if (timer !== undefined || !onScreen || document.hidden) return;
    timer = window.setInterval(push, interval);
  };
  const stop = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const observer = new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen) start();
      else stop();
    },
    { rootMargin: "200px" },
  );
  observer.observe(feed);

  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    stop();
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
