"""
HDB Resale Fair Value - Model Fitting

Builds two model artifacts from public/data/hdb_data.arrow:

1. public/data/regression_coefficients.json
   Small legacy-compatible artifact already consumed by the frontend for price
   index adjustment and older fair-value helpers.

2. public/data/regression_model.json
   Higher-accuracy Ridge model with one-hot categorical location/building
   features and train/validation/test metrics. This artifact is generated for
   model evaluation and future non-UI consumers; the current UI does not load it.
"""

import json
from pathlib import Path
from typing import Any, Dict, Iterable, Tuple

import numpy as np
import pandas as pd
import pyarrow.ipc as ipc
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.metrics import (
    mean_absolute_error,
    mean_absolute_percentage_error,
    median_absolute_error,
    r2_score,
)
from sklearn.model_selection import GroupShuffleSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import LabelEncoder, OneHotEncoder, StandardScaler


SCRIPT_DIR = Path(__file__).resolve().parent
PUBLIC_DATA_DIR = (SCRIPT_DIR.parent / "public" / "data").resolve()
ARROW_FILE = PUBLIC_DATA_DIR / "hdb_data.arrow"
PRICE_INDEX_CSV = PUBLIC_DATA_DIR / "HDBResalePriceIndex1Q2009100Quarterly.csv"
OUTPUT_COEFFICIENTS = PUBLIC_DATA_DIR / "regression_coefficients.json"
OUTPUT_MODEL = PUBLIC_DATA_DIR / "regression_model.json"

LEGACY_FEATURE_COLS = [
    "storey_midpoint",
    "remaining_lease_years",
    "mrt_distance_km",
    "floor_area_sqm",
    "flat_type_encoded",
]

NUMERIC_FEATURES = [
    "storey_midpoint",
    "remaining_lease_years",
    "mrt_distance_km",
    "floor_area_sqm",
    "latitude",
    "longitude",
    "month_num",
    "log_floor_area_sqm",
    "log_mrt_distance_m",
]

CATEGORICAL_FEATURES = [
    "town",
    "flat_type",
    "flat_model",
    "storey_range",
    "street_name",
    "address_key",
]

RIDGE_ALPHA = 10.0
ONE_HOT_MIN_FREQUENCY = 3
MIN_REQUIRED_R2 = 0.80


def load_price_index() -> Dict[str, float]:
    """Load HDB Resale Price Index and return quarter -> index."""
    df = pd.read_csv(PRICE_INDEX_CSV)
    return {row["quarter"]: float(row["index"]) for _, row in df.iterrows()}


def quarter_sort_key(quarter: str) -> Tuple[int, int]:
    year, q = quarter.split("-Q")
    return int(year), int(q)


def month_to_quarter(month: str) -> str:
    year, mon = month.split("-")
    quarter = (int(mon) - 1) // 3 + 1
    return f"{year}-Q{quarter}"


def load_arrow_dataframe() -> pd.DataFrame:
    with open(ARROW_FILE, "rb") as f:
        table = ipc.open_file(f).read_all()
    return table.to_pandas()


def prepare_dataframe(df: pd.DataFrame, latest_index: float, latest_quarter: str) -> Tuple[pd.DataFrame, int]:
    """Prepare model features and exclude rows without a published price index."""
    df = df.copy()
    df["quarter"] = df["month"].apply(month_to_quarter)

    has_published_index = df["quarter"].apply(
        lambda q: quarter_sort_key(q) <= quarter_sort_key(latest_quarter)
    )
    excluded_rows = int((~has_published_index).sum())
    df = df[has_published_index].copy()

    transaction_month = pd.to_datetime(df["month"])
    df["adjusted_price_psm"] = df["price_psm"] * (latest_index / df["price_index"])
    df["log_adjusted_price_psm"] = np.log(df["adjusted_price_psm"])
    df["mrt_distance_km"] = df["mrt_distance_m"] / 1000
    df["month_num"] = transaction_month.dt.year * 12 + transaction_month.dt.month
    df["address_key"] = df["block"].astype(str) + "|" + df["street_name"].astype(str)
    df["log_floor_area_sqm"] = np.log(df["floor_area_sqm"])
    df["log_mrt_distance_m"] = np.log1p(df["mrt_distance_m"])

    required_cols = (
        NUMERIC_FEATURES
        + CATEGORICAL_FEATURES
        + LEGACY_FEATURE_COLS[:-1]
        + ["flat_type", "log_adjusted_price_psm", "adjusted_price_psm"]
    )
    return df.dropna(subset=required_cols).copy(), excluded_rows


def build_time_splits(df: pd.DataFrame) -> Dict[str, pd.DataFrame]:
    """Use train / validate / test calendar splits that roll forward automatically."""
    max_year = int(df["month"].str.slice(0, 4).max())
    validation_year = max_year - 2
    test_start_year = max_year - 1

    train = df[df["month"] < f"{validation_year}-01"]
    validate = df[(df["month"] >= f"{validation_year}-01") & (df["month"] < f"{test_start_year}-01")]
    test = df[df["month"] >= f"{test_start_year}-01"]

    if len(train) == 0 or len(validate) == 0 or len(test) == 0:
        ordered = df.sort_values("month")
        train_end = int(len(ordered) * 0.70)
        validate_end = int(len(ordered) * 0.85)
        train = ordered.iloc[:train_end]
        validate = ordered.iloc[train_end:validate_end]
        test = ordered.iloc[validate_end:]

    return {"train": train, "validation": validate, "test": test}


def price_metrics(y_true_log: Iterable[float], y_pred_log: Iterable[float]) -> Dict[str, float]:
    y_true_log = np.asarray(y_true_log)
    y_pred_log = np.asarray(y_pred_log)
    actual_psm = np.exp(y_true_log)
    predicted_psm = np.exp(y_pred_log)
    actual_psf = actual_psm / 10.7639
    predicted_psf = predicted_psm / 10.7639

    return {
        "r_squared_log": float(r2_score(y_true_log, y_pred_log)),
        "mae_log": float(mean_absolute_error(y_true_log, y_pred_log)),
        "mae_psm": float(mean_absolute_error(actual_psm, predicted_psm)),
        "mae_psf": float(mean_absolute_error(actual_psf, predicted_psf)),
        "median_absolute_error_psf": float(median_absolute_error(actual_psf, predicted_psf)),
        "mape": float(mean_absolute_percentage_error(actual_psm, predicted_psm)),
    }


def fit_legacy_model(df: pd.DataFrame, latest_index: float, latest_quarter: str) -> Dict[str, Any]:
    """Fit the original compact linear model for frontend compatibility."""
    legacy_df = df.copy()
    label_encoder = LabelEncoder()
    legacy_df["flat_type_encoded"] = label_encoder.fit_transform(legacy_df["flat_type"].astype(str))
    legacy_df = legacy_df.dropna(subset=LEGACY_FEATURE_COLS + ["log_adjusted_price_psm"])

    model = LinearRegression()
    x = legacy_df[LEGACY_FEATURE_COLS].values
    y = legacy_df["log_adjusted_price_psm"].values
    model.fit(x, y)

    flat_type_mapping = {int(i): label for i, label in enumerate(label_encoder.classes_)}
    summary_stats = {
        "storey_midpoint": {
            "mean": float(legacy_df["storey_midpoint"].mean()),
            "std": float(legacy_df["storey_midpoint"].std()),
        },
        "remaining_lease_years": {
            "mean": float(legacy_df["remaining_lease_years"].mean()),
            "std": float(legacy_df["remaining_lease_years"].std()),
        },
        "mrt_distance_km": {
            "mean": float(legacy_df["mrt_distance_km"].mean()),
            "std": float(legacy_df["mrt_distance_km"].std()),
        },
        "floor_area_sqm": {
            "mean": float(legacy_df["floor_area_sqm"].mean()),
            "std": float(legacy_df["floor_area_sqm"].std()),
        },
    }

    return {
        "intercept": float(model.intercept_),
        "features": {
            "storey_midpoint": float(model.coef_[0]),
            "remaining_lease_years": float(model.coef_[1]),
            "mrt_distance_km": float(model.coef_[2]),
            "floor_area_sqm": float(model.coef_[3]),
            "flat_type_encoded": float(model.coef_[4]),
        },
        "flat_type_mapping": flat_type_mapping,
        "r_squared": float(model.score(x, y)),
        "latest_price_index": float(latest_index),
        "latest_quarter": latest_quarter,
        "n_samples": int(len(legacy_df)),
        "summary_stats": summary_stats,
        "compatibility_note": (
            "Legacy compact linear model retained for existing frontend helpers. "
            "Use enhanced_model_summary/regression_model.json for accuracy metrics."
        ),
    }


def make_ridge_pipeline() -> Pipeline:
    preprocessor = ColumnTransformer(
        transformers=[
            ("num", StandardScaler(), NUMERIC_FEATURES),
            (
                "cat",
                OneHotEncoder(
                    handle_unknown="ignore",
                    min_frequency=ONE_HOT_MIN_FREQUENCY,
                    sparse_output=True,
                ),
                CATEGORICAL_FEATURES,
            ),
        ],
        sparse_threshold=0.3,
    )

    return Pipeline(
        steps=[
            ("preprocessor", preprocessor),
            ("model", Ridge(alpha=RIDGE_ALPHA, solver="lsqr")),
        ]
    )


def evaluate_model(model: Pipeline, splits: Dict[str, pd.DataFrame], full_df: pd.DataFrame) -> Dict[str, Any]:
    metrics: Dict[str, Any] = {}
    feature_cols = NUMERIC_FEATURES + CATEGORICAL_FEATURES

    for name, split_df in {**splits, "full": full_df}.items():
        predictions = model.predict(split_df[feature_cols])
        metrics[name] = {
            "rows": int(len(split_df)),
            **price_metrics(split_df["log_adjusted_price_psm"], predictions),
        }

    return metrics


def evaluate_address_group_holdout(df: pd.DataFrame) -> Dict[str, Any]:
    splitter = GroupShuffleSplit(n_splits=1, test_size=0.20, random_state=42)
    train_idx, test_idx = next(splitter.split(df, groups=df["address_key"]))
    train_df = df.iloc[train_idx]
    test_df = df.iloc[test_idx]

    model = make_ridge_pipeline()
    model.fit(train_df[NUMERIC_FEATURES + CATEGORICAL_FEATURES], train_df["log_adjusted_price_psm"])
    predictions = model.predict(test_df[NUMERIC_FEATURES + CATEGORICAL_FEATURES])

    return {
        "strategy": "GroupShuffleSplit by address_key",
        "train_rows": int(len(train_df)),
        "test_rows": int(len(test_df)),
        **price_metrics(test_df["log_adjusted_price_psm"], predictions),
    }


def extract_ridge_artifact(model: Pipeline, metrics: Dict[str, Any], group_metrics: Dict[str, Any], metadata: Dict[str, Any]) -> Dict[str, Any]:
    preprocessor: ColumnTransformer = model.named_steps["preprocessor"]
    ridge: Ridge = model.named_steps["model"]
    scaler: StandardScaler = preprocessor.named_transformers_["num"]
    transformed_feature_names = preprocessor.get_feature_names_out().tolist()

    return {
        "model_version": 2,
        "model_type": "ridge_onehot_log_adjusted_price_psm",
        "target": "log(price_psm * latest_price_index / price_index)",
        "normalization": {
            "latest_price_index": metadata["latest_price_index"],
            "latest_quarter": metadata["latest_quarter"],
            "excluded_rows_without_published_price_index": metadata[
                "excluded_rows_without_published_price_index"
            ],
        },
        "features": {
            "numeric": NUMERIC_FEATURES,
            "categorical": CATEGORICAL_FEATURES,
            "categorical_min_frequency": ONE_HOT_MIN_FREQUENCY,
        },
        "hyperparameters": {
            "alpha": RIDGE_ALPHA,
            "solver": "lsqr",
        },
        "training": metadata["training"],
        "metrics": metrics,
        "address_group_holdout": group_metrics,
        "intercept": float(ridge.intercept_),
        "numeric_scaler": {
            "feature_names": NUMERIC_FEATURES,
            "mean": [float(x) for x in scaler.mean_],
            "scale": [float(x) for x in scaler.scale_],
        },
        "transformed_feature_names": transformed_feature_names,
        "coefficients": [float(x) for x in ridge.coef_],
    }


def enforce_accuracy_gate(metrics: Dict[str, Any]) -> None:
    """Fail automated updates rather than publishing a model below target."""
    required_splits = ["validation", "test", "full"]
    failures = [
        f"{split} R²={metrics[split]['r_squared_log']:.4f}"
        for split in required_splits
        if metrics[split]["r_squared_log"] < MIN_REQUIRED_R2
    ]
    if failures:
        joined = ", ".join(failures)
        raise RuntimeError(f"Enhanced model failed R² >= {MIN_REQUIRED_R2:.2f} gate: {joined}")


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


def main() -> None:
    print("=" * 60)
    print("HDB Resale - Model Fitting")
    print("=" * 60)

    price_index = load_price_index()
    latest_quarter = max(price_index.keys(), key=quarter_sort_key)
    latest_index = price_index[latest_quarter]
    print(f"\nLatest published price index: {latest_quarter} = {latest_index}")

    print("\nLoading Arrow data...")
    raw_df = load_arrow_dataframe()
    print(f"  Loaded {len(raw_df):,} transactions")

    df, excluded_rows = prepare_dataframe(raw_df, latest_index, latest_quarter)
    print(f"  Usable indexed rows: {len(df):,}")
    if excluded_rows:
        print(f"  Excluded rows without published price index: {excluded_rows:,}")

    print("\nFitting legacy compatibility model...")
    legacy_payload = fit_legacy_model(df, latest_index, latest_quarter)
    print(f"  Legacy in-sample R²: {legacy_payload['r_squared']:.4f}")

    print("\nTraining enhanced Ridge model...")
    splits = build_time_splits(df)
    for name, split_df in splits.items():
        print(f"  {name}: {len(split_df):,} rows ({split_df['month'].min()} to {split_df['month'].max()})")

    full_model = make_ridge_pipeline()
    full_model.fit(df[NUMERIC_FEATURES + CATEGORICAL_FEATURES], df["log_adjusted_price_psm"])

    split_model = make_ridge_pipeline()
    split_model.fit(
        splits["train"][NUMERIC_FEATURES + CATEGORICAL_FEATURES],
        splits["train"]["log_adjusted_price_psm"],
    )
    metrics = evaluate_model(split_model, splits, df)
    group_metrics = evaluate_address_group_holdout(df)
    enforce_accuracy_gate(metrics)

    print("\nEnhanced model metrics:")
    for name, values in metrics.items():
        print(
            f"  {name}: R²={values['r_squared_log']:.4f}, "
            f"MAPE={values['mape'] * 100:.2f}%, "
            f"median AE=${values['median_absolute_error_psf']:.1f}/psf"
        )
    print(
        "  address group holdout: "
        f"R²={group_metrics['r_squared_log']:.4f}, "
        f"MAPE={group_metrics['mape'] * 100:.2f}%"
    )

    metadata = {
        "latest_price_index": float(latest_index),
        "latest_quarter": latest_quarter,
        "excluded_rows_without_published_price_index": int(excluded_rows),
        "training": {
            "rows": int(len(df)),
            "date_min": str(df["month"].min()),
            "date_max": str(df["month"].max()),
            "split_strategy": (
                "Chronological: validation is max indexed year - 2; "
                "test starts at max indexed year - 1. Final exported model is "
                "refit on all usable indexed rows."
            ),
        },
    }

    model_payload = extract_ridge_artifact(full_model, metrics, group_metrics, metadata)
    legacy_payload["enhanced_model_summary"] = {
        "model_file": "regression_model.json",
        "model_type": model_payload["model_type"],
        "target": model_payload["target"],
        "full_corpus_r_squared_log": metrics["full"]["r_squared_log"],
        "validation_r_squared_log": metrics["validation"]["r_squared_log"],
        "test_r_squared_log": metrics["test"]["r_squared_log"],
        "address_group_holdout_r_squared_log": group_metrics["r_squared_log"],
        "excluded_rows_without_published_price_index": excluded_rows,
    }

    write_json(OUTPUT_COEFFICIENTS, legacy_payload)
    write_json(OUTPUT_MODEL, model_payload)

    print(f"\n  Saved compatibility coefficients: {OUTPUT_COEFFICIENTS}")
    print(f"  Saved enhanced model artifact: {OUTPUT_MODEL}")
    print("\n" + "=" * 60)
    print("Model fitting complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
