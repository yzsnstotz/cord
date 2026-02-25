from __future__ import annotations

import os

from env_utils import env_bool


def test_env_bool_truthy_and_falsy(monkeypatch) -> None:
    monkeypatch.delenv("X", raising=False)
    assert env_bool("X", default=True) is True
    assert env_bool("X", default=False) is False

    for v in ("1", "true", "yes", "on", " TRUE ", "Yes"):
        monkeypatch.setenv("X", v)
        assert env_bool("X", default=False) is True

    for v in ("0", "false", "no", "off", " 0 ", "False"):
        monkeypatch.setenv("X", v)
        assert env_bool("X", default=True) is False

    monkeypatch.setenv("X", "maybe")
    assert env_bool("X", default=True) is True
    assert env_bool("X", default=False) is False

