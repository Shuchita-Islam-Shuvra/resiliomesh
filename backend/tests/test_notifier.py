from datetime import datetime, timezone

import httpx
import pytest

from app.core.config import Settings
from app.services import notifier
from app.services.notifier import (MAX_ATTEMPTS, BulkSmsBd, LogChannel, PermanentSendError, Sent,
                                   TransientSendError, bd_msisdn, build_channels, compose_sms, process_batch)

NOW = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)


class FakeStore:
    def __init__(self, rows):
        self.rows, self.done = rows, {}

    def claim(self, worker_id, limit):
        out, self.rows = self.rows[:limit], self.rows[limit:]
        return out

    def finish(self, delivery_id, worker_id, **kw):
        self.done[delivery_id] = kw


class FakeChannel:
    def __init__(self, exc=None, name="fake"):
        self.exc, self.name, self.calls = exc, name, []

    def send(self, destination, d):
        self.calls.append(destination)
        if self.exc:
            raise self.exc
        return Sent("sent", self.name, ref="abc")


def row(i, channel="sms", attempts=1, dest="01712345678"):
    return {"id": i, "channel": channel, "destination": dest, "attempts": attempts,
            "title": "New task: Clear drain", "body": "Clear the drain at Malibagh (RM-2607-1).", "link": "/field",
            "severity": "high", "kind": "task_assigned"}


def test_bd_numbers_are_normalised():
    assert bd_msisdn("01712345678") == "8801712345678"
    assert bd_msisdn("+880 1712-345678") == "8801712345678"
    assert bd_msisdn("1712345678") == "8801712345678"
    with pytest.raises(PermanentSendError):
        bd_msisdn("+44 7700 900123")


def test_sms_text_fits_and_keeps_the_link():
    d = row(1) | {"body": "x" * 1000}
    text = compose_sms(d, "https://resiliomesh.vercel.app")
    assert len(text) <= notifier.SMS_MAX_CHARS
    assert text.endswith("https://resiliomesh.vercel.app/field")


def test_sent_and_unconfigured_channels():
    store = FakeStore([row(1, "sms"), row(2, "email", dest="a@b.org")])
    counts = process_batch(store, {"sms": FakeChannel(), "email": LogChannel("email", "https://x")}, "w", now=lambda: NOW)
    assert counts == {"sent": 1, "skipped": 1, "failed": 0, "retrying": 0}
    assert store.done[1]["status"] == "sent" and store.done[1]["ref"] == "abc"
    assert store.done[2]["status"] == "skipped" and "not configured" in store.done[2]["error"]


def test_transient_failure_is_retried_with_backoff_then_given_up():
    store = FakeStore([row(1, attempts=2), row(2, attempts=MAX_ATTEMPTS)])
    counts = process_batch(store, {"sms": FakeChannel(TransientSendError("gateway timeout"))}, "w", now=lambda: NOW)
    assert counts["retrying"] == 1 and counts["failed"] == 1
    assert store.done[1]["status"] == "queued"
    assert (store.done[1]["retry_at"] - NOW).total_seconds() == notifier.BACKOFF_BASE_S * 2
    assert store.done[2]["status"] == "failed" and "gave up" in store.done[2]["error"]


def test_permanent_failure_is_not_retried():
    store = FakeStore([row(1)])
    process_batch(store, {"sms": FakeChannel(PermanentSendError("bad number"))}, "w", now=lambda: NOW)
    assert store.done[1]["status"] == "failed" and store.done[1]["error"] == "bad number"


def test_one_bad_delivery_does_not_block_the_rest():
    class Flaky(FakeChannel):
        def send(self, destination, d):
            if d["id"] == 1:
                raise RuntimeError("boom")
            return super().send(destination, d)
    store = FakeStore([row(1), row(2), row(3)])
    counts = process_batch(store, {"sms": Flaky()}, "w", now=lambda: NOW)
    assert counts == {"sent": 2, "skipped": 0, "failed": 0, "retrying": 1}


def _bulk(handler):
    s = Settings(notify_sms_provider="bulksmsbd", bulksmsbd_api_key="k", bulksmsbd_sender_id="8809617",
                 _env_file=None)
    return BulkSmsBd(s, client=httpx.Client(transport=httpx.MockTransport(handler)))


def test_bulksmsbd_success_and_error_codes():
    seen = {}

    def ok(req):
        seen["body"] = req.content.decode()
        return httpx.Response(200, json={"response_code": 202, "success_message": "SMS Submitted Successfully"})
    assert _bulk(ok).send("01712345678", row(1)).status == "sent"
    assert "number=8801712345678" in seen["body"]

    with pytest.raises(TransientSendError, match="1007"):
        _bulk(lambda req: httpx.Response(200, json={"response_code": 1007, "error_message": "Balance Insufficient"})
              ).send("01712345678", row(1))
    with pytest.raises(TransientSendError):
        _bulk(lambda req: httpx.Response(503, text="down")).send("01712345678", row(1))


def test_default_config_sends_nothing():
    ch = build_channels(Settings(_env_file=None))
    assert isinstance(ch["email"], LogChannel) and isinstance(ch["sms"], LogChannel)


def test_misconfigured_provider_fails_loudly():
    with pytest.raises(ValueError, match="RESEND_API_KEY"):
        build_channels(Settings(notify_email_provider="resend", _env_file=None))
