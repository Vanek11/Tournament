import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const players = JSON.parse(await fs.readFile("data/players.json", "utf-8"));
const outDir = "stats";
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  viewport: { width: 1366, height: 900 }
});
const page = await ctx.newPage();

const results = [];

for (const p of players) {
  try {
    await page.goto(p.url, { waitUntil: "networkidle" });
    await page.waitForSelector("h1", { timeout: 20000 });

    const stat = await page.evaluate(() => {
      const txt = (s) => (s || "").replace(/\u00A0/g, " ").trim();
      const norm = (v) => {
        if (v == null) return null;
        const n = Number(String(v).replace("%", "").replace(/\s+/g, "").replace(",", "."));
        return Number.isFinite(n) ? n : null;
      };

      // Соберём пары <dt>/<dd>
      const pairs = Array.from(document.querySelectorAll("dt,dd"));
      const map = {};
      for (let i = 0; i < pairs.length - 1; i++) {
        if (pairs[i].tagName === "DT" && pairs[i + 1].tagName === "DD") {
          map[txt(pairs[i].textContent)] = txt(pairs[i + 1].textContent);
        }
      }
      const pick = (re) => {
        const key = Object.keys(map).find((k) => re.test(k));
        return key ? map[key] : null;
      };

      const nickname = txt(document.querySelector("h1")?.textContent);
      const battles = norm(pick(/Бои|Сражения|Баталии/i));
      const wins = norm(pick(/Победы(?!.*%)/i)) ?? null;
      const winRate =
        norm(pick(/Процент побед|Победы.*%/i)) ?? (battles && wins != null ? (wins / battles) * 100 : null);
      const avgDmg = norm(pick(/Средн.*урон/i));
      const avgFrags = norm(pick(/Ср\.?\s*фраги|Средн.*уничтожен/i));
      const surviveRate = norm(pick(/Выживаемость|Процент выживаемости/i));
      const hitsPercents = norm(pick(/Попадания.*%|Процент попаданий/i));
      const rating = norm(pick(/WTR|GR|Рейтинг|РЭ/i));

      return { nickname, battles, wins, winRate, avgDmg, avgFrags, surviveRate, hitsPercents, global_rating: rating };
    });

    const out = {
      accountId: p.accountId,
      nickname: stat.nickname || p.nickname || "",
      global_rating: stat.global_rating || 0,
      battles: stat.battles || 0,
      wins: stat.wins,
      winRate: stat.winRate ?? 0,
      avgDmg: stat.avgDmg ?? 0,
      avgFrags: stat.avgFrags ?? null,
      surviveRate: stat.surviveRate ?? null,
      hitsPercents: stat.hitsPercents ?? null,
      fetchedAt: new Date().toISOString()
    };

    await fs.writeFile(path.join(outDir, `${p.accountId}.json`), JSON.stringify(out), "utf-8");
    results.push(out);
  } catch (e) {
    const err = { accountId: p.accountId, nickname: p.nickname, error: String(e), fetchedAt: new Date().toISOString() };
    await fs.writeFile(path.join(outDir, `${p.accountId}.json`), JSON.stringify(err), "utf-8");
  }
}

await fs.writeFile(path.join(outDir, "index.json"), JSON.stringify(results), "utf-8");
await browser.close();
