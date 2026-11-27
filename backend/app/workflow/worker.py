from __future__ import annotations

import logging
import threading
import time

from ..core.config import get_settings
from .engine import WorkflowEngine
from .pg_store import PgStore, claim_run

log = logging.getLogger("resiliomesh.worker")
_stop = threading.Event()
status = {"started_at": None, "last_poll": None, "processed": 0, "last_result": None, "errors": 0}


def run_once(engine: WorkflowEngine, worker_id: str) -> dict | None:
    run = claim_run(worker_id)
    if not run:
        return None
    log.info("claimed run %s (attempt %s, status %s)", run["id"], run["attempts"], run["status"])
    result = engine.execute(run)
    status["processed"] += 1
    status["last_result"] = {"run_id": run["id"], **result}
    return result


def loop(poll_s: float | None = None, worker_id: str | None = None) -> None:
    s = get_settings()
    poll_s = poll_s or s.worker_poll_s
    worker_id = worker_id or s.worker_id
    engine = WorkflowEngine(PgStore())
    status["started_at"] = time.time()
    log.info("workflow worker %s started (poll %.1fs)", worker_id, poll_s)
    while not _stop.is_set():
        status["last_poll"] = time.time()
        try:
            while run_once(engine, worker_id):
                pass
        except Exception:
            status["errors"] += 1
            log.exception("worker iteration failed")
        send_notifications(worker_id)
        _stop.wait(poll_s)


def send_notifications(worker_id: str) -> dict | None:
    """E-mail / SMS outbox; isolated so a mail or SMS outage never stalls dispatch."""
    from ..services import notifier
    try:
        result = notifier.run_pending(worker_id=worker_id)
        notifier.status["last_error"] = None
        return result
    except Exception as exc:
        notifier.status["last_error"] = str(exc)[:300]
        log.exception("notification sending failed")
        return None


def start_background() -> threading.Thread:
    t = threading.Thread(target=loop, name="workflow-worker", daemon=True)
    t.start()
    return t


def stop() -> None:
    _stop.set()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    loop()
