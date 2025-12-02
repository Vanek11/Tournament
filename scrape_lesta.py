# python scrape_lesta.py --input participants.json
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Скрапер статистики игроков с https://tanki.su

Стратегия устойчивости:
- Статика (requests + BS4).
- Если ключевые поля пустые — Playwright с "мягким goto" и stealth.
- Если и Playwright не дался — фолбэк Jina Reader (текстовая выдача).
- Никогда не затираем хорошие JSON "нулём": при сбое оставляем старые.
- index.json собираем как merge: старые + успешно обновлённые.
"""

import re
import json
import time
import random
import asyncio
import pathlib
from datetime import datetime, timezone
from typing import Dict, Optional, Iterable, Tuple, List

from bs4 import BeautifulSoup
import requests

# Если начнутся 403 — можно использовать cloudscraper:
# import cloudscraper
# Session = cloudscraper.create_scraper  # type: ignore
Session = requests.Session

BASE = "https://tanki.su/ru/community/accounts"

# ─────────────────────────────────────────────
# Утилиты чисел / нормализации

def _clean_num(s: Optional[str]) -> Optional[float]:
    if not s:
        return None
    s = s.replace("\xa0", " ").strip()
    m = re.sub(r"[^0-9,.\-]", "", s)
    if not m:
        return None
    if m.count(",") == 1 and "." not in m:
        m = m.replace(",", ".")
    m = re.sub(r"(?<=\d)[\s.](?=\d{3}(\D|$))", "", m)
    try:
        return float(m)
    except ValueError:
        return None

def _clean_int(s: Optional[str]) -> Optional[int]:
    f = _clean_num(s)
    return int(round(f)) if f is not None else None

def _norm_label(s: str) -> str:
    s = s.replace("\xa0", " ")
    s = re.sub(r"[«»\"'’–—:]+", " ", s)
    s = re.sub(r"\s+", " ", s.strip().lower())
    return s

# ─────────────────────────────────────────────
# Регэкспы-фоллбэки (если верстку изменят)

RX = {
    "battles": re.compile(r"(?:Бои|Сражения|Баталии)[^0-9]*([0-9\s.,]+)", re.I),
    "winRate": re.compile(r"Процент\s*побед[^\d%]*([0-9]+(?:[.,]\d+)?)", re.I),
    "avgDmg": re.compile(r"Средн(?:ий|яя)\s*урон[^\d]*([0-9\s.,]+)", re.I),
    "hitsPercents": re.compile(r"Процент\s*попадан[^\d%]*([0-9]+(?:[.,]\d+)?)", re.I),
    "rating": re.compile(r"(?:WTR|GR|Рейтинг|РЭ|Личный\s*рейтинг)[^0-9]*([0-9\s.,]+)", re.I),
}

def build_profile_url(account_id: int, nickname: Optional[str] = None) -> str:
    slug = f"{account_id}-{nickname}" if nickname else str(account_id)
    return f"{BASE}/{slug}/"

# ─────────────────────────────────────────────
# HTTP (requests)

def fetch_html(url: str, session: Optional[requests.Session] = None, timeout=30) -> str:
    sess = session or Session()
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/121.0 Safari/537.36"
        ),
        "Accept-Language": "ru,en;q=0.9",
        "Referer": "https://tanki.su/",
    }
    last_err = None
    for i in range(3):
        try:
            resp = sess.get(url, headers=headers, timeout=timeout)
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            last_err = e
            time.sleep(1.0 * (i + 1))
    raise last_err  # type: ignore[misc]

# ─────────────────────────────────────────────
# Рендер + чтение значений прямо из DOM (Playwright с улучшениями)

async def safe_goto(page, url: str) -> None:
    """Мягкая навигация с тремя режимами ожидания и бэкоффом."""
    modes = [("commit", 30000), ("domcontentloaded", 60000), ("load", 120000)]
    for i, (wait_until, tm) in enumerate(modes):
        try:
            await page.goto(url, wait_until=wait_until, timeout=tm)
            return
        except Exception:
            if i == len(modes) - 1:
                raise
            await asyncio.sleep(1.5 * (i + 1))

async def _render_and_grab_dom_async(url: str) -> Tuple[Dict[str, str], Optional[str]]:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        context = await browser.new_context(
            ignore_https_errors=True,
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/121.0 Safari/537.36"),
            locale="ru-RU",
            viewport={"width": 1280, "height": 900},
            extra_http_headers={
                "Accept-Language": "ru,en;q=0.9",
                "Referer": "https://tanki.su/",
            },
        )

        # stealth: прячем "webdriver", задаём языки/платформу
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'languages', {get: () => ['ru-RU','ru','en-US','en']});
            Object.defineProperty(navigator, 'platform', {get: () => 'Win32'});
        """)

        page = await context.new_page()

        # Блокируем только картинки/медиа (шрифты НЕ блокируем!)
        async def _route(route, request):
            if request.resource_type in ("image", "media"):
                await route.abort()
            else:
                await route.continue_()
        await context.route("**/*", _route)

        # Мягкий goto
        await safe_goto(page, url)

        # Best effort: cookie-баннеры
        for sel in [
            'button:has-text("Соглас")',
            'button:has-text("Принять")',
            '[data-qa*="cookie"] button',
            '#cookie_policy_button',
            '.cookie-accept, .cookies-accept, .cookies__button',
        ]:
            try:
                btn = page.locator(sel)
                if await btn.count() > 0:
                    await btn.first.click(timeout=1500)
                    break
            except:
                pass

        # Ждём реальных числовых значений
        await page.wait_for_selector(".stats_inner .stats_item .stats_value", timeout=60000)
        await page.wait_for_function(
            """() => {
                const vals = Array.from(document.querySelectorAll('.stats_inner .stats_item .stats_value'))
                    .map(n => n.textContent?.trim() || '');
                return vals.some(v => /\\d/.test(v));
            }""",
            timeout=60000
        )

        result = await page.evaluate("""() => {
            const out = {};
            document.querySelectorAll('.stats_inner .stats_item').forEach(it => {
                const l = it.querySelector('.stats_text')?.textContent?.trim() || '';
                const v = it.querySelector('.stats_value')?.textContent?.trim() || '';
                out[l.toLowerCase()] = v;
            });
            const h1 = document.querySelector('h1');
            const nickname = h1 ? h1.textContent.trim() : null;
            return {stats: out, nickname};
        }""")

        await context.close()
        await browser.close()

        return result.get("stats", {}), result.get("nickname")

def fetch_stats_rendered(url: str) -> Tuple[Dict[str, str], Optional[str]]:
    try:
        return asyncio.run(_render_and_grab_dom_async(url))
    except Exception as e:
        raise RuntimeError(f"Playwright DOM scrape failed: {e}")

# ─────────────────────────────────────────────
# Фолбэк через Jina Reader (текст из отрендерённой страницы)

def fetch_via_jina_text(url: str, timeout=60) -> Optional[str]:
    try:
        # Jina Reader: вернёт текст страницы, часто обходит сетевые капризы
        proxied = "https://r.jina.ai/http/" + url.replace("https://", "").rstrip("/")
        r = requests.get(
            proxied, timeout=timeout,
            headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "ru,en;q=0.9"}
        )
        if r.ok and len(r.text) > 500:
            return r.text
    except Exception:
        pass
    return None

# ─────────────────────────────────────────────
# Парсинг из сырого HTML (статический)

def parse_profile_html_static(html: str, url: str) -> Dict:
    soup = BeautifulSoup(html, "lxml")

    h1 = soup.select_one("h1")
    if h1:
        nickname = h1.get_text(strip=True)
    else:
        tail = url.strip("/").split("/")[-1]
        nickname = tail.split("-", 1)[1] if "-" in tail else tail

    stats_map: Dict[str, str] = {}
    inner = soup.select_one(".stats_inner")
    if inner:
        for item in inner.select(".stats_item"):
            lab = item.select_one(".stats_text")
            val = item.select_one(".stats_value")
            if lab and val:
                L = _norm_label(lab.get_text())
                V = val.get_text(" ", strip=True)
                stats_map[L] = V

    return _map_stats_to_data(stats_map, nickname, html)

# ─────────────────────────────────────────────
# Маппинг → итоговый JSON

def _map_stats_to_data(stats_map_raw: Dict[str, str], nickname: Optional[str], html_for_fallback: Optional[str] = None) -> Dict:
    stats_map = {_norm_label(k): v for k, v in stats_map_raw.items()}

    rating_txt = stats_map.get("личный рейтинг")
    wins_txt   = stats_map.get("победы")
    battles_txt= stats_map.get("бои")
    hits_txt   = stats_map.get("попадания")
    dmg_txt    = stats_map.get("средний урон")
    avgexp_txt = stats_map.get("средний опыт за бой")
    maxexp_txt = stats_map.get("максимальный опыт за бой")
    maxfr_txt  = stats_map.get("максимум уничтожено за бой")
    master_txt = stats_map.get("знаки классности мастер")

    global_rating = _clean_int(rating_txt) or 0
    winRate       = _clean_num((wins_txt or "").replace("%", "")) or 0.0
    battles       = _clean_int(battles_txt) or 0
    hitsPercents  = _clean_num((hits_txt or "").replace("%", "")) if hits_txt else None
    avgDmg        = _clean_int(dmg_txt) or 0
    avgExp        = _clean_int(avgexp_txt) if avgexp_txt else None
    maxExp        = _clean_int(maxexp_txt) if maxexp_txt else None
    maxFrags      = _clean_int(maxfr_txt) if maxfr_txt else None

    masterCount = vehiclesCount = None
    if master_txt:
        m = re.match(r"\s*([\d\s.,]+)\s*/\s*([\d\s.,]+)\s*$", master_txt)
        if m:
            masterCount   = _clean_int(m.group(1))
            vehiclesCount = _clean_int(m.group(2))

    wins_abs = int(round(battles * (winRate / 100.0))) if battles and winRate is not None else None

    data = {
        "nickname": nickname,
        "battles": battles,
        "wins": wins_abs,
        "winRate": winRate,
        "avgDmg": avgDmg,
        "avgFrags": None,
        "surviveRate": None,
        "hitsPercents": hitsPercents,
        "global_rating": global_rating,
        "avgExp": avgExp,
        "maxExp": maxExp,
        "maxFrags": maxFrags,
        "masterCount": masterCount,
        "vehiclesCount": vehiclesCount,
    }

    # Фолбэки по сырому тексту
    if html_for_fallback:
        if data["battles"] == 0:
            m = RX["battles"].search(html_for_fallback)
            if m:
                data["battles"] = _clean_int(m.group(1)) or 0

        if data["winRate"] == 0.0:
            m = RX["winRate"].search(html_for_fallback)
            if m:
                wr = _clean_num(m.group(1))
                data["winRate"] = wr or 0.0
                if data["battles"] and wr is not None:
                    data["wins"] = int(round(data["battles"] * (wr / 100.0)))

        if data["avgDmg"] == 0:
            m = RX["avgDmg"].search(html_for_fallback)
            if m:
                data["avgDmg"] = _clean_int(m.group(1)) or 0

        if data["hitsPercents"] is None:
            m = RX["hitsPercents"].search(html_for_fallback)
            if m:
                data["hitsPercents"] = _clean_num(m.group(1))

        if not data["global_rating"]:
            m = RX["rating"].search(html_for_fallback)
            if m:
                data["global_rating"] = _clean_int(m.group(1)) or 0

    return data

# ─────────────────────────────────────────────
# Проверки валидности

def seems_invalid(parsed: Dict) -> bool:
    zeros = 0
    if not parsed.get("battles"):
        zeros += 1
    if not parsed.get("global_rating"):
        zeros += 1
    if not parsed.get("avgDmg"):
        zeros += 1
    return zeros >= 2

def is_good(data: Dict) -> bool:
    return ("error" not in data) and (not seems_invalid(data))

# ─────────────────────────────────────────────
# Обвязка: список, сохранение

def load_participants(path: pathlib.Path) -> Iterable[Dict]:
    p = path
    if not p.exists():
        raise FileNotFoundError(p)

    if p.suffix.lower() == ".json":
        return json.loads(p.read_text(encoding="utf-8"))

    items = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [t.strip() for t in re.split(r"[;,|\s]\s*", line) if t.strip()]
        if not parts:
            continue
        acc = int(parts[0])
        name = parts[1] if len(parts) > 1 else None
        items.append({"id": acc, "name": name})
    return items

def save_json(out_dir: pathlib.Path, data: Dict):
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{data['accountId']}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def load_index(out_dir: pathlib.Path) -> Dict[int, Dict]:
    idx_path = out_dir / "index.json"
    if not idx_path.exists():
        return {}
    try:
        payload = json.loads(idx_path.read_text(encoding="utf-8"))
        players = payload.get("players", [])
        return {int(p.get("accountId")): p for p in players if "accountId" in p}
    except Exception:
        return {}

def save_index(out_dir: pathlib.Path, items: List[Dict]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    index_path = out_dir / "index.json"
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "players": items,
    }
    index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

# ─────────────────────────────────────────────
# Основной пайп одного профиля

def scrape_one(account_id: int, nickname: Optional[str] = None, session=None) -> Dict:
    url = build_profile_url(account_id, nickname)
    data: Dict = {
        "accountId": account_id,
        "nickname": nickname,
        "battles": 0, "wins": None, "winRate": 0.0,
        "avgDmg": 0, "avgFrags": None, "surviveRate": None,
        "hitsPercents": None, "global_rating": 0,
    }
    try:
        # 1) Статика
        html = fetch_html(url, session=session)
        parsed = parse_profile_html_static(html, url)

        # 2) DOM через Playwright — только если пусто
        if seems_invalid(parsed):
            stats_map, dom_nickname = fetch_stats_rendered(url)
            if stats_map:
                parsed2 = _map_stats_to_data(stats_map, dom_nickname or parsed.get("nickname"), None)
                if not seems_invalid(parsed2):
                    parsed = parsed2

        # 3) Jina text fallback — если всё ещё пусто
        if seems_invalid(parsed):
            txt = fetch_via_jina_text(url)
            if txt:
                parsed3 = _map_stats_to_data({}, parsed.get("nickname"), txt)
                if not seems_invalid(parsed3):
                    parsed = parsed3

        data.update(parsed)
        data["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        return data
    except Exception as e:
        data["error"] = f"{type(e).__name__}: {e}"
        data["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        return data

# ─────────────────────────────────────────────
# CLI

def main():
    import argparse
    ap = argparse.ArgumentParser(description="Скрапер статистики танкистов (tanki.su)")
    ap.add_argument("--id", type=int, nargs="*", help="ID аккаунта(ов)")
    ap.add_argument("--url", type=str, nargs="*", help="Полные URL профилей")
    ap.add_argument("--input", type=str, help="participants.json или participants.txt/csv")
    ap.add_argument("--out", type=str, default="stats", help="Папка для JSON (default: stats)")
    ap.add_argument("--delay", type=float, default=1.2, help="Базовая пауза между запросами, сек (добавляется джиттер)")
    args = ap.parse_args()

    out_dir = pathlib.Path(args.out)
    sess = Session() if callable(Session) else Session

    jobs = []

    if args.id:
        for acc in args.id:
            jobs.append({"id": acc, "name": None})

    if args.url:
        for u in args.url:
            u = u.rstrip("/")
            tail = u.split("/")[-1]
            if "-" in tail:
                acc_str, name = tail.split("-", 1)
                try:
                    acc = int(acc_str)
                except ValueError:
                    continue
            else:
                try:
                    acc = int(tail); name = None
                except ValueError:
                    continue
            jobs.append({"id": acc, "name": name})

    if args.input:
        jobs.extend(load_participants(pathlib.Path(args.input)))

    if not jobs:
        print("Нечего парсить: укажи --id, --url или --input")
        return

    # Дедуп по id
    uniq = {}
    for j in jobs:
        uniq[j["id"]] = j.get("name")
    jobs = [{"id": k, "name": v} for k, v in uniq.items()]

    # Загружаем предыдущий индекс для merge
    prev_map = load_index(out_dir)
    updated_map: Dict[int, Dict] = {}

    for i, job in enumerate(jobs, 1):
        acc, name = job["id"], job.get("name")
        print(f"[{i}/{len(jobs)}] {acc} ({name or '-'}) ... ", end="", flush=True)

        data = scrape_one(acc, name, session=sess)

        dst = out_dir / f"{acc}.json"
        if is_good(data):
            save_json(out_dir, data)
            updated_map[acc] = data
            print("OK")
        else:
            # При сбое не перезаписываем хороший файл
            if dst.exists():
                print("SKIP: keep previous stats")
                # оставим в индексе старую запись (из prev_map), если есть
            else:
                print(f"ERR: {data.get('error','invalid data')}")
            # ничего не кладём в updated_map
        time.sleep(args.delay + random.uniform(0.5, 1.2))

    # Собираем индекс: старые + обновлённые
    merged = dict(prev_map)
    merged.update(updated_map)
    # Превращаем в список; можно сортировать по accountId
    items = [merged[k] for k in sorted(merged.keys())]
    save_index(out_dir, items)

if __name__ == "__main__":
    main()
