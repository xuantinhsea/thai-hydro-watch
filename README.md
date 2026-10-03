# Thai Hydro Watch

Live water level, discharge and rainfall from Thailand's ThaiWater network
(Hydro-Informatics Institute, HII) for the stations inside your area of interest,
with data checks and CSV export.

**Open the app:** https://xuantinhsea.github.io/thai-hydro-watch/

Everything runs in your browser. The page asks the ThaiWater Open API for the
station lists and time series directly; there is no server and no account.

## What it does

- **Pick a period, press Fetch data.** On opening, the page loads the last 30 days
  for every station inside the study area. For another period, set the dates (or
  use the 7 / 30 / 90-day buttons) and press **Fetch data**.
- **Four variables.** Water level (m above mean sea level, hourly), discharge
  (m³/s, hourly), daily rainfall (mm/day) and hourly rainfall (mm/h).
- **Checks every series.** Each station is marked OK, Gaps (50–90% of readings),
  Sparse (under 50%) or Check (possible spikes, stuck sensors, extreme totals).
- **Map, hydrographs and an every-station view.** Click a station on the map, in
  the overview or in the table to see its charts.
- **Saves CSV files.**
  - *Save … CSV* writes the current variable for every station in view.
  - *Station list* writes station metadata with each station's check results.
  - *Save CSV* beside each chart writes that station alone.
- **Built-in study area.** The area of interest is part of the site, so the only
  thing to choose is the period.

### CSV layout

The table files use a station-column layout:

```
359,,,,
Station name,C.67 สะพานหัวเวียง,CPY009 Chao Phraya 9,THA006 Tha Chedi Temple (TTC06),...
Variables,Water level (m MSL),Water level (m MSL),Water level (m MSL),...
lat,14.36851,14.41580,14.15657,...
lon,100.41439,100.44071,100.12744,...
2026-09-01 0:00,,1.894,1.232,...
2026-09-01 1:00,1.99,1.939,1.279,...
```

Blank cells have no reading. Times are Thai local time (UTC+7). Files are UTF-8
with a byte-order mark so that Excel shows Thai station names correctly.

## What ThaiWater publishes

| Variable | Time step | History |
|---|---|---|
| Water level, discharge | hourly (some stations every 10 min; sampled on the hour) | from about 2020 |
| Rainfall | daily totals | any date |
| Rainfall | hourly | only 00:00 yesterday to now |

For hourly rainfall further back, run `python/download_aoi_rain_hourly.py` once a
day to build your own archive, or use `python/download_aoi_persiann_ccs.py` for
PERSIANN-CCS hourly satellite rainfall (0.04°) over the area of interest.

## Run it locally

Open `index.html` in a browser; it works straight from disk. To change the default
area of interest, replace the GeoJSON object in `data/aoi.js` (and `data/aoi.geojson`,
which the Python scripts read).

## Python scripts

```
pip install -r python/requirements.txt
python python/download_aoi_thaiwater.py 2026-09-01 2026-10-03   # water level, discharge, daily rain
python python/download_aoi_rain_hourly.py                        # hourly rain archive (run daily)
python python/download_aoi_persiann_ccs.py 2026-09-01            # satellite hourly rain grid
```

Output goes to `output/`. Set `AOI_PATH` (GeoJSON or shapefile) and `OUT_DIR` to
change the area or the folder.

## Data sources

- Station data: ThaiWater Open API, Hydro-Informatics Institute (HII),
  https://www.thaiwater.net/
- Satellite rainfall: PERSIANN-CCS, Center for Hydrometeorology and Remote Sensing,
  University of California, Irvine
- Map: Natural Earth (public domain)

## Author and copyright

© 2026 Nguyen Xuan TINH (Ph.D.). All rights reserved.

**Nguyen Xuan TINH (Ph.D.)**
Nippon Koei Co., Ltd., Water Resources & Energy Dept.
〒102-8539: 5-4 Kojimachi, Chiyoda-ku, Tokyo, JAPAN
Tel: +81-80-4689-7461
E-mail: tinh-ng@n-koei.jp
URL: https://www.n-koei.co.jp/consulting/english/
