"""Sends the e-mail / SMS copies of in-app notifications.

Rows are queued in ``notification_deliveries`` by database triggers (migration 023), in the same
transaction as the event. This module claims due rows (``FOR UPDATE SKIP LOCKED``), sends them
*outside* any DB transaction, and records the result. Transient failures retry with exponential
backoff; after ``MAX_ATTEMPTS`` a row is marked failed. A channel whose provider is ``log`` (the
default) is not configured: its rows are marked ``skipped`` and only logged.
"""
from __future__ import annotations

import logging
import re
import smtplib
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Protocol

import httpx

from ..core.config import Settings, get_settings

log = logging.getLogger("resiliomesh.notify")

MAX_ATTEMPTS = 5
BACKOFF_BASE_S = 30
SMS_MAX_CHARS = 320
status = {"sent": 0, "skipped": 0, "failed": 0, "retrying": 0, "last_run": None, "last_error": None}


class TransientSendError(Exception):
    """Worth retrying later (timeouts, 5xx, rate limits)."""


class PermanentSendError(Exception):
    """Retrying will not help (bad number or address, rejected credentials)."""


@dataclass
class Sent:
    status: str  # "sent" | "skipped"
    provider: str
    ref: str | None = None
    note: str | None = None


# ------------------------------------------------------------------ message text
def bd_msisdn(phone: str) -> str:
    """Normalise a Bangladeshi mobile number to 8801XXXXXXXXX."""
    digits = re.sub(r"\D", "", phone or "")
    if digits.startswith("0"):
        digits = "88" + digits
    elif len(digits) == 10 and digits.startswith("1"):
        digits = "880" + digits
    if not re.fullmatch(r"8801[3-9]\d{8}", digits):
        raise PermanentSendError(f"not a Bangladeshi mobile number: {phone!r}")
    return digits


def full_link(app_url: str, link: str | None) -> str:
    return f"{app_url.rstrip('/')}{link}" if link else app_url.rstrip("/")


def compose_email(d: dict, app_url: str) -> tuple[str, str]:
    subject = f"[ResilioMesh] {d['title']}"
    text = (f"{d['title']}\n\n{d['body']}\n\nOpen in ResilioMesh: {full_link(app_url, d.get('link'))}\n\n"
            "You get this because of your role in ResilioMesh (Dhaka flood response).")
    return subject, text


def compose_sms(d: dict, app_url: str) -> str:
    link = full_link(app_url, d.get("link"))
    text = f"ResilioMesh: {d['title']}. {d['body']}"
    room = SMS_MAX_CHARS - len(link) - 1
    if len(text) > room:
        text = text[: max(room - 1, 0)].rstrip() + "…"
    return f"{text} {link}"


# ------------------------------------------------------------------ providers
def _raise_for_http(resp: httpx.Response, provider: str) -> None:
    if resp.status_code < 300:
        return
    msg = f"{provider} HTTP {resp.status_code}: {resp.text[:200]}"
    if resp.status_code == 429 or resp.status_code >= 500:
        raise TransientSendError(msg)
    raise PermanentSendError(msg)


class Channel(Protocol):
    name: str

    def send(self, destination: str, d: dict) -> Sent: ...


class LogChannel:
    def __init__(self, channel: str, app_url: str):
        self.name, self.channel, self.app_url = "log", channel, app_url

    def send(self, destination: str, d: dict) -> Sent:
        log.info("[%s not configured] to=%s title=%s", self.channel, destination, d["title"])
        return Sent("skipped", "log", note=f"{self.channel} provider not configured (NOTIFY_{self.channel.upper()}_PROVIDER=log)")


class ResendEmail:
    name = "resend"
    url = "https://api.resend.com/emails"

    def __init__(self, s: Settings, client: httpx.Client | None = None):
        if not s.resend_api_key:
            raise ValueError("RESEND_API_KEY is empty")
        self.s, self.client = s, client or httpx.Client(timeout=10.0)

    def send(self, destination: str, d: dict) -> Sent:
        subject, text = compose_email(d, self.s.app_public_url)
        try:
            r = self.client.post(self.url, headers={"Authorization": f"Bearer {self.s.resend_api_key}"},
                                 json={"from": self.s.notify_email_from, "to": [destination], "subject": subject, "text": text})
        except httpx.HTTPError as e:
            raise TransientSendError(f"resend: {e}") from e
        _raise_for_http(r, "resend")
        return Sent("sent", self.name, ref=(r.json() or {}).get("id"))


class SmtpEmail:
    name = "smtp"

    def __init__(self, s: Settings):
        if not s.smtp_host:
            raise ValueError("SMTP_HOST is empty")
        self.s = s

    def send(self, destination: str, d: dict) -> Sent:
        subject, text = compose_email(d, self.s.app_public_url)
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = self.s.notify_email_from, destination, subject
        msg.set_content(text)
        try:
            with smtplib.SMTP(self.s.smtp_host, self.s.smtp_port, timeout=15) as smtp:
                if self.s.smtp_starttls:
                    smtp.starttls()
                if self.s.smtp_user:
                    smtp.login(self.s.smtp_user, self.s.smtp_password)
                smtp.send_message(msg)
        except (smtplib.SMTPRecipientsRefused, smtplib.SMTPAuthenticationError) as e:
            raise PermanentSendError(f"smtp: {e}") from e
        except (smtplib.SMTPException, OSError) as e:
            raise TransientSendError(f"smtp: {e}") from e
        return Sent("sent", self.name)


class BulkSmsBd:
    """bulksmsbd.net HTTP API: response_code 202 means submitted. Any other code is retried
    (MAX_ATTEMPTS times) and then marked failed with the provider's message."""
    name = "bulksmsbd"

    def __init__(self, s: Settings, client: httpx.Client | None = None):
        if not (s.bulksmsbd_api_key and s.bulksmsbd_sender_id):
            raise ValueError("BULKSMSBD_API_KEY and BULKSMSBD_SENDER_ID are required")
        self.s, self.client = s, client or httpx.Client(timeout=10.0)

    def send(self, destination: str, d: dict) -> Sent:
        number = bd_msisdn(destination)
        try:
            r = self.client.post(self.s.bulksmsbd_url, data={
                "api_key": self.s.bulksmsbd_api_key, "type": "text", "number": number,
                "senderid": self.s.bulksmsbd_sender_id, "message": compose_sms(d, self.s.app_public_url)})
        except httpx.HTTPError as e:
            raise TransientSendError(f"bulksmsbd: {e}") from e
        _raise_for_http(r, "bulksmsbd")
        try:
            body = r.json()
        except ValueError:
            raise TransientSendError(f"bulksmsbd: unexpected reply {r.text[:120]!r}")
        code = int(body.get("response_code", 0) or 0)
        if code == 202:
            return Sent("sent", self.name, ref=str(body.get("message_id") or "") or None)
        raise TransientSendError(
            f"bulksmsbd code {code}: {body.get('error_message') or body.get('success_message') or ''}".strip())


class TwilioSms:
    name = "twilio"

    def __init__(self, s: Settings, client: httpx.Client | None = None):
        if not (s.twilio_account_sid and s.twilio_auth_token and s.twilio_from):
            raise ValueError("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are required")
        self.s, self.client = s, client or httpx.Client(timeout=10.0)

    def send(self, destination: str, d: dict) -> Sent:
        number = "+" + bd_msisdn(destination)
        url = f"https://api.twilio.com/2010-04-01/Accounts/{self.s.twilio_account_sid}/Messages.json"
        try:
            r = self.client.post(url, auth=(self.s.twilio_account_sid, self.s.twilio_auth_token),
                                 data={"To": number, "From": self.s.twilio_from, "Body": compose_sms(d, self.s.app_public_url)})
        except httpx.HTTPError as e:
            raise TransientSendError(f"twilio: {e}") from e
        _raise_for_http(r, "twilio")
        return Sent("sent", self.name, ref=(r.json() or {}).get("sid"))


def build_channels(s: Settings | None = None) -> dict[str, Channel]:
    s = s or get_settings()
    email_kind, sms_kind = s.notify_email_provider.strip().lower(), s.notify_sms_provider.strip().lower()
    email: Channel = (ResendEmail(s) if email_kind == "resend" else SmtpEmail(s) if email_kind == "smtp"
                      else LogChannel("email", s.app_public_url))
    sms: Channel = (BulkSmsBd(s) if sms_kind == "bulksmsbd" else TwilioSms(s) if sms_kind == "twilio"
                    else LogChannel("sms", s.app_public_url))
    return {"email": email, "sms": sms}


# ------------------------------------------------------------------ outbox processing
class DeliveryStore(Protocol):
    def claim(self, worker_id: str, limit: int) -> list[dict]: ...

    def finish(self, delivery_id, worker_id: str, *, status: str, provider: str | None = None,
               ref: str | None = None, error: str | None = None, retry_at: datetime | None = None) -> None: ...


class PgDeliveryStore:
    def claim(self, worker_id: str, limit: int) -> list[dict]:
        from ..core import db
        with db.tx() as conn:
            return conn.execute("select * from rm_claim_deliveries(%s, %s)", (worker_id, limit)).fetchall()

    def finish(self, delivery_id, worker_id, *, status, provider=None, ref=None, error=None, retry_at=None):
        from ..core import db
        with db.tx() as conn:
            conn.execute(
                """update notification_deliveries
                      set status = %(s)s, provider = coalesce(%(p)s, provider), provider_ref = %(ref)s,
                          last_error = %(e)s, sent_at = case when %(s)s = 'sent' then now() else sent_at end,
                          next_attempt_at = coalesce(%(at)s, next_attempt_at), locked_by = null, locked_at = null
                    where id = %(id)s and locked_by = %(w)s""",
                {"s": status, "p": provider, "ref": ref, "e": (error or None) and error[:500], "at": retry_at,
                 "id": delivery_id, "w": worker_id})


def backoff_s(attempts: int) -> int:
    return BACKOFF_BASE_S * (2 ** max(attempts - 1, 0))


def process_batch(store: DeliveryStore, channels: dict[str, Channel], worker_id: str, limit: int = 20,
                  now=lambda: datetime.now(timezone.utc)) -> dict:
    counts = {"sent": 0, "skipped": 0, "failed": 0, "retrying": 0}
    for d in store.claim(worker_id, limit):
        ch = channels.get(d["channel"])
        try:
            if ch is None:
                raise PermanentSendError(f"no sender for channel {d['channel']!r}")
            res = ch.send(d["destination"], d)
            store.finish(d["id"], worker_id, status=res.status, provider=res.provider, ref=res.ref, error=res.note)
            counts[res.status] += 1
        except PermanentSendError as e:
            store.finish(d["id"], worker_id, status="failed", provider=getattr(ch, "name", None), error=str(e))
            counts["failed"] += 1
            log.warning("delivery %s failed permanently: %s", d["id"], e)
        except Exception as e:  # transient, or an unexpected bug: retry a few times, then give up
            if d["attempts"] >= MAX_ATTEMPTS:
                store.finish(d["id"], worker_id, status="failed", provider=getattr(ch, "name", None),
                             error=f"gave up after {d['attempts']} attempts: {e}")
                counts["failed"] += 1
            else:
                store.finish(d["id"], worker_id, status="queued", provider=getattr(ch, "name", None), error=str(e),
                             retry_at=now() + timedelta(seconds=backoff_s(d["attempts"])))
                counts["retrying"] += 1
            log.warning("delivery %s attempt %s failed: %s", d["id"], d["attempts"], e)
    return counts


_channels: dict[str, Channel] | None = None


def run_pending(store: DeliveryStore | None = None, worker_id: str | None = None) -> dict:
    """Send everything that is due (several batches). Safe to call from several workers at once."""
    global _channels
    s = get_settings()
    if _channels is None:
        _channels = build_channels(s)
    store = store or PgDeliveryStore()
    total = {"sent": 0, "skipped": 0, "failed": 0, "retrying": 0}
    for _ in range(10):
        c = process_batch(store, _channels, f"{worker_id or s.worker_id}-notify", s.notify_batch_size)
        for k in total:
            total[k] += c[k]
        if sum(c.values()) < s.notify_batch_size:
            break
    for k in total:
        status[k] += total[k]
    status["last_run"] = time.time()
    return total


def describe_config(s: Settings | None = None) -> dict:
    s = s or get_settings()
    return {"email_provider": s.notify_email_provider, "sms_provider": s.notify_sms_provider,
            "app_public_url": s.app_public_url}
