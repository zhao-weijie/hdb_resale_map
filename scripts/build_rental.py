"""Build the compact, static HDB whole-flat rental dataset used by the map.

The data.gov.sg rental publication does not include a unit, floor, floor area or
lease commencement date.  This builder deliberately keeps it separate from
resale data so consumers cannot accidentally treat those fields as observed
rental attributes.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import Any

import pandas as pd
import requests

from datagov_client import DATAGOV_DOWNLOAD_POLL_DELAY_SECONDS, datagov_get


SCRIPT_DIR = Path(__file__).resolve().parent
PUBLIC_DATA_DIR = SCRIPT_DIR.parent / "public" / "data"
RAW_DATA_FILE = SCRIPT_DIR / "data" / "hdb_rental_raw.csv"
MANIFEST_FILE = PUBLIC_DATA_DIR / "rental_manifest.json"
DATASET_ID = "d_c9f57187485a850908655db0e8cfe651"
DATAGOV_API_BASE = "https://api-open.data.gov.sg/v1/public/api/datasets"
SOURCE_URL = f"https://data.gov.sg/datasets/{DATASET_ID}/view"

MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
FLAT_TYPE_RE = re.compile(r"^(1|2|3|4|5)\s*(?:-|\s)?(?:ROOM|RM)$", re.IGNORECASE)


def download_hdb_rental_csv() -> pd.DataFrame:
    """Download the current HDB rental CSV using data.gov.sg's polling API."""
    print("Downloading HDB whole-flat rental data from data.gov.sg...")
    response = datagov_get(f"{DATAGOV_API_BASE}/{DATASET_ID}/initiate-download", timeout=30)
    response.raise_for_status()
    payload = response.json()

    url = None
    for _ in range(30):
        url = payload.get("data", {}).get("url")
        if url:
            break
        time.sleep(DATAGOV_DOWNLOAD_POLL_DELAY_SECONDS)
        response = datagov_get(f"{DATAGOV_API_BASE}/{DATASET_ID}/poll-download", timeout=30)
        response.raise_for_status()
        payload = response.json()
    if not url:
        raise RuntimeError("Timed out waiting for data.gov.sg rental download URL")

    csv_response = requests.get(url, timeout=180)
    csv_response.raise_for_status()
    return pd.read_csv(StringIO(csv_response.text))


def load_source_data() -> pd.DataFrame:
    """Load an explicit local fixture or fetch fresh source data."""
    source_path = os.getenv("HDB_RENTAL_CSV")
    if source_path:
        path = Path(source_path)
        print(f"Loading HDB rental data from local CSV: {path}")
        df = pd.read_csv(path)
    else:
        df = download_hdb_rental_csv()

    RAW_DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(RAW_DATA_FILE, index=False)
    print(f"Loaded {len(df):,} rental source rows")
    return df


def _normalise_text(value: Any) -> str:
    if pd.isna(value):
        return ""
    return " ".join(str(value).strip().upper().split())


def normalise_flat_type(value: Any) -> str:
    """Return the resale-compatible room labels without inventing categories."""
    text = _normalise_text(value)
    match = FLAT_TYPE_RE.fullmatch(text)
    if match:
        return f"{match.group(1)} ROOM"
    aliases = {
        "EXECUTIVE": "EXECUTIVE",
        "MULTI-GENERATION": "MULTI-GENERATION",
        "MULTI GENERATION": "MULTI-GENERATION",
    }
    return aliases.get(text, text)


def normalise_month(value: Any) -> str:
    """Convert supported data.gov month forms to YYYY-MM, returning empty if invalid."""
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if MONTH_RE.fullmatch(text):
        return text
    parsed = pd.to_datetime(text, errors="coerce")
    if pd.isna(parsed):
        return ""
    return f"{parsed.year:04d}-{parsed.month:02d}"


def normalise_rentals(source: pd.DataFrame, start_month: str) -> tuple[list[list[Any]], dict[str, int]]:
    """Select documented fields and reject invalid rows without deduplicating records."""
    columns = {str(column).strip().lower(): column for column in source.columns}
    month_column = columns.get("rent_approval_date") or columns.get("month")
    required = {
        "town": columns.get("town"),
        "block": columns.get("block"),
        "street_name": columns.get("street_name"),
        "flat_type": columns.get("flat_type"),
        "monthly_rent": columns.get("monthly_rent"),
    }
    if month_column is None or any(column is None for column in required.values()):
        names = ", ".join(str(column) for column in source.columns)
        raise ValueError(f"Rental CSV is missing required columns; found: {names}")
    if not MONTH_RE.fullmatch(start_month):
        raise ValueError(f"Invalid HDB_RENTAL_START_MONTH: {start_month}")

    rows: list[list[Any]] = []
    rejected = {"invalid": 0, "beforeStart": 0}
    for _, row in source.iterrows():
        month = normalise_month(row[month_column])
        town = _normalise_text(row[required["town"]])
        block = _normalise_text(row[required["block"]])
        street = _normalise_text(row[required["street_name"]])
        flat_type = normalise_flat_type(row[required["flat_type"]])
        rent = pd.to_numeric(row[required["monthly_rent"]], errors="coerce")
        if not month or not town or not block or not street or not flat_type or pd.isna(rent) or rent <= 0:
            rejected["invalid"] += 1
            continue
        if month < start_month:
            rejected["beforeStart"] += 1
            continue
        rows.append([month, town, block, street, flat_type, float(rent)])

    rows.sort(key=lambda row: (row[0], row[1], row[2], row[3], row[4], row[5]))
    return rows, rejected


def _canonical_payload(payload: dict[str, Any]) -> str:
    """Serialize source content without the wall-clock build timestamp."""
    canonical = dict(payload)
    canonical.pop("generatedAt", None)
    return json.dumps(canonical, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _is_utc_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def generated_at_for_payload(payload: dict[str, Any]) -> str:
    """Reuse a timestamp only when the previous canonical payload is identical."""
    try:
        previous_manifest = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
        previous_url = previous_manifest.get("url")
        if not isinstance(previous_url, str) or Path(previous_url).name != previous_url:
            raise ValueError("Invalid previous rental asset URL")
        previous_payload = json.loads((PUBLIC_DATA_DIR / previous_url).read_text(encoding="utf-8"))
        previous_generated_at = previous_payload.get("generatedAt")
        if _is_utc_timestamp(previous_generated_at) and _canonical_payload(previous_payload) == _canonical_payload(payload):
            return previous_generated_at
    except (FileNotFoundError, ValueError, json.JSONDecodeError, OSError, TypeError):
        pass
    return utc_now()


def build_dataset(source: pd.DataFrame, start_month: str) -> tuple[dict[str, Any], dict[str, Any]]:
    rows, rejected = normalise_rentals(source, start_month)
    if not rows:
        raise ValueError("No valid rental records remain after normalisation")
    payload = {
        "version": 1,
        # The timestamp is selected after content is assembled so an unchanged
        # source reuses its prior asset and a changed source records build time.
        "generatedAt": "",
        "generatedAtKind": "build",
        "source": {"datasetId": DATASET_ID, "url": SOURCE_URL},
        "columns": ["month", "town", "block", "street_name", "flat_type", "monthly_rent"],
        "records": rows,
    }
    generated_at = generated_at_for_payload(payload)
    payload["generatedAt"] = generated_at
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    filename = f"rental_data-{digest[:12]}.json"
    output_path = PUBLIC_DATA_DIR / filename
    output_path.write_bytes(encoded)
    manifest = {
        "version": 1,
        "generatedAt": generated_at,
        "minMonth": rows[0][0],
        "maxMonth": rows[-1][0],
        "rows": len(rows),
        "url": filename,
        "sha256": digest,
        "source": {"datasetId": DATASET_ID, "url": SOURCE_URL},
        "rejected": rejected,
    }
    return payload, manifest


def write_outputs(manifest: dict[str, Any]) -> None:
    MANIFEST_FILE.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    active = manifest["url"]
    for stale in PUBLIC_DATA_DIR.glob("rental_data-*.json"):
        if stale.name != active:
            stale.unlink()
            print(f"Removed stale rental asset {stale.name}")
    print(f"Saved {active}: {manifest['rows']:,} records ({manifest['minMonth']} to {manifest['maxMonth']})")
    print(f"Saved {MANIFEST_FILE.name}")


def main() -> None:
    start_month = os.getenv("HDB_RENTAL_START_MONTH", "2021-01")
    source = load_source_data()
    _, manifest = build_dataset(source, start_month)
    write_outputs(manifest)


if __name__ == "__main__":
    main()
