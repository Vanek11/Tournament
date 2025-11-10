// scripts/scrape.mjs
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const players = JSON.parse(await fs.readFile("data/players.json", "utf-8"));
const outDir = "stats";
await fs.mkdir(outDir, { recursive: true });

function cleanNum(v) {
  if (v == null) return null;
  const n = Number(String(v)
    .replace("%","")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, "")
    .replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function pack(player, s) {
  const battles = s.battles || 0;
  const wins = s.wins ?? null;
  return {
    accountId: player.accountId,
    nickname: s.nickname || player.nickname || "",
    global_rating: s.rating || 0,
    battles,
    wins,
    winRate: s.winRate ?? (battles && wins!=null ? (wins / battles * 100) : 0),
    avgDmg: s.avgDmg ?? 0,
    avgFrags: s.avgFrags ?? null,
    surviveRate: s.survive ?? null,
    hitsPercents: s.hits ?? null,
    fetchedAt: new Date().toISOString()
  };
}

function parseFromHtml(html, profileUrl) {
  // ник: из h1 или из хвоста URL
  const nickFromUrl = decodeURIComponent(profileUrl)
    .split("/").filter(Boolean).pop()?.split("-").slice(1).join("-") || "";
  const nickname = (html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1] || nickFromUrl).trim();

  // универсальная пара "метка -> значение"
  const rxPair = (label) =>
    new RegExp(`(?:<dt[^>]*>${label}<\\/dt>\\s*<dd[^>]*>|${label}[^0-9%]{0,40})([0-9\\s.,%]+)`, "i");

  const battles  = cleanNum((html.match(rxPair("(?:Бои|Сражения|Баталии)"))||[])[1]) || 0;
  const wins     = cleanNum((html.match(rxPair("Победы(?![^%]*%)"))||[])[1]);

  const wrText   = (html.match(rxPair("(?:Процент побед|Победы[, \\t\\r\\n]*%)"))||[])[1];
  const winRate  = wrText ? cleanNum(wrText) : (battles && wins!=null ? (wins/battles*100) : null);

  const avgDmg   = cleanNum((html.match(rxPair("Средн(?:ий|яя)?\\s*урон"))||[])[1]);
  const avgFrags = cleanNum((html.match(rxPair("(?:Ср\\.?\\s*фраги|Средн(?:ее|их)?\\s*уничтожен)"))||[])[1]);
  const survive  = cleanNum((html.match(rxPair("(?:Выживаемость|Процент выживаемости)"))||[])[1]);
  const hits     = cleanNum((html.match(rxPair("(?:Попадания[, \\t\\r\\n]*%|Процент попаданий)"))||[])[1]);
  const rating   = cleanNum((html.match(rxPair("(?:WTR|GR|Рейтинг|РЭ)"))||[])[1]);

  return { nickname, battles, wins, winRate, avgDmg, avgFrags, survive, hits, rating };
}

async function getViaRendertron(url) {
  const r = await fetch("https://render-tron.appspot.com/render/" + encodeURIComponent(url), { timeout: 60000 });
  if (!r.ok) throw new Error("Rendertron " + r.status);
  return await r.text();
}
async function getViaJina(url) {
  const u = "https://r.jina.ai/http://" + url.replace(/^https?:\/\//, "");
  const r = await fetch(u, { timeout: 60000 });
  if (!r.ok) throw new Error("Jina " + r.status);
  return await r.text();
}

const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  locale: "ru-RU",
  timezoneId: "Europe/Moscow",
  viewport: { width: 1366, height: 900 },
  extraHTTPHeaders: { "Referer": "https://tanki.su/ru/community/accounts/" }
});
const page = await ctx.newPage();

// экономим трафик
await page.route("**/*", route => {
  const u = route.request().url();
  if (/\.(png|jpe?g|webp|gif|svg|woff2?|ttf|mp4|m3u8)$/i.test(u)) return route.abort();
  route.continue();
});

for (const p of players) {
  const idUrl = `https://tanki.su/ru/community/accounts/${p.accountId}/`;
  // если в players.json есть явный url — добавим его как второй вариант
  const candidates = [...new Set([idUrl, p.url].filter(Boolean))];

  let result = null;
  let lastErr = null;

  for (const target of candidates) {
    try {
      // 1) Playwright напрямую
      const resp = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (resp && resp.status() >= 400) throw new Error("HTTP " + resp.status());
      await page.waitForSelector("h1,dt,dd", { timeout: 30000 });
      const s = await page.evaluate(() => {
        const txt = s => (s || "").replace(/\u00A0/g, " ").trim();
        const n = v => {
          if (v == null) return null;
          const x = Number(String(v).replace("%","").replace(/\s+/g,"").replace(",","."));
          return Number.isFinite(x) ? x : null;
        };
        const pairs = Array.from(document.querySelectorAll("dt,dd"));
        const map = {};
        for (let i = 0; i < pairs.length - 1; i++) {
          if (pairs[i].tagName === "DT" && pairs[i+1].tagName === "DD") {
            map[txt(pairs[i].textContent)] = txt(pairs[i+1].textContent);
          }
        }
        const pick = re => {
          const k = Object.keys(map).find(k => re.test(k));
          return k ? map[k] : null;
        };
        const nickname = txt(document.querySelector("h1")?.textContent);
        const battles = n(pick(/Бои|Сражения|Баталии/i));
        const wins = n(pick(/Победы(?!.*%)/i));
        const wr = n(pick(/Процент побед|Победы.*%/i));
        const avgDmg = n(pick(/Средн.*урон/i));
        const avgFrags = n(pick(/Ср\.?\s*фраги|Средн.*уничтожен/i));
        const survive = n(pick(/Выживаемость|Процент выживаемости/i));
        const hits = n(pick(/Попадания.*%|Процент попаданий/i));
        const rating = n(pick(/WTR|GR|Рейтинг|РЭ/i));
        return { nickname, battles, wins, winRate: wr, avgDmg, avgFrags, survive, hits, rating };
      });
      if (s && (s.battles || s.avgDmg || s.winRate)) {
        result = pack(p, s);
        break;
      }
      throw new Error("Empty DOM parse");
    } catch (e) {
      lastErr = e;
      // 2) Rendertron
      try {
        const html = await getViaRendertron(target);
        const s2 = parseFromHtml(html, target);
        if (s2 && (s2.battles || s2.avgDmg || s2.winRate || s2.rating)) {
          result = pack(p, s2);
          break;
        }
        throw new Error("Rendertron parse fail");
      } catch (e2) {
        lastErr = e2;
        // 3) Jina
        try {
          const html2 = await getViaJina(target);
          const s3 = parseFromHtml(html2, target);
          if (s3 && (s3.battles || s3.avgDmg || s3.winRate || s3.rating)) {
            result = pack(p, s3);
            break;
          }
          throw new Error("Jina parse fail");
        } catch (e3) {
          lastErr = e3;
          continue; // попробуем следующий candidate
        }
      }
    }
  }

  if (!result) {
    result = {
      accountId: p.accountId,
      nickname: "Error: " + String(lastErr?.message || lastErr || "Unknown"),
      global_rating: 0, battles: 0, wins: null, winRate: 0,
      avgDmg: 0, avgFrags: null, surviveRate: null, hitsPercents: null,
      fetchedAt: new Date().toISOString()
    };
  }

  await fs.writeFile(path.join(outDir, `${p.accountId}.json`), JSON.stringify(result), "utf-8");
}

await browser.close();
await fs.writeFile(path.join(outDir, "index.json"),
  JSON.stringify(players.map(p => p.accountId)), "utf-8");
