import json
from datetime import date
from pathlib import Path

import httpx
import pytest

from scripts.fetch_answers import Config, fetch_solution, load_cache, main

SOLUTIONS = {"2026-09-01": "joust", "2026-09-02": "crane", "2026-09-03": "joist"}


RealClient = httpx.Client


def mock_client(calls: list[str]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        d = request.url.path.rsplit("/", 1)[-1].removesuffix(".json")
        calls.append(d)
        if d not in SOLUTIONS:
            return httpx.Response(404)
        return httpx.Response(200, json={"solution": SOLUTIONS[d], "print_date": d})

    return RealClient(transport=httpx.MockTransport(handler))


def test_main_fetches_missing_days_and_uses_cache(tmp_path: Path):
    calls: list[str] = []
    cache = tmp_path / "cache.jsonl"
    cache.write_text(json.dumps({"date": "2026-09-01", "solution": "joust"}) + "\n")
    cfg = Config(start=date(2026, 9, 1), end=date(2026, 9, 4), cache=cache, out=tmp_path / "a.txt")
    slept: list[float] = []

    words = main(cfg, client=mock_client(calls), sleep=slept.append)

    assert words == ["joust", "crane", "joist"]
    assert calls == ["2026-09-02", "2026-09-03"]
    assert slept == [0.2, 0.2]
    assert cfg.out.read_text() == "joust\ncrane\njoist\n"
    assert load_cache(cache) == SOLUTIONS


def test_main_rejects_empty_range(tmp_path: Path):
    cfg = Config(
        start=date(2026, 9, 3), end=date(2026, 9, 3), cache=tmp_path / "c", out=tmp_path / "o"
    )
    with pytest.raises(AssertionError):
        main(cfg, client=mock_client([]))


def test_main_defaults_end_to_today_and_builds_client(tmp_path: Path, monkeypatch):
    class FakeDate(date):
        @classmethod
        def today(cls):
            return date(2026, 9, 2)

    monkeypatch.setattr("scripts.fetch_answers.date", FakeDate)
    calls: list[str] = []
    monkeypatch.setattr(httpx, "Client", lambda **_: mock_client(calls))
    cfg = Config(start=date(2026, 9, 1), cache=tmp_path / "c.jsonl", out=tmp_path / "o.txt")
    assert main(cfg, sleep=lambda _: None) == ["joust"]
    assert calls == ["2026-09-01"]


def test_fetch_solution_raises_on_http_error():
    with pytest.raises(httpx.HTTPStatusError):
        fetch_solution(mock_client([]), date(2030, 1, 1))


def test_fetch_solution_asserts_shape():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"solution": "toolong"})

    with pytest.raises(AssertionError):
        fetch_solution(httpx.Client(transport=httpx.MockTransport(handler)), date(2026, 9, 1))


def test_load_cache_missing_file(tmp_path: Path):
    assert load_cache(tmp_path / "nope") == {}
