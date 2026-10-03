"""Download PERSIANN-CCS hourly satellite rainfall over the AOI on its native 0.04 deg grid.

Copyright (c) 2026 Nguyen Xuan TINH (Ph.D.), Nippon Koei Co., Ltd. All rights reserved.

Source: Center for Hydrometeorology and Remote Sensing (CHRS), University of
California, Irvine. PERSIANN-CCS, hourly, 0.04 deg, 60N-60S, no account needed:
https://persiann.eng.uci.edu/CHRSdata/PERSIANN-CCS/hrly/

Each provider file is one UTC hour (HH:00-HH:59) for the whole globe. Only the
AOI window is kept, in output/persiann_ccs_cache/, so a rerun downloads
only new hours (plus the last 3 days, which the provider reprocesses).

Output, in output/:
    rainfall_hourly_persiann_ccs.csv    station-column layout, one column per grid cell
    persiann_ccs_grid.gpkg              the grid cell centres, for QGIS

Times are Thai local time (UTC+7) and label the END of each hour: the value at
"2026-09-01 8:00" is the rain from 07:00 to 08:00 Thai time.

Usage:
    python download_aoi_persiann_ccs.py [START_DATE]      (default: 30 days ago, Thai time)
"""

import gzip
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
import shapely

from download_aoi_thaiwater import AOI_PATH, OUT_DIR, session

BASE = "https://persiann.eng.uci.edu/CHRSdata/PERSIANN-CCS/hrly"
ROWS, COLS, RES = 3000, 9000, 0.04
TOP, LEFT = 59.98, 0.02  # centre of the north-west pixel
CACHE = OUT_DIR / "persiann_ccs_cache"
OUT_CSV = OUT_DIR / "rainfall_hourly_persiann_ccs.csv"
OUT_GRID = OUT_DIR / "persiann_ccs_grid.gpkg"
THAI = pd.Timedelta(hours=7)
REFRESH = pd.Timedelta(days=3)
WORKERS = 4

START = sys.argv[1] if len(sys.argv) > 1 else (pd.Timestamp.now().normalize() - pd.Timedelta(days=30)).strftime("%Y-%m-%d")
SESSION = session()


def file_name(start_utc: pd.Timestamp) -> str:
    return f"rgccs1h{start_utc:%y}{start_utc.dayofyear:03d}{start_utc:%H}.bin.gz"


def available(years) -> set[str]:
    names = set()
    for year in years:
        listing = SESSION.get(f"{BASE}/{year}/", timeout=120).text
        names.update(re.findall(r'href="(rgccs1h\d{7}\.bin\.gz)"', listing))
    return names


def window(aoi) -> tuple[slice, slice]:
    west, south, east, north = aoi.bounds
    r0 = int(np.floor((TOP - north) / RES)) - 1
    r1 = int(np.ceil((TOP - south) / RES)) + 2
    c0 = int(np.floor((west - LEFT) / RES)) - 1
    c1 = int(np.ceil((east - LEFT) / RES)) + 2
    return slice(r0, r1), slice(c0, c1)


def fetch(start_utc: pd.Timestamp, rows: slice, cols: slice) -> bool:
    name = file_name(start_utc)
    for attempt in range(4):
        try:
            response = SESSION.get(f"{BASE}/{start_utc.year}/{name}", timeout=180)
            response.raise_for_status()
            grid = np.frombuffer(gzip.decompress(response.content), dtype=">i2").reshape(ROWS, COLS)
            np.save(CACHE / f"{start_utc:%Y%m%d%H}.npy", grid[rows, cols].astype(np.int16))
            return True
        except Exception as exc:  # noqa: BLE001 - retried, then reported
            last = exc
            time.sleep(3 * (attempt + 1))
    print(f"  FAILED {name}: {last}")
    return False


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    aoi = gpd.read_file(AOI_PATH).to_crs("EPSG:4326").union_all()
    rows, cols = window(aoi)

    # Thai hour 00:00-01:00 on START is the UTC hour starting 7 h earlier.
    first = pd.Timestamp(START) - THAI
    names = available(range(first.year, pd.Timestamp.now().year + 1))
    hours = [t for t in pd.date_range(first, pd.Timestamp.now(), freq="h") if file_name(t) in names]
    if not hours:
        sys.exit("No PERSIANN-CCS files found for this period.")
    latest = hours[-1]
    todo = [t for t in hours if not (CACHE / f"{t:%Y%m%d%H}.npy").exists() or t > latest - REFRESH]
    print(f"{len(hours)} hourly files available, {first} to {latest} UTC; downloading {len(todo)}")

    started = time.time()
    with ThreadPoolExecutor(WORKERS) as pool:
        for done, ok in enumerate(pool.map(lambda t: fetch(t, rows, cols), todo), 1):
            if done % 100 == 0:
                print(f"  {done}/{len(todo)} files, {time.time() - started:.0f}s")
    print(f"Downloads finished in {time.time() - started:.0f}s")

    # Cell centres in the window, kept when they fall inside the AOI.
    lats = TOP - RES * np.arange(rows.start, rows.stop)
    lons = LEFT + RES * np.arange(cols.start, cols.stop)
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    inside = shapely.contains_xy(aoi, lon_grid, lat_grid)
    cell_lat, cell_lon = lat_grid[inside], lon_grid[inside]
    ids = [f"G{i:05d}" for i in range(1, inside.sum() + 1)]
    print(f"{len(ids)} grid cells inside the AOI")

    present = [t for t in hours if (CACHE / f"{t:%Y%m%d%H}.npy").exists()]
    values = np.full((len(present), len(ids)), np.nan, dtype=np.float32)
    for i, t in enumerate(present):
        raw = np.load(CACHE / f"{t:%Y%m%d%H}.npy")[inside].astype(np.float32)
        raw[raw < 0] = np.nan  # the provider's no-data flag
        values[i] = raw / 100.0
    thai_end = [t + THAI + pd.Timedelta(hours=1) for t in present]

    header = [
        [str(len(ids))] + [""] * len(ids),
        ["Station name"] + ids,
        ["Variables"] + ["Rainfall (mm/h)"] * len(ids),
        ["lat"] + [f"{v:.2f}" for v in cell_lat],
        ["lon"] + [f"{v:.2f}" for v in cell_lon],
    ]
    with open(OUT_CSV, "w", encoding="utf-8", newline="") as handle:
        for row in header:
            handle.write(",".join(row) + "\n")
        for stamp, row in zip(thai_end, values):
            cells = ["" if np.isnan(v) else ("0" if v == 0 else f"{v:g}") for v in row.round(2)]
            handle.write(f"{stamp.year}-{stamp.month:02d}-{stamp.day:02d} {stamp.hour}:{stamp.minute:02d}," + ",".join(cells) + "\n")

    gpd.GeoDataFrame(
        {"cell_id": ids, "lat": cell_lat.round(2), "lon": cell_lon.round(2),
         "total_mm": np.nansum(values, axis=0).round(1)},
        geometry=gpd.points_from_xy(cell_lon, cell_lat), crs="EPSG:4326",
    ).to_file(OUT_GRID, driver="GPKG")

    missing_hours = len(hours) - len(present)
    print(f"rainfall_hourly_persiann_ccs.csv: {len(ids)} cells x {len(present)} hours, "
          f"{thai_end[0]} to {thai_end[-1]} Thai time (hour ending); {missing_hours} hours failed")
    print(f"{OUT_CSV.stat().st_size / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
