#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Скрапер статистики игроков с https://tanki.su
Алгоритм:
- Пробуем статику (requests + BS4).
- Если ключевые поля пустые — рендерим страницу Playwright-ом,
  дожидаемся появления чисел и СЧИТЫВАЕМ ИХ ИЗ DOM (page.evaluate),
  а не через page.content().
- Маппим подписи → значения и сохраняем JSON.
"""

import re
import json
import time
import asyncio
import pathlib
from datetime import datetime, timezone
from typing import Dict, Optional, Iterable, Tuple

from bs4 import BeautifulSoup
import requests

# Если начнутся 403 — можно использовать cloudscraper:
# import cloudscraper
# Session = cloudscraper.create_scraper  # type: ignore
Session = requests.Session

BASE = "https://tanki.su/ru/community/accounts"

# ─────────────────────────────────────────────
# Утилиты чисел

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
    for _ in range(3):
        try:
            resp = sess.get(url, headers=headers, timeout=timeout)
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            last_err = e
            time.sleep(1.0)
    raise last_err  # type: ignore[misc]

# ─────────────────────────────────────────────
# Рендер + чтение значений прямо из DOM

async def _render_and_grab_dom_async(url: str, timeout_ms: int = 80000) -> Tuple[Dict[str, str], Optional[str]]:
    from playwright.async_api import async_playwright

    def _has_digits(s: Optional[str]) -> bool:
        return bool(s and re.search(r"\d", s))

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/121.0 Safari/537.36"),
            locale="ru-RU",
            viewport={"width": 1280, "height": 900},
        )

        # блокируем тяжёлые ресурсы (ускоряем и меньше шансов «вечно ждать»)
        async def _route(route, request):
            if request.resource_type in ("image", "media", "font"):
                await route.abort()
            else:
                await route.continue_()
        await context.route("**/*", _route)

        page = await context.new_page()

        await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)

        # куки-баннер (мягкая попытка закрыть)
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

        # ждём, пока именно значения станут числовыми
        await page.wait_for_selector(".stats_inner .stats_item .stats_text", timeout=45000)
        await page.wait_for_function(
            """() => {
                const items = Array.from(document.querySelectorAll('.stats_inner .stats_item'));
                let ok = 0;
                for (const it of items) {
                    const l = it.querySelector('.stats_text')?.textContent?.trim();
                    const v = it.querySelector('.stats_value')?.textContent?.trim();
                    if (l && v && /\\d/.test(v)) ok++;
                }
                return ok >= 5; // на странице как минимум несколько числовых показателей
            }""",
            timeout=45000
        )

        result = await page.evaluate(
            """() => {
                const out = {};
                const items = document.querySelectorAll('.stats_inner .stats_item');
                for (const it of items) {
                    const lnode = it.querySelector('.stats_text');
                    const vnode = it.querySelector('.stats_value');
                    if (!lnode || !vnode) continue;
                    const L = lnode.textContent?.trim() || '';
                    let V = vnode.textContent?.trim() || '';
                    out[L.replaceAll('\\u00AB','').replaceAll('\\u00BB','').toLowerCase()] = V;
                }
                const h1 = document.querySelector('h1');
                const nickname = h1 ? h1.textContent.trim() : null;
                return {stats: out, nickname};
            }"""
        )

        stats_map = result.get("stats", {}) if isinstance(result, dict) else {}
        nickname = result.get("nickname") if isinstance(result, dict) else None

        await context.close()
        await browser.close()

        # если вдруг цифр нет — как fallback обновим один раз
        has_any = any(re.search(r"\d", v or "") for v in stats_map.values())
        if not has_any:
            # последний шанс
            return {}, nickname

        return stats_map, nickname

def fetch_stats_rendered(url: str, timeout_ms: int = 80000) -> Tuple[Dict[str, str], Optional[str]]:
    try:
        return asyncio.run(_render_and_grab_dom_async(url, timeout_ms=timeout_ms))
    except Exception as e:
        raise RuntimeError(f"Playwright DOM scrape failed: {e}")

# ─────────────────────────────────────────────
# Парсинг из сырого HTML (статический) — как раньше

def parse_profile_html_static(html: str, url: str) -> Dict:
    soup = BeautifulSoup(html, "lxml")

    h1 = soup.select_one("h1")
    if h1:
        nickname = h1.get_text(strip=True)
    else:
        tail = url.strip("/").split("/")[-1]
        nickname = tail.split("-", 1)[1] if "-" in tail else tail

    # Собираем подписи → значения напрямую из .stats_item (если повезёт)
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
# Маппинг «подпись → значение» → итоговый JSON

def _map_stats_to_data(stats_map_raw: Dict[str, str], nickname: Optional[str], html_for_fallback: Optional[str] = None) -> Dict:
    # нормализуем ключи, чтобы не зависеть от регистров/пробелов
    stats_map = {_norm_label(k): v for k, v in stats_map_raw.items()}

    rating_txt = stats_map.get("личный рейтинг")
    wins_txt   = stats_map.get("победы")                    # проценты
    battles_txt= stats_map.get("бои")
    hits_txt   = stats_map.get("попадания")                 # проценты
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

    # Фоллбэки на случай «статический HTML» + нет DOM-значений:
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
# «Пусто?» — эвристика

def seems_invalid(parsed: Dict) -> bool:
    zeros = 0
    if not parsed.get("battles"):
        zeros += 1
    if not parsed.get("global_rating"):
        zeros += 1
    if not parsed.get("avgDmg"):
        zeros += 1
    # если 2+ ключевых поля пустые/нули — надо рендерить
    return zeros >= 2

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


# ── рядом с save_json ─────────────────────────────────────────────────────────
def save_index(out_dir: pathlib.Path, items: list[dict]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    index_path = out_dir / "index.json"
    payload = {
        "generatedAt": datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        "players": items,
    }
    index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

# ─────────────────────────────────────────────
# Основной пайп

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
        # 1) пробуем статику
        html = fetch_html(url, session=session)
        parsed = parse_profile_html_static(html, url)

        # 2) если пусто — читаем прямо из DOM через Playwright
        if seems_invalid(parsed):
            stats_map, dom_nickname = fetch_stats_rendered(url, timeout_ms=80000)
            if stats_map:
                parsed2 = _map_stats_to_data(stats_map, dom_nickname or parsed.get("nickname"), None)
                # если из DOM пришли осмысленные значения — используем их
                if not seems_invalid(parsed2):
                    parsed = parsed2

        data.update(parsed)
        data["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return data
    except Exception as e:
        data["error"] = f"{type(e).__name__}: {e}"
        data["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return data

def main():
    import argparse
    ap = argparse.ArgumentParser(description="Скрапер статистики танкистов (tanki.su)")
    ap.add_argument("--id", type=int, nargs="*", help="ID аккаунта(ов)")
    ap.add_argument("--url", type=str, nargs="*", help="Полные URL профилей")
    ap.add_argument("--input", type=str, help="participants.json или participants.txt/csv")
    ap.add_argument("--out", type=str, default="stats", help="Папка для JSON (default: stats)")
    ap.add_argument("--delay", type=float, default=1.2, help="Пауза между запросами, сек")
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

    # дедуп
    uniq = {}
    for j in jobs:
        uniq[j["id"]] = j.get("name")
    jobs = [{"id": k, "name": v} for k, v in uniq.items()]

    for i, job in enumerate(jobs, 1):
        acc, name = job["id"], job.get("name")
        print(f"[{i}/{len(jobs)}] {acc} ({name or '-'}) ... ", end="", flush=True)
        data = scrape_one(acc, name, session=sess)
        save_json(out_dir, data)
        print("OK" if "error" not in data else f"ERR: {data['error']}")
        time.sleep(args.delay)
        all_rows: list[dict] = []

    for i, job in enumerate(jobs, 1):
        acc, name = job["id"], job.get("name")
        print(f"[{i}/{len(jobs)}] {acc} ({name or '-'}) ... ", end="", flush=True)
        data = scrape_one(acc, name, session=sess)
        save_json(out_dir, data)          # оставим пофайлово — удобно дебажить
        all_rows.append(data)             # собираем в общий массив
        print("OK" if "error" not in data else f"ERR: {data['error']}")
        time.sleep(args.delay)

    # единый файл
    save_index(out_dir, all_rows)

if __name__ == "__main__":
    main()
