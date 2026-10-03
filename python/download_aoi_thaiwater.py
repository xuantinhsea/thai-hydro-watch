"""Download ThaiWater station data inside an AOI polygon into wide station CSVs.

Copyright (c) 2026 Nguyen Xuan TINH (Ph.D.), Nippon Koei Co., Ltd. All rights reserved.

Output layout (the same as the page's "Save CSV"):

    row 1   number of stations
    row 2   Station name, <one per column>
    row 3   Variables,    <one per column>
    row 4   lat,          <one per column>
    row 5   lon,          <one per column>
    row 6+  <datetime>,   <values>          (blank = no reading)

Files written to OUT_DIR:
    waterlevel_hourly.csv   water level, m above mean sea level, hourly
    discharge_hourly.csv    discharge, m3/s, hourly
    rainfall_daily.csv      rainfall, mm/day (the provider serves no hourly rain history)
    stations.csv / .gpkg    every station found in the AOI, with data counts

Times are Thai local time (UTC+7), as the provider publishes them.

The AOI defaults to data/aoi.geojson and the output to output/; set the AOI_PATH
and OUT_DIR environment variables to change them (AOI_PATH may be a shapefile).

Usage:
    python download_aoi_thaiwater.py [START_DATE] [END_DATE]   (default: last 30 days)
"""

import datetime
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from shapely.geometry import Point
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parent.parent
AOI_PATH = Path(os.environ.get("AOI_PATH", ROOT / "data" / "aoi.geojson"))
OUT_DIR = Path(os.environ.get("OUT_DIR", ROOT / "output"))

API = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public"
WORKERS = 4
ATTEMPTS = 4

TODAY = datetime.date.today()
START = sys.argv[1] if len(sys.argv) > 1 else (TODAY - datetime.timedelta(days=30)).isoformat()
END = sys.argv[2] if len(sys.argv) > 2 else TODAY.isoformat()


def session() -> requests.Session:
    s = requests.Session()
    retry = Retry(total=3, backoff_factor=1, status_forcelist=(500, 502, 503, 504))
    s.mount("https://", HTTPAdapter(max_retries=retry, pool_maxsize=WORKERS))
    return s


SESSION = session()


def get_json(path: str, params: dict) -> object:
    """GETs an endpoint, retrying the provider's in-body errors as well as HTTP ones.

    ThaiWater sometimes answers a transient database failure with an error
    string in ``data`` ("500: Internal Database Error ... too many open files")
    instead of an HTTP error, so the body is checked too.
    """
    last = None
    for attempt in range(ATTEMPTS):
        try:
            response = SESSION.get(f"{API}/{path}", params=params, timeout=120)
            response.raise_for_status()
            data = response.json().get("data")
            if isinstance(data, str) and data.startswith("5"):
                raise RuntimeError(data[:120])
            return data
        except Exception as exc:  # noqa: BLE001 - retried, then reported
            last = exc
            time.sleep(2 * (attempt + 1))
    print(f"  FAILED {path} {params}: {last}")
    return None


def localised(value) -> str:
    if isinstance(value, dict):
        for key in ("en", "th"):
            text = (value.get(key) or "").strip()
            if text:
                return text
        return ""
    return (value or "").strip() if isinstance(value, str) else ""


def catalogue(path: str, kind: str) -> pd.DataFrame:
    rows = []
    for entry in get_json(path, {}) or []:
        station = entry.get("station") or {}
        if station.get("id") is None:
            continue
        rows.append(
            {
                "id": str(station["id"]),
                "code": (station.get("tele_station_oldcode") or "").strip(),
                "name": localised(station.get("tele_station_name")),
                "lat": pd.to_numeric(station.get("tele_station_lat"), errors="coerce"),
                "lon": pd.to_numeric(station.get("tele_station_long"), errors="coerce"),
                "agency": localised((entry.get("agency") or {}).get("agency_shortname")),
                "province": localised((entry.get("geocode") or {}).get("province_name")),
                "basin": localised((entry.get("basin") or {}).get("basin_name")),
                "kind": kind,
            }
        )
    frame = pd.DataFrame(rows).drop_duplicates("id").dropna(subset=["lat", "lon"])
    return frame.reset_index(drop=True)


def in_aoi(frame: pd.DataFrame, aoi) -> pd.DataFrame:
    points = gpd.GeoSeries([Point(xy) for xy in zip(frame.lon, frame.lat)], crs="EPSG:4326")
    return frame[points.within(aoi).to_numpy()].reset_index(drop=True)


def fetch_waterlevel(station_id: str) -> pd.DataFrame:
    data = get_json(
        "waterlevel_graph",
        {"station_id": station_id, "station_type": "tele_waterlevel", "start_date": START, "end_date": END},
    )
    points = data.get("graph_data") if isinstance(data, dict) else None
    if not points:
        return pd.DataFrame(columns=["level", "discharge"])
    frame = pd.DataFrame(points)
    frame.index = pd.to_datetime(frame["datetime"], errors="coerce")
    frame = frame[frame.index.notna()]
    # 10-minute stations: keep the on-the-hour reading, which is what the hourly
    # stations publish, so every column samples the same instant.
    frame = frame[frame.index.minute == 0]
    out = pd.DataFrame(
        {
            "level": pd.to_numeric(frame.get("value"), errors="coerce"),
            "discharge": pd.to_numeric(frame.get("discharge"), errors="coerce"),
        }
    )
    out = out[~out.index.duplicated(keep="first")]
    out.loc[out.discharge < 0, "discharge"] = None
    return out


def fetch_rain_daily(station_id: str) -> pd.Series:
    months = pd.period_range(START, END, freq="M")
    values = {}
    for month in months:
        data = get_json(
            "rain_monthly_graph",
            {"station_id": station_id, "month": str(month.month), "year": str(month.year)},
        )
        for point in data if isinstance(data, list) else []:
            values[point.get("rainfall_datetime")] = point.get("rainfall_value")
    series = pd.to_numeric(pd.Series(values, dtype=object), errors="coerce")
    series.index = pd.to_datetime(series.index, errors="coerce")
    series = series[series.index.notna()].sort_index()
    return series[series >= 0]


def label(row) -> str:
    if row.code and row.code not in row.name:
        return f"{row.code} {row.name}".strip()
    return row.name or row.code or str(row.Index)


def stamp(t: pd.Timestamp) -> str:
    # Station-column layout timestamp, e.g. "2026-09-01 0:00".
    return f"{t.year}-{t.month:02d}-{t.day:02d} {t.hour}:{t.minute:02d}"


def write_wide(path: Path, stations: pd.DataFrame, table: pd.DataFrame, variable: str) -> int:
    """Writes the station-column layout; returns the number of stations written."""
    table = table.dropna(axis=1, how="all")
    stations = stations.set_index("id").loc[table.columns]
    n = len(table.columns)
    blank = [""] * n
    header = [
        [str(n)] + blank,
        ["Station name"] + [label(row) for row in stations.itertuples()],
        ["Variables"] + [variable] * n,
        ["lat"] + [f"{v:.5f}" for v in stations.lat],
        ["lon"] + [f"{v:.5f}" for v in stations.lon],
    ]
    body = [
        [stamp(t)] + ["" if pd.isna(v) else f"{v:g}" for v in row]
        for t, row in zip(table.index, table.to_numpy())
    ]
    # utf-8-sig so Excel shows the Thai station names correctly.
    pd.DataFrame(header + body).to_csv(path, header=False, index=False, encoding="utf-8-sig")
    return n


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    aoi = gpd.read_file(AOI_PATH).to_crs("EPSG:4326").union_all()
    print(f"Period {START} to {END} (Thai local time)")

    water = in_aoi(catalogue("waterlevel", "waterlevel"), aoi)
    rain = in_aoi(catalogue("rain_24h", "rain"), aoi)
    print(f"In AOI: {len(water)} water level stations, {len(rain)} rain gauges")

    started = time.time()
    with ThreadPoolExecutor(WORKERS) as pool:
        wl_frames = dict(zip(water.id, pool.map(fetch_waterlevel, water.id)))
    print(f"Water level done in {time.time() - started:.0f}s")

    started = time.time()
    with ThreadPoolExecutor(WORKERS) as pool:
        rain_series = dict(zip(rain.id, pool.map(fetch_rain_daily, rain.id)))
    print(f"Rainfall done in {time.time() - started:.0f}s")

    end_of_period = pd.Timestamp(END) + pd.Timedelta(hours=23)
    hours = pd.date_range(START, end_of_period, freq="h")
    level = pd.DataFrame({sid: f["level"] for sid, f in wl_frames.items()}).reindex(hours)
    discharge = pd.DataFrame({sid: f["discharge"] for sid, f in wl_frames.items()}).reindex(hours)
    # Trim trailing hours that have not happened yet.
    last = level.dropna(how="all").index.max()
    level, discharge = level.loc[:last], discharge.loc[:last]

    days = pd.date_range(START, END, freq="D")
    rainfall = pd.DataFrame(rain_series).reindex(days)
    rainfall = rainfall.loc[: rainfall.dropna(how="all").index.max()]

    n_level = write_wide(OUT_DIR / "waterlevel_hourly.csv", water, level, "Water level (m MSL)")
    n_q = write_wide(OUT_DIR / "discharge_hourly.csv", water, discharge, "Discharge (m3/s)")
    n_rain = write_wide(OUT_DIR / "rainfall_daily.csv", rain, rainfall, "Rainfall (mm/day)")

    water["level_values"] = water.id.map(level.count()).fillna(0).astype(int)
    water["discharge_values"] = water.id.map(discharge.count()).fillna(0).astype(int)
    rain["rain_days"] = rain.id.map(rainfall.count()).fillna(0).astype(int)
    stations = pd.concat([water, rain], ignore_index=True)
    stations.to_csv(OUT_DIR / "stations.csv", index=False, encoding="utf-8-sig")
    gpd.GeoDataFrame(
        stations, geometry=gpd.points_from_xy(stations.lon, stations.lat), crs="EPSG:4326"
    ).to_file(OUT_DIR / "stations.gpkg", driver="GPKG")

    print(f"waterlevel_hourly.csv: {n_level} stations, {len(level)} hours to {level.index.max()}")
    print(f"discharge_hourly.csv:  {n_q} stations")
    print(f"rainfall_daily.csv:    {n_rain} gauges, {len(rainfall)} days to {rainfall.index.max().date()}")


if __name__ == "__main__":
    main()
