"""build data/answers.txt from the nyt endpoint over past dates. the list is never committed;
this script rebuilds it, caching each date so reruns only fetch what is missing."""

import json
import time
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import httpx
import tyro
from tqdm import tqdm

WORDLE_LAUNCH = date(2021, 6, 19)
ENDPOINT = "https://www.nytimes.com/svc/wordle/v2/{d}.json"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


@dataclass
class Config:
    start: date = WORDLE_LAUNCH
    # exclusive; defaults to today so tomorrow's answer is never fetched
    end: date | None = None
    delay_s: float = 0.2
    cache: Path = DATA_DIR / "answers_by_date.jsonl"
    out: Path = DATA_DIR / "answers.txt"


def load_cache(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    rows = (json.loads(line) for line in path.read_text().splitlines() if line)
    return {row["date"]: row["solution"] for row in rows}


def fetch_solution(client: httpx.Client, d: date) -> str:
    response = client.get(ENDPOINT.format(d=d.isoformat()))
    response.raise_for_status()
    solution = response.json()["solution"]
    assert isinstance(solution, str) and len(solution) == 5, f"bad solution for {d}: {solution!r}"
    return solution.lower()


def main(cfg: Config, client: httpx.Client | None = None, sleep=time.sleep) -> list[str]:
    end = cfg.end or date.today()
    assert cfg.start < end, "start must be before end"
    cached = load_cache(cfg.cache)
    days = [cfg.start + timedelta(days=i) for i in range((end - cfg.start).days)]
    missing = [d for d in days if d.isoformat() not in cached]
    client = client or httpx.Client(headers={"User-Agent": "wordle-classifier answers fetch"})
    cfg.cache.parent.mkdir(parents=True, exist_ok=True)
    with cfg.cache.open("a") as cache_file:
        for d in tqdm(missing, desc="fetching answers"):
            solution = fetch_solution(client, d)
            cached[d.isoformat()] = solution
            cache_file.write(json.dumps({"date": d.isoformat(), "solution": solution}) + "\n")
            sleep(cfg.delay_s)
    words = [cached[d.isoformat()] for d in days]
    cfg.out.write_text("\n".join(words) + "\n")
    return words


if __name__ == "__main__":
    main(tyro.cli(Config))
