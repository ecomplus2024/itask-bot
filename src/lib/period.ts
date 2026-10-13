// Deterministic relative-date resolver. Bots hand the user's raw time
// phrase to itask__resolve_period and CODE — not the model — computes
// the exact [from, to] range in Asia/Ho_Chi_Minh. The model can never
// mis-derive "hôm qua" into last month again; it just uses the result.

const TZ = "Asia/Ho_Chi_Minh";
const DAY = 86400000;

export interface Period {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  label: string; // human-readable, e.g. "hôm qua — 12/10/2026"
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const vi = (d: Date) => iso(d).split("-").reverse().join("/");

/** Parses dd/mm(/yyyy), dd.mm.yyyy, yyyy-mm-dd out of a phrase. */
function parseDate(s: string, today: Date): Date | null {
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?/);
  if (m) {
    const day = +m[1];
    const mon = +m[2];
    // "9/2025" is a month/year, not a date — reject out-of-range fields
    // so named patterns ("tháng 9/2025") get their chance.
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    let y = m[3] ? +m[3] : today.getUTCFullYear();
    if (y < 100) y += 2000;
    // No year given + a month still ahead → most likely last year.
    if (!m[3] && mon > today.getUTCMonth() + 1) y -= 1;
    const d = new Date(Date.UTC(y, mon - 1, day));
    if (isNaN(d.getTime()) || d.getUTCMonth() !== mon - 1) return null;
    return d;
  }
  return null;
}

export function resolvePeriod(input: string): Period | null {
  const e = norm(input);
  if (!e) return null;

  const today = new Date(
    new Date().toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 10) +
      "T00:00:00Z"
  );
  const at = (n: number) => new Date(today.getTime() + n * DAY);
  const one = (d: Date): Period => ({
    from: iso(d),
    to: iso(d),
    label: vi(d),
  });
  const span = (a: Date, b: Date, label: string): Period => ({
    from: iso(a),
    to: iso(b),
    label: `${label} — ${vi(a)} → ${vi(b)}`,
  });

  // ── Explicit ranges & dates ────────────────────────────────────
  const rng = e.match(
    /(?:tu|from)\s+(.+?)\s+(?:den|toi|->|to)\s+(.+)$/
  );
  if (rng) {
    const a = parseDate(rng[1], today);
    const b = parseDate(rng[2], today);
    if (a && b)
      return {
        from: iso(a),
        to: iso(b),
        label: `${vi(a)} → ${vi(b)}`,
      };
  }
  const explicit = parseDate(e, today);
  if (explicit) return one(explicit);

  // ── Single days ────────────────────────────────────────────────
  let m = e.match(/(\d{1,3})\s*ngay\s+truoc/);
  if (m) return one(at(-+m[1]));
  // "ngày mai" before "nay" — "mai nay" means tomorrow morning.
  if (/ngay mai|tomorrow/.test(e)) return one(at(1));
  if (/hom qua|yesterday/.test(e)) return one(at(-1));
  if (/hom kia/.test(e)) return one(at(-2));
  // No bare "\bnay\b" here — "tuần/tháng/năm nay" must reach the
  // multi-word rules below first; a trailing bare "nay" is handled
  // at the very end.
  if (/hom nay|today/.test(e)) return one(today);

  // ── Last N days / vague "recently" ─────────────────────────────
  m =
    e.match(/(\d{1,3})\s*ngay\s*(?:qua|gan day|vua qua|tro lai|nay)/) ||
    e.match(/last\s+(\d{1,3})\s+days?/);
  if (m) {
    const n = Math.max(1, +m[1]);
    return span(at(-(n - 1)), today, `${n} ngày qua`);
  }
  if (/may ngay|vai ngay|gan day/.test(e))
    return span(at(-6), today, "7 ngày qua");

  // ── Parts of this month (before generic month rules) ──────────
  const y0 = today.getUTCFullYear();
  const mo0 = today.getUTCMonth();
  const monthFirst = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
  const monthLast = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0));
  if (/dau thang/.test(e))
    return span(monthFirst(y0, mo0), new Date(Date.UTC(y0, mo0, 15)), "đầu tháng");
  if (/cuoi thang/.test(e))
    return span(new Date(Date.UTC(y0, mo0, 16)), monthLast(y0, mo0), "cuối tháng");

  // ── Weeks ──────────────────────────────────────────────────────
  const dow = (today.getUTCDay() + 6) % 7; // Mon = 0
  // "cuối tuần" before "tuần này" — "cuối tuần này" contains it.
  if (/cuoi tuan|weekend/.test(e))
    return /nay\b/.test(e)
      ? span(at(5 - dow), at(6 - dow), "cuối tuần này")
      : span(at(-dow - 2), at(-dow - 1), "cuối tuần trước");
  // "2 tuần trước" = last 2 weeks — count before plain "tuần trước".
  m = e.match(/(\d{1,2})\s*tuan\s*(?:qua|truoc|gan day|vua qua)/);
  if (m) {
    const n = Math.max(1, +m[1]);
    return span(at(-(n * 7 - 1)), today, `${n} tuần qua`);
  }
  if (/tuan truoc|tuan roi|tuan vua qua|last week/.test(e))
    return span(at(-dow - 7), at(-dow - 1), "tuần trước");
  if (/tuan nay|tuan hien tai|this week/.test(e))
    return span(at(-dow), today, "tuần này");

  // ── Months ─────────────────────────────────────────────────────
  // "3 tháng trước" = last 3 months — count before plain "tháng trước".
  m = e.match(/(\d{1,2})\s*thang\s*(?:qua|truoc|gan day|vua qua)/);
  if (m) {
    const n = Math.max(1, +m[1]);
    return span(monthFirst(y0, mo0 - n), today, `${n} tháng qua`);
  }
  if (/thang truoc|thang roi|thang vua qua|last month/.test(e))
    return span(monthFirst(y0, mo0 - 1), monthLast(y0, mo0 - 1), "tháng trước");
  if (/thang nay|thang hien tai|this month/.test(e))
    return span(monthFirst(y0, mo0), today, "tháng này");
  m = e.match(/thang\s+(\d{1,2})(?:\s*[\/.-]?\s*(\d{4}))?/);
  if (m) {
    const mon = +m[1];
    if (mon < 1 || mon > 12) return null;
    let y = m[2] ? +m[2] : y0;
    if (!m[2] && mon > mo0 + 1) y -= 1;
    return span(monthFirst(y, mon - 1), monthLast(y, mon - 1), `tháng ${mon}/${y}`);
  }

  // ── Quarters ───────────────────────────────────────────────────
  const q = Math.floor(mo0 / 3);
  if (/quy truoc|quy roi|last quarter/.test(e)) {
    let qm = (q - 1) * 3;
    let y = y0;
    if (qm < 0) {
      qm += 12;
      y -= 1;
    }
    return span(monthFirst(y, qm), monthLast(y, qm + 2), "quý trước");
  }
  if (/quy nay|this quarter/.test(e))
    return span(monthFirst(y0, q * 3), today, `quý ${q + 1}`);

  // ── Years ──────────────────────────────────────────────────────
  if (/nam truoc|nam roi|nam ngoai|last year/.test(e))
    return span(monthFirst(y0 - 1, 0), monthLast(y0 - 1, 11), "năm trước");
  if (/nam nay|this year/.test(e))
    return span(monthFirst(y0, 0), today, "năm nay");
  m = e.match(/nam\s+(\d{4})/);
  if (m) {
    const y = +m[1];
    return span(monthFirst(y, 0), monthLast(y, 11), `năm ${y}`);
  }

  // Bare trailing "nay" — safe now that "tuần/tháng/năm nay" already
  // returned above ("doanh thu nay" → today).
  if (/\bnay\b/.test(e)) return one(today);

  return null;
}
