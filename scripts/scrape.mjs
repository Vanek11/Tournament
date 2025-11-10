import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const players = JSON.parse(await fs.readFile("data/players.json", "utf-8"));
const outDir = "stats";
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ["--disable-blink-features=AutomationControlled"]
});
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  locale: "ru-RU",
  timezoneId: "Europe/Moscow",
  viewport: { width: 1366, height: 900 }
});
const page = await ctx.newPage();

function norm(v) {
  if (v == null) return null;
  const n = Number(String(v).replace("%","").replace(/\u00A0/g," ").replace(/\s+/g,"").replace(",","."));
  return Number.isFinite(n) ? n : null;
}

function cook(p, s) {
  const battles = s.battles || 0;
  const wins = s.wins ?? null;
  return {
    accountId: p.accountId,
    nickname: s.nickname || p.nickname || "",
    global_rating: s.rating || 0,
    battles,
    wins,
    winRate: s.winRate ?? (battles && wins!=null ? (wins/battles*100) : 0),
    avgDmg: s.avgDmg ?? 0,
    avgFrags: s.avgFrags ?? null,
    surviveRate: s.survive ?? null,
    hitsPercents: s.hits ?? null,
    fetchedAt: new Date().toISOString()
  };
}

function parseFromHtml(html, profileUrl) {
  const nickFromUrl = decodeURIComponent(profileUrl).split("/").filter(Boolean).pop()?.split("-").slice(1).join("-") || "";
  const nickname = (html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1] || nickFromUrl).trim();
  const rxPair = (label) => new RegExp(`(?:<dt[^>]*>${label}<\\/dt>\\s*<dd[^>]*>|${label}[^0-9%]{0,40})([0-9\\s.,%]+)`, "i");
  const battles  = norm((html.match(rxPair("(?:Бои|Сражения|Баталии)"))||[])[1]) || 0;
  const wins     = norm((html.match(rxPair("Победы(?![^%]*%)"))||[])[1]);
  const wrTxt    =       (html.match(rxPair("(?:Процент побед|Победы[, \\t\\r\\n]*%)"))||[])[1];
  const winRate  = wrTxt ? norm(wrTxt) : (battles && wins!=null ? (wins/battles*100) : null);
  const avgDmg   = norm((html.match(rxPair("Средн(?:ий|яя)?\\s*урон"))||[])[1]);
  const avgFrags = norm((html.match(rxPair("(?:Ср\\.?\\s*фраги|Средн(?:ее|их)?\\s*уничтожен)"))||[])[1]);
  const survive  = norm((html.match(rxPair("(?:Выживаемость|Процент выживаемости)"))||[])[1]);
  const hits     = norm((html.match(rxPair("(?:Попадания[, \\t\\r\\n]*%|Процент попаданий)"))||[])[1]);
  const rating   = norm((html.match(rxPair("(?:WTR|GR|Рейтинг|РЭ)"))||[])[1]);
  return { nickname, battles, wins, winRate, avgDmg, avgFrags, survive, hits, rating };
}

for (const p of players) {
  let out;
  try {
    await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("h1, dt, dd", { timeout: 30000 });

    const s = await page.evaluate(() => {
      const txt = s => (s||"").replace(/\u00A0/g," ").trim();
      const norm = v => {
        if (v == null) return null;
        const n = Number(String(v).replace("%","").replace(/\s+/g,"").replace(",","."));
        return Number.isFinite(n) ? n : null;
      };
      const pairs = Array.from(document.querySelectorAll("dt,dd"));
      const map = {};
      for (let i=0;i<pairs.length-1;i++){
        if (pairs[i].tagName==="DT" && pairs[i+1].tagName==="DD") {
          map[txt(pairs[i].textContent)] = txt(pairs[i+1].textContent);
        }
      }
      const pick = re => {
        const k = Object.keys(map).find(k => re.test(k));
        return k ? map[k] : null;
      };
      const nickname = txt(document.querySelector("h1")?.textContent);
      const battles = norm(pick(/Бои|Сражения|Баталии/i));
      const wins = norm(pick(/Победы(?!.*%)/i));
      const wr = norm(pick(/Процент побед|Победы.*%/i));
      const avgDmg = norm(pick(/Средн.*урон/i));
      const avgFrags = norm(pick(/Ср\.?\s*фраги|Средн.*уничтожен/i));
      const survive = norm(pick(/Выживаемость|Процент выживаемости/i));
      const hits = norm(pick(/Попадания.*%|Процент попаданий/i));
      const rating = norm(pick(/WTR|GR|Рейтинг|РЭ/i));
      return { nickname, battles, wins, winRate: wr, avgDmg, avgFrags, survive, hits, rating };
    });

    // если совсем пусто — считаем это ошибкой, пойдём на фоллбэк
    if (!s || (!s.battles && !s.winRate && !s.avgDmg)) throw new Error("Empty page or blocked");
    out = cook(p, s);

  } catch (err) {
    // Фоллбэк: Rendertron
    try {
      const r = await fetch("https://render-tron.appspot.com/render/" + encodeURIComponent(p.url));
      const html = await r.text();
      const s2 = parseFromHtml(html, p.url);
      out = cook(p, s2);
    } catch (e2) {
      out = { accountId: p.accountId, nickname: p.nickname, error: String(err), fetchedAt: new Date().toISOString() };
    }
  }
  await fs.writeFile(path.join(outDir, `${p.accountId}.json`), JSON.stringify(out), "utf-8");
}

await browser.close();
await fs.writeFile(path.join(outDir, "index.json"), JSON.stringify(players.map(p => p.accountId)), "utf-8");
