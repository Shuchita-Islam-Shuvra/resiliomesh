"""Deterministic rule engine layered on top of the ML score.

ML gives a calibrated estimate; rules encode non-negotiable operational policy
(e.g. 45 cm of standing water is always at least HIGH). Every fired rule is
returned so the decision is fully explainable.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

LEVELS = ["low", "moderate", "high", "critical"]


def level_for(score: float) -> str:
    if score >= 75:
        return "critical"
    if score >= 55:
        return "high"
    if score >= 35:
        return "moderate"
    return "low"


def _floor(score: float, level: str) -> float:
    return max(score, {"low": 0, "moderate": 35, "high": 55, "critical": 75}[level])


@dataclass(frozen=True)
class Rule:
    code: str
    description: str
    when: Callable[[dict], bool]
    apply: Callable[[float], float]


RULES: list[Rule] = [
    Rule("DEPTH_45CM", "Reported water depth >= 45 cm: at least HIGH",
         lambda c: (c.get("water_depth_cm") or 0) >= 45, lambda s: _floor(s, "high")),
    Rule("DEPTH_75CM", "Reported water depth >= 75 cm (knee-deep+): CRITICAL",
         lambda c: (c.get("water_depth_cm") or 0) >= 75, lambda s: _floor(s, "critical")),
    Rule("BLOCKED_ASSET_HEAVY_RAIN", "Linked drain is blocked and >= 50 mm forecast: CRITICAL",
         lambda c: c.get("asset_status") == "blocked" and c.get("rain_next_24h_mm", 0) >= 50,
         lambda s: _floor(s, "critical")),
    Rule("REPORT_CLUSTER", ">= 3 independent reports within 300 m in 6 h: +10",
         lambda c: c.get("recent_reports_6h", 0) >= 3, lambda s: s + 10),
    Rule("MASS_IMPACT", ">= 500 people affected: +8",
         lambda c: (c.get("people_affected") or 0) >= 500, lambda s: s + 8),
    Rule("RELIEF_NEED", "Humanitarian relief requested: at least MODERATE",
         lambda c: c.get("category") == "relief_need", lambda s: _floor(s, "moderate")),
    Rule("DRY_SPELL_CAP", "No rain observed or forecast and depth < 10 cm: cap at MODERATE",
         lambda c: c.get("rain_past_24h_mm", 0) < 1 and c.get("rain_next_24h_mm", 0) < 1
                   and (c.get("water_depth_cm") or 0) < 10,
         lambda s: min(s, 45)),
]


def apply_rules(ml_score: float, context: dict) -> dict:
    score = ml_score
    fired = []
    for rule in RULES:
        try:
            if rule.when(context):
                before = score
                score = rule.apply(score)
                fired.append({"code": rule.code, "description": rule.description,
                              "delta": round(score - before, 2)})
        except Exception:  # a malformed context field must never break scoring
            continue
    score = round(min(100.0, max(0.0, score)), 2)
    return {"score": score, "level": level_for(score), "rules_fired": fired}


def priority(score: float, people_affected: int | None, severity_reported: int | None, age_hours: float) -> int:
    """Dispatch priority 0-100 (higher = earlier)."""
    p = score * 0.6
    p += min(people_affected or 0, 2000) / 2000 * 20
    p += (severity_reported or 1) * 2.5
    p += min(age_hours, 24) / 24 * 7.5     # starvation guard: old reports rise
    return int(round(min(100, p)))
