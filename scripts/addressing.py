"""Shared address normalization for geocoding and generated assets."""

from __future__ import annotations

from typing import Any

import pandas as pd


def canonical_address_part(value: Any) -> str:
    """Normalize a block or street component without changing its meaning."""
    if pd.isna(value):
        return ""
    return " ".join(str(value).strip().upper().split())


def canonical_address_key(block: Any, street_name: Any) -> str:
    """Return the stable cross-language address key used by the registry."""
    return f"{canonical_address_part(block)}|{canonical_address_part(street_name)}"
