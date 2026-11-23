import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("DATABASE_URL", "")          # unit tests never touch a DB
os.environ.setdefault("WORKER_IN_PROCESS", "false")

from app.core.auth import CurrentUser, get_current_user  # noqa: E402


def make_user(role: str) -> CurrentUser:
    return CurrentUser(id="00000000-0000-0000-0000-0000000000aa", email=f"{role}@test.local",
                       role=role, organization_id=None, full_name=f"Test {role}")


@pytest.fixture
def client_as():
    from fastapi.testclient import TestClient
    from app.main import app

    clients = []

    def _make(role: str | None):
        app.dependency_overrides.clear()
        if role:
            app.dependency_overrides[get_current_user] = lambda: make_user(role)
        c = TestClient(app)
        clients.append(c)
        return c

    yield _make
    app.dependency_overrides.clear()
