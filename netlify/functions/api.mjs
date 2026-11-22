/*
 * Ryzykownia: zapis i weryfikacja sesji gier (Netlify Functions + Netlify Blobs).
 *
 * Adresy:
 *   GET    /api/status                  czy serwer działa i czy ustawiono hasło prowadzącego (publiczne)
 *   POST   /api/save                    zapis sesji gry przez przeglądarkę studenta (publiczne)
 *   GET    /api/days                    dni, z których są zapisane sesje (hasło)
 *   GET    /api/sessions?day=RRRR-MM-DD lista sesji z jednego dnia, `day=all` wszystkie (hasło)
 *   GET    /api/session?key=...         pełny zapis jednej sesji (hasło)
 *   DELETE /api/session?key=...         usunięcie jednej sesji (hasło)
 *   POST   /api/delete {keys:[...]}     usunięcie wielu sesji naraz, do 1000 (hasło)
 *
 * Hasło prowadzącego ustawiasz w Netlify: Project configuration → Environment variables → ADMIN_PASSWORD.
 * Region danych: domyślnie eu-central-1 (Frankfurt). Zmienna BLOBS_REGION=auto zostawia wybór Netlify.
 */
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const MODES = ["cfd", "ru", "sl", "cn"];
const MAX_BODY = 5_000_000;
const TRAIL_MAX = 400;
const KEY_RE = /^s\/\d{4}-\d{2}-\d{2}\/\d{8}-[a-z0-9]{8,24}$/;

/* ---------- narzędzia ---------- */
function env(k) {
  try {
    if (globalThis.Netlify && Netlify.env && typeof Netlify.env.get === "function") {
      const v = Netlify.env.get(k);
      if (v !== undefined && v !== null && v !== "") return v;
    }
  } catch (e) { /* poza Netlify */ }
  const p = globalThis.process;
  return p && p.env ? p.env[k] : undefined;
}
function store() {
  const region = env("BLOBS_REGION") || "eu-central-1";
  const opts = { name: "ryzykownia-sesje", consistency: "strong" };
  if (region !== "auto") opts.region = region;
  return getStore(opts);
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (msg, status = 400) => json({ ok: false, error: msg }, status);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(+v) && v !== null && v !== "" ? +v : null);
const r2 = (v) => Math.round(v * 100) / 100;
const cleanStr = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
/* usuwa znaki < > ze wszystkich tekstów: panel prowadzącego wstawia część pól do HTML */
function deepClean(v, depth = 0) {
  if (depth > 8) return null;
  if (typeof v === "string") return v.replace(/[<>]/g, "").slice(0, 2000);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.map((x) => deepClean(x, depth + 1));
  if (typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[cleanStr(k, 40)] = deepClean(v[k], depth + 1);
    return o;
  }
  return null;
}
function safeEq(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
async function auth(req) {
  const pw = env("ADMIN_PASSWORD");
  if (!pw) return fail("Na serwerze nie ustawiono hasła prowadzącego (zmienna ADMIN_PASSWORD w Netlify).", 503);
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  let given = "";
  try { given = m ? decodeURIComponent(m[1].trim()) : ""; } catch (e) { given = ""; }
  if (!given || !safeEq(given, pw)) {
    await new Promise((r) => setTimeout(r, 600));
    return fail("Nieprawidłowe hasło prowadzącego.", 401);
  }
  return null;
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
const todayPL = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());

/* ---------- kontrola spójności zapisu ---------- */
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const ck = (nick, core, salt) => (hashStr(String(nick || "").trim().toLowerCase() + "|" + core + "|" + salt) % 1679616).toString(36).toUpperCase().padStart(4, "0");
const SALT = { cfd: "dz30", ru: "ru30", sl: "sl30", cn: "cn30" };
const zl = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(".", ",") + " zł";

function codeCheck(mode, p) {
  const parts = String(p.code || "").toUpperCase().split(".");
  if (parts.length !== 7) return { t: "Kod wyniku", ok: null, d: "brak kodu wyniku w zapisie" };
  const core = parts.slice(0, 6).join(".");
  const sumOk = ck(p.nick, core, SALT[mode]) === parts[6];
  const seedC = mode === "cfd" ? parts[0] : parts[1];
  const seedOk = seedC === String(p.seed || "").toUpperCase();
  const eqC = mode === "cn" ? +parts[3] / 100 : +parts[3];
  const eqP = mode === "cn" || mode === "ru" ? num(p.eq) : Math.round(num(p.eq));
  const eqOk = eqP !== null && Math.abs(eqC - eqP) <= (mode === "cn" ? 0.011 : 1);
  const ok = sumOk && seedOk && eqOk;
  return {
    t: "Kod wyniku pasuje do imienia, kodu gry i salda",
    ok,
    d: ok ? parts.join(".") : [!sumOk && "suma kontrolna nie pasuje do imienia", !seedOk && "inny kod gry", !eqOk && "saldo w kodzie inne niż w zapisie"].filter(Boolean).join(", "),
  };
}

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const A36 = Array.from({ length: 36 }, (_, i) => i + 1);
const rng = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const OUT = {
  red: A36.filter((n) => RED.has(n)), black: A36.filter((n) => !RED.has(n)),
  even: A36.filter((n) => n % 2 === 0), odd: A36.filter((n) => n % 2 === 1),
  low: rng(1, 18), high: rng(19, 36), d1: rng(1, 12), d2: rng(13, 24), d3: rng(25, 36),
  c1: A36.filter((n) => n % 3 === 1), c2: A36.filter((n) => n % 3 === 2), c3: A36.filter((n) => n % 3 === 0),
};
function betNums(k) {
  if (OUT[k]) return OUT[k];
  if (!/^n:\d{1,2}(-\d{1,2}){0,5}$/.test(k)) return null;
  const nums = k.slice(2).split("-").map(Number);
  if (![1, 2, 3, 4, 6].includes(nums.length) || nums.some((n) => n < 0 || n > 36)) return null;
  return nums;
}

function checkRu(p) {
  const S = Array.isArray(p.s) ? p.s : [], items = [], cap = num(p.cap), n = num(p.n);
  const trunc = S.length >= 20000;
  const rnd = mulberry32(hashStr("ru30|" + p.seed));
  let badN = -1;
  for (let i = 0; i < S.length; i++) { const x = Math.floor(rnd() * 37); if (!Array.isArray(S[i]) || S[i][0] !== x) { badN = i; break; } }
  items.push({ t: "Wylosowane liczby zgodne z generatorem stołu", ok: S.length ? badN < 0 : null, d: badN < 0 ? `odtworzono ${S.length} spinów z kodu stołu ${p.seed}` : `liczba w spinie ${badN + 1} nie pochodzi z generatora stołu` });
  let badP = -1, badS = -1, badB = -1, bal = cap ?? 0, wag = 0;
  for (let i = 0; i < S.length; i++) {
    const [x, tot, ret, bs] = Array.isArray(S[i]) ? S[i] : [];
    let sum = 0, exp = 0, broken = false;
    for (const b of String(bs || "").split(",").filter(Boolean)) {
      const [k, a] = b.split("="), amt = +a, nums = betNums(k);
      if (!nums || !(amt > 0)) { broken = true; break; }
      sum += amt; if (nums.includes(x)) exp += (amt * 36) / nums.length;
    }
    if ((broken || Math.abs(sum - tot) > 1e-6) && badS < 0) badS = i;
    if ((broken || Math.abs(exp - ret) > 1e-6) && badP < 0) badP = i;
    if (tot > bal + 1e-6 && badB < 0) badB = i;
    bal += (+ret || 0) - (+tot || 0); wag += +tot || 0;
  }
  if (S.length) {
    items.push({ t: "Wypłaty zgodne z zasadami ruletki", ok: badP < 0, d: badP < 0 ? "każda wypłata policzona poprawnie" : `błędna wypłata w spinie ${badP + 1}` });
    items.push({ t: "Stawki zgodne z położonymi żetonami", ok: badS < 0 && badB < 0, d: badS >= 0 ? `suma żetonów nie zgadza się w spinie ${badS + 1}` : badB >= 0 ? `w spinie ${badB + 1} postawiono więcej niż saldo` : "w porządku" });
  }
  if (!trunc) {
    items.push({ t: "Liczba spinów zgodna z historią", ok: n === S.length, d: `zgłoszono ${n}, w historii ${S.length}` });
    items.push({ t: "Saldo zgodne z historią spinów", ok: Math.abs(Math.round(bal) - num(p.eq)) <= 1, d: `z historii ${zl(bal)}, zgłoszono ${zl(num(p.eq))}` });
    if (p.wag != null) items.push({ t: "Suma stawek zgodna z historią", ok: Math.abs(wag - num(p.wag)) <= 1, d: `z historii ${zl(wag)}, zgłoszono ${zl(num(p.wag))}` });
  } else items.push({ t: "Historia ucięta", ok: null, d: "ponad 20 000 spinów, salda nie da się przeliczyć w całości" });
  return items;
}

function checkCn(p) {
  const S = Array.isArray(p.s) ? p.s : [], items = [], n = num(p.n);
  const lim = p.capOn === false ? Infinity : num(p.limit) || 250;
  const rnd = mulberry32(hashStr("cn30|" + p.seed));
  let badO = -1, badB = -1, bal = num(p.cap) ?? 25;
  for (let i = 0; i < S.length; i++) {
    const [bg, sd, out] = Array.isArray(S[i]) ? S[i] : [];
    const o = rnd() < 0.6 ? 1 : 0;
    if (out !== o && badO < 0) badO = i;
    const b = (+bg || 0) / 100;
    if ((b <= 0 || b > bal + 0.005) && badB < 0) badB = i;
    bal = r2(bal + (sd === out ? b : -b));
    if (bal >= lim - 0.005) bal = Math.min(bal, lim);
    if (bal < 0.01) bal = 0;
  }
  items.push({ t: "Rzuty zgodne z generatorem monety", ok: S.length ? badO < 0 : null, d: badO < 0 ? `odtworzono ${S.length} rzutów z kodu ${p.seed}` : `wynik rzutu ${badO + 1} nie pochodzi z generatora` });
  if (S.length) items.push({ t: "Stawki w granicach salda", ok: badB < 0, d: badB < 0 ? "w porządku" : `niedozwolona stawka w rzucie ${badB + 1}` });
  if (S.length < 20000) {
    items.push({ t: "Liczba rzutów zgodna z historią", ok: n === S.length, d: `zgłoszono ${n}, w historii ${S.length}` });
    items.push({ t: "Saldo zgodne z historią rzutów", ok: Math.abs(bal - num(p.eq)) <= 0.011, d: `z historii ${zl(bal)}, zgłoszono ${zl(num(p.eq))}` });
  }
  return items;
}

function checkSl(p) {
  const S = Array.isArray(p.s) ? p.s : [], items = [], cr = num(p.cr) || 0.1;
  if (S.length >= 7900) return [{ t: "Historia ucięta", ok: null, d: "ponad 7 900 zapisów, salda nie da się przeliczyć w całości" }];
  let bal = num(p.cap) ?? 0, paid = 0, wag = 0;
  for (const x of S) {
    const [b, w, f] = Array.isArray(x) ? x : [];
    bal += ((+w || 0) - (+b || 0)) * cr;
    if (!(f & 32) && !(f & 128)) { paid++; wag += (+b || 0) * cr; }
  }
  items.push({ t: "Liczba gier zgodna z historią", ok: paid === num(p.n), d: `zgłoszono ${num(p.n)}, w historii ${paid}` });
  items.push({ t: "Saldo zgodne z historią spinów", ok: Math.abs(bal - num(p.eq)) <= 0.02 + 0.0005 * S.length, d: `z historii ${zl(bal)}, zgłoszono ${zl(num(p.eq))}` });
  if (p.wag != null) items.push({ t: "Suma stawek zgodna z historią", ok: Math.abs(wag - num(p.wag)) <= 0.02 + 0.0005 * S.length, d: `z historii ${zl(wag)}, zgłoszono ${zl(num(p.wag))}` });
  return items;
}

function checkCfd(p) {
  const H = Array.isArray(p.h) ? p.h : [], P = Array.isArray(p.pos) ? p.pos : [], items = [];
  let eq = (num(p.cap) ?? 0) + (num(p.nbp) || 0);
  for (const x of H) eq += num(x && x[10]) || 0;
  for (const x of P) eq += (num(x && x[4]) || 0) - (num(x && x[5]) || 0);
  const tol = 0.05 + 0.011 * H.length + 0.6 * P.length;
  items.push({ t: "Kapitał zgodny z historią transakcji", ok: Math.abs(eq - num(p.eq)) <= tol, d: `z historii ${zl(eq)}, zgłoszono ${zl(num(p.eq))}${P.length ? ` (z ${P.length} otwartymi pozycjami)` : ""}` });
  let badT = -1, prev = -Infinity;
  const t0 = num(p.t0), t1 = num(p.t1);
  for (let i = 0; i < H.length; i++) {
    const ot = num(H[i][5]), ct = num(H[i][6]);
    if (ot === null || ct === null || ot > ct || ct < prev || (t0 !== null && ot < t0) || (t1 !== null && ct > t1)) { badT = i; break; }
    prev = ct;
  }
  if (H.length) items.push({ t: "Kolejność transakcji w czasie rynku", ok: badT < 0, d: badT < 0 ? `${H.length} zamkniętych pozycji w poprawnej kolejności` : `transakcja ${badT + 1} ma niemożliwe czasy` });
  if (num(p.tr) !== null) items.push({ t: "Liczba transakcji zgodna z historią", ok: num(p.tr) >= P.length && num(p.tr) >= 0, d: `otwarte: ${num(p.tr)}, zamknięcia: ${H.length}, otwarte teraz: ${P.length}` });
  return items;
}

function runChecks(mode, p) {
  let items = [];
  try {
    items = mode === "ru" ? checkRu(p) : mode === "cn" ? checkCn(p) : mode === "sl" ? checkSl(p) : checkCfd(p);
  } catch (e) {
    items = [{ t: "Kontrola zapisu", ok: false, d: "nie udało się przeliczyć: " + String(e && e.message || e).slice(0, 120) }];
  }
  items.push(codeCheck(mode, p));
  const bad = items.filter((x) => x.ok === false);
  return { ok: bad.length ? false : items.some((x) => x.ok === true) ? true : null, items, msg: bad.map((x) => x.t).join("; ").slice(0, 200) };
}

/* ---------- zapis sesji ---------- */
function meta(rec) {
  const p = rec.payload || {};
  const flags = Object.keys(rec.flags || {});
  return {
    sid: rec.sid, cid: rec.cid, mode: rec.mode, nick: rec.nick, seed: rec.seed, status: rec.status,
    cap: num(p.cap), eq: num(p.eq), n: rec.mode === "cfd" ? num(p.tr) : num(p.n), wag: num(p.wag), dd: num(p.dd),
    code: cleanStr(p.code, 80), mach: cleanStr(p.machName, 40), mart: !!p.mart,
    start: rec.startedAt, firstSeen: rec.firstSeen, updatedAt: rec.updatedAt, doneAt: rec.doneAt, saves: rec.saves,
    chk: rec.check ? rec.check.ok : null, chkMsg: rec.check ? rec.check.msg : "", flags,
  };
}

async function save(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) return fail("Za duży zapis.", 413);
  let b;
  try { b = JSON.parse(text); } catch (e) { return fail("Niepoprawny JSON."); }
  if (!b || typeof b !== "object") return fail("Pusty zapis.");
  const sid = String(b.sid || "");
  if (!/^\d{8}-[a-z0-9]{8,24}$/.test(sid)) return fail("Niepoprawny identyfikator sesji.");
  const mode = String(b.mode || "");
  if (!MODES.includes(mode)) return fail("Nieznany tryb gry.");
  if (!b.payload || typeof b.payload !== "object" || b.payload.m !== mode) return fail("Brak danych gry.");
  const cid = /^[a-z0-9]{8,32}$/.test(String(b.cid || "")) ? String(b.cid) : "";
  const day = `${sid.slice(0, 4)}-${sid.slice(4, 6)}-${sid.slice(6, 8)}`;
  const dts = Date.parse(day + "T12:00:00Z");
  if (!Number.isFinite(dts)) return fail("Niepoprawna data sesji.");
  const key = `s/${day}/${sid}`;
  const st = store();
  const prev = await st.get(key, { type: "json" });
  const now = new Date().toISOString();
  if (!prev && Math.abs(Date.now() - dts) > 3 * 864e5) return fail("Data sesji nie zgadza się z datą serwera.");
  if (prev && prev.cid && cid && prev.cid !== cid) return fail("Ta sesja należy do innego urządzenia.", 409);

  const p = deepClean(b.payload);
  p.m = mode;
  const status = b.status === "done" ? "done" : "play";
  const nick = cleanStr(p.nick, 40);
  const seed = cleanStr(p.seed, 16).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nNow = mode === "cfd" ? num(p.tr) : num(p.n);

  /* zakończona sesja jest zamknięta: późniejsze zmiany wyniku tylko odnotowujemy */
  if (prev && prev.status === "done") {
    const pp = prev.payload || {};
    const pn = mode === "cfd" ? num(pp.tr) : num(pp.n);
    if (num(p.eq) !== num(pp.eq) || nNow !== pn) {
      prev.flags = { ...(prev.flags || {}), zmianaPoKoncu: now };
      prev.lateSaves = (prev.lateSaves || 0) + 1;
      prev.trail = [...(prev.trail || []), [now, nNow, num(p.eq), "po zakończeniu"]].slice(-TRAIL_MAX);
      prev.updatedAt = now;
      await st.setJSON(key, prev, { metadata: meta(prev) });
    }
    return json({ ok: true, locked: true, saves: prev.saves, updatedAt: prev.updatedAt });
  }

  const flags = { ...((prev && prev.flags) || {}) };
  if (prev) {
    const pp = prev.payload || {};
    const pn = mode === "cfd" ? num(pp.tr) : num(pp.n);
    if (nNow !== null && pn !== null && nNow < pn) flags.cofniecieHistorii = now;
    if (prev.nick && prev.nick !== nick) flags.zmianaImienia = `${prev.nick} → ${nick}`;
    if (prev.seed && prev.seed !== seed) flags.zmianaKoduGry = `${prev.seed} → ${seed}`;
  }
  /* godzina startu z przeglądarki, ale nie później niż pierwszy zapis i nie wcześniej niż 12 h przed nim */
  const firstSeen = (prev && prev.firstSeen) || now;
  const fsT = Date.parse(firstSeen), saT = typeof b.startedAt === "string" ? Date.parse(b.startedAt) : NaN;
  const startedAt = Number.isFinite(saT) && saT <= fsT + 60e3 && saT >= fsT - 12 * 36e5 ? new Date(saT).toISOString() : firstSeen;
  const rec = {
    v: 1, key, sid, cid: (prev && prev.cid) || cid, mode, nick, seed, status,
    startedAt: (prev && prev.startedAt) || startedAt,
    firstSeen,
    updatedAt: now,
    doneAt: status === "done" ? now : null,
    saves: ((prev && prev.saves) || 0) + 1,
    trail: [...((prev && prev.trail) || []), [now, nNow, num(p.eq), status]].slice(-TRAIL_MAX),
    flags,
    check: runChecks(mode, p),
    payload: p,
  };
  await st.setJSON(key, rec, { metadata: meta(rec) });
  return json({ ok: true, saves: rec.saves, updatedAt: now, check: rec.check.ok });
}

/* ---------- odczyt dla prowadzącego ---------- */
async function days() {
  const { directories } = await store().list({ prefix: "s/", directories: true });
  const out = (directories || []).map((d) => d.replace(/^s\//, "").replace(/\/$/, "")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  return json({ ok: true, today: todayPL(), days: out });
}
async function sessions(url) {
  let day = url.searchParams.get("day") || "today";
  if (day === "today") day = todayPL();
  if (day !== "all" && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail("Niepoprawna data.");
  const st = store();
  const { blobs } = await st.list({ prefix: day === "all" ? "s/" : `s/${day}/` });
  const keys = (blobs || []).map((b) => b.key).filter((k) => KEY_RE.test(k));
  const items = await pool(keys, 16, async (key) => {
    const m = await st.getMetadata(key);
    return m && m.metadata ? { key, ...m.metadata } : null;
  });
  return json({ ok: true, day, today: todayPL(), items: items.filter(Boolean) });
}
async function removeMany(req) {
  let b;
  try { b = JSON.parse(await req.text()); } catch (e) { return fail("Niepoprawny JSON."); }
  const keys = [...new Set(Array.isArray(b && b.keys) ? b.keys.map(String) : [])];
  if (!keys.length) return fail("Nie wybrano sesji do usunięcia.");
  if (keys.length > 1000) return fail("Najwyżej 1000 sesji naraz.");
  if (!keys.every((k) => KEY_RE.test(k))) return fail("Niepoprawny klucz sesji.");
  const st = store();
  await pool(keys, 16, (k) => st.delete(k));
  return json({ ok: true, deleted: keys.length });
}
async function session(req, url) {
  const key = url.searchParams.get("key") || "";
  if (!KEY_RE.test(key)) return fail("Niepoprawny klucz sesji.");
  const st = store();
  if (req.method === "DELETE") { await st.delete(key); return json({ ok: true, deleted: key }); }
  const rec = await st.get(key, { type: "json" });
  if (!rec) return fail("Nie ma takiej sesji.", 404);
  return json({ ok: true, record: rec });
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  try {
    if (route === "status" && req.method === "GET")
      return json({ ok: true, app: "ryzykownia", admin: !!env("ADMIN_PASSWORD"), time: new Date().toISOString(), today: todayPL() });
    if (route === "save" && req.method === "POST") return await save(req);
    if (route === "days" && req.method === "GET") return (await auth(req)) || (await days());
    if (route === "sessions" && req.method === "GET") return (await auth(req)) || (await sessions(url));
    if (route === "delete" && req.method === "POST") return (await auth(req)) || (await removeMany(req));
    if (route === "session" && (req.method === "GET" || req.method === "DELETE")) return (await auth(req)) || (await session(req, url));
    return fail("Nie ma takiego adresu.", 404);
  } catch (e) {
    return fail("Błąd serwera: " + String((e && e.message) || e).slice(0, 300), 500);
  }
};
