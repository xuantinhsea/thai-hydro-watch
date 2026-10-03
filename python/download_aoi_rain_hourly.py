"""Collect ThaiWater hourly rainfall for every rain gauge inside the AOI.

Copyright (c) 2026 Nguyen Xuan TINH (Ph.D.), Nippon Koei Co., Ltd. All rights reserved.

ThaiWater publishes hourly rainfall only for a rolling window, from 00:00
yesterday up to the latest hour (24 to 48 hours). No public endpoint serves
older hours, so this script keeps its own archive: run it at least once a day
and the archive grows into a continuous hourly record.

Files in output/:
    rainfall_hourly_archive.csv   long format: station_id, datetime, rainfall_mm
    rainfall_hourly.csv           station-column layout, rebuilt from the archive

Times are Thai local time (UTC+7), as the provider publishes them.

Usage:
    python download_aoi_rain_hourly.py
"""

import time
from concurrent.futures import ThreadPoolExecutor

import geopandas as gpd
import pandas as pd

from download_aoi_thaiwater import AOI_PATH, OUT_DIR, WORKERS, catalogue, get_json, in_aoi, write_wide

ARCHIVE = OUT_DIR / "rainfall_hourly_archive.csv"
WIDE = OUT_DIR / "rainfall_hourly.csv"


def fetch_hourly(station_id: str) -> pd.DataFrame:
    data = get_json("rain_24h_graph", {"station_id": station_id})
    if not isinstance(data, list) or not data:
        return pd.DataFrame(columns=["station_id", "datetime", "rainfall_mm"])
    frame = pd.DataFrame(data)
    return pd.DataFrame(
        {
            "station_id": station_id,
            "datetime": pd.to_datetime(frame["rainfall_datetime"], errors="coerce"),
            "rainfall_mm": pd.to_numeric(frame["rainfall_value"], errors="coerce"),
        }
    ).dropna(subset=["datetime"])


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    aoi = gpd.read_file(AOI_PATH).to_crs("EPSG:4326").union_all()
    gauges = in_aoi(catalogue("rain_24h", "rain"), aoi)
    print(f"{len(gauges)} rain gauges in the AOI")

    started = time.time()
    with ThreadPoolExecutor(WORKERS) as pool:
        fresh = pd.concat(list(pool.map(fetch_hourly, gauges.id)), ignore_index=True)
    fresh = fresh.dropna(subset=["rainfall_mm"])
    fresh = fresh[fresh.rainfall_mm >= 0]
    print(f"Downloaded {len(fresh)} hourly values in {time.time() - started:.0f}s, "
          f"{fresh.datetime.min()} to {fresh.datetime.max()}")

    if ARCHIVE.exists():
        old = pd.read_csv(ARCHIVE, dtype={"station_id": str}, parse_dates=["datetime"])
        before = len(old)
        # The newest download wins where the provider has revised an hour.
        archive = pd.concat([old, fresh], ignore_index=True).drop_duplicates(
            subset=["station_id", "datetime"], keep="last"
        )
        print(f"Archive: {before} values before, {len(archive)} after")
    else:
        archive = fresh
    archive = archive.sort_values(["station_id", "datetime"])
    archive.to_csv(ARCHIVE, index=False, date_format="%Y-%m-%d %H:%M")

    table = archive.pivot(index="datetime", columns="station_id", values="rainfall_mm")
    hours = pd.date_range(table.index.min(), table.index.max(), freq="h")
    table = table.reindex(hours)
    known = pd.concat([gauges, _known_gauges()], ignore_index=True).drop_duplicates("id")
    table = table[[c for c in known.id if c in table.columns]]
    n = write_wide(WIDE, known, table, "Rainfall (mm/h)")
    print(f"rainfall_hourly.csv: {n} gauges, {len(table)} hours, {hours[0]} to {hours[-1]}")


def _known_gauges() -> pd.DataFrame:
    """Gauges from earlier runs that may since have left the live catalogue."""
    path = OUT_DIR / "stations.csv"
    if not path.exists():
        return pd.DataFrame(columns=["id"])
    stations = pd.read_csv(path, dtype={"id": str}, keep_default_na=False, na_values=[""], encoding="utf-8-sig")
    stations = stations[stations.kind == "rain"]
    for column in ("code", "name"):
        stations[column] = stations[column].fillna("").astype(str)
    return stations


if __name__ == "__main__":
    main()
