"""Small data.gov.sg HTTP helpers with rate-limit aware retries."""

import os
import random
import time
from email.utils import parsedate_to_datetime
from typing import Optional

import requests


DATAGOV_API_KEY = os.getenv("DATAGOV_API_KEY") or os.getenv("DATA_GOV_API_KEY")
DATAGOV_DOWNLOAD_POLL_DELAY_SECONDS = 12


def datagov_headers() -> dict:
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if DATAGOV_API_KEY:
        headers["x-api-key"] = DATAGOV_API_KEY
    return headers


def _retry_after_seconds(value: Optional[str]) -> Optional[float]:
    if not value:
        return None

    try:
        return max(0.0, float(value))
    except ValueError:
        pass

    try:
        retry_at = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None

    return max(0.0, retry_at.timestamp() - time.time())


def datagov_get(url: str, *, timeout: int = 30, max_attempts: int = 6) -> requests.Response:
    """GET a data.gov.sg URL, backing off on rate limits and transient server errors."""
    last_response = None

    for attempt in range(1, max_attempts + 1):
        response = requests.get(url, headers=datagov_headers(), timeout=timeout)
        if response.status_code not in (429, 500, 502, 503, 504):
            return response

        last_response = response
        if attempt == max_attempts:
            break

        retry_after = _retry_after_seconds(response.headers.get("Retry-After"))
        backoff = min(180.0, 10.0 * (2 ** (attempt - 1)))
        delay = retry_after if retry_after is not None else backoff + random.uniform(0.0, 3.0)

        print(
            f"  data.gov.sg returned HTTP {response.status_code}; "
            f"retrying in {delay:.1f}s ({attempt}/{max_attempts})..."
        )
        time.sleep(delay)

    assert last_response is not None
    return last_response
