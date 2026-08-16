#!/usr/bin/env python3
"""Render continuous waveforms and phase picks from a SeismicX pick table."""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter
from html import escape
from pathlib import Path
from typing import Any

import numpy as np
from obspy import Stream, UTCDateTime, read


PHASE_COLORS = {
    "P": "#d97706",
    "S": "#2563eb",
}
FALLBACK_PHASE_COLOR = "#7c3aed"
TRACE_COLOR = "#263241"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--picks", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-traces", type=int, default=8)
    parser.add_argument("--max-points", type=int, default=6000)
    return parser.parse_args()


def read_pick_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = [dict(row) for row in csv.DictReader(handle)]
    if not rows:
        raise ValueError(f"No picks found in {path}")
    return rows


def station_key(row: dict[str, str]) -> tuple[str, str]:
    return row.get("network", "").strip(), row.get("station", "").strip()


def select_station(rows: list[dict[str, str]]) -> tuple[tuple[str, str], list[dict[str, str]]]:
    populated = [station_key(row) for row in rows if station_key(row)[1]]
    if not populated:
        return ("", ""), rows
    selected = Counter(populated).most_common(1)[0][0]
    return selected, [row for row in rows if station_key(row) == selected]


def resolve_waveform_path(raw: str, picks_path: Path) -> Path:
    candidate = Path(raw).expanduser()
    if candidate.is_absolute():
        return candidate
    cwd_candidate = (Path.cwd() / candidate).resolve()
    if cwd_candidate.exists():
        return cwd_candidate
    return (picks_path.parent / candidate).resolve()


def waveform_paths(rows: list[dict[str, str]], picks_path: Path) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for row in rows:
        for raw in row.get("waveform_path", "").split(";"):
            raw = raw.strip()
            if not raw:
                continue
            path = resolve_waveform_path(raw, picks_path)
            key = str(path).casefold()
            if key not in seen:
                seen.add(key)
                result.append(path)
    if not result:
        raise ValueError("The pick table does not contain waveform_path values")
    missing = [str(path) for path in result if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Waveform file not found: {missing[0]}")
    return result


def load_stream(paths: list[Path], selected_station: tuple[str, str]) -> Stream:
    stream = Stream()
    for path in paths:
        stream += read(str(path))
    network, station = selected_station
    if station:
        matching = stream.select(station=station)
        if network:
            matching = matching.select(network=network)
        if matching:
            stream = matching
    if not stream:
        raise ValueError("No waveform traces are available for the selected station")
    stream.sort(keys=["network", "station", "location", "channel", "starttime"])
    return stream


def envelope(data: np.ndarray, max_points: int) -> tuple[np.ndarray, np.ndarray]:
    count = data.size
    if count <= max_points:
        indices = np.arange(count, dtype=np.int64)
        return indices, data

    bucket_count = max(1, max_points // 2)
    step = max(1, math.ceil(count / bucket_count))
    full = count // step
    output_indices: list[int] = []
    output_values: list[float] = []

    if full:
        body = data[: full * step].reshape(full, step)
        min_offsets = np.nanargmin(body, axis=1)
        max_offsets = np.nanargmax(body, axis=1)
        for bucket, (min_offset, max_offset) in enumerate(zip(min_offsets, max_offsets)):
            for offset in sorted((int(min_offset), int(max_offset))):
                index = bucket * step + offset
                output_indices.append(index)
                output_values.append(float(data[index]))

    tail_start = full * step
    if tail_start < count:
        tail = data[tail_start:]
        for offset in sorted((int(np.nanargmin(tail)), int(np.nanargmax(tail)))):
            output_indices.append(tail_start + offset)
            output_values.append(float(tail[offset]))

    return np.asarray(output_indices), np.asarray(output_values)


def normalized_data(trace: Any) -> np.ndarray:
    data = np.asarray(trace.data, dtype=np.float64)
    if data.size == 0:
        return data
    finite = np.isfinite(data)
    if not finite.any():
        return np.zeros_like(data)
    fill = float(np.nanmedian(data[finite]))
    data = np.where(finite, data, fill)
    data -= np.median(data)
    scale = float(np.percentile(np.abs(data), 99.5))
    if not math.isfinite(scale) or scale <= 0:
        scale = float(np.max(np.abs(data)))
    if not math.isfinite(scale) or scale <= 0:
        return np.zeros_like(data)
    return np.clip(data / scale, -1.2, 1.2)


def phase_family(phase: str) -> str:
    value = phase.strip().upper()
    if value.startswith("P"):
        return "P"
    if value.startswith("S"):
        return "S"
    return "other"


def render(
    stream: Stream,
    rows: list[dict[str, str]],
    output_path: Path,
    max_traces: int,
    max_points: int,
) -> tuple[int, int]:
    traces = list(stream[: max(1, max_traces)])
    origin = min(trace.stats.starttime for trace in traces)
    end = max(trace.stats.endtime for trace in traces)
    duration = max(0.001, float(end - origin))
    width = 1400
    left = 190
    right = 30
    top = 64
    bottom = 54
    row_height = 72
    plot_width = width - left - right
    plot_height = row_height * len(traces)
    height = top + plot_height + bottom

    elements = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="Continuous waveforms and phase picks">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        '<style>text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;fill:#4b5563}.title{font-size:18px;font-weight:600;fill:#202833}.label{font-size:12px}.tick{font-size:11px;fill:#77808d}.phase{font-size:11px;font-weight:600}</style>',
        f'<text class="title" x="{left}" y="28">Continuous waveforms and phase picks</text>',
    ]

    tick_count = 6
    for tick in range(tick_count + 1):
        fraction = tick / tick_count
        x = left + fraction * plot_width
        seconds = fraction * duration
        elements.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top + plot_height}" stroke="#e1e5eb" stroke-width="1"/>')
        elements.append(f'<text class="tick" x="{x:.1f}" y="{top + plot_height + 23}" text-anchor="middle">{seconds:.1f}</text>')

    for index, trace in enumerate(traces):
        center = top + row_height * (index + 0.5)
        elements.append(f'<line x1="{left}" y1="{center:.1f}" x2="{left + plot_width}" y2="{center:.1f}" stroke="#edf0f4" stroke-width="1"/>')
        elements.append(f'<text class="label" x="{left - 14}" y="{center + 4:.1f}" text-anchor="end">{escape(trace.id)}</text>')
        data = normalized_data(trace)
        indices, values = envelope(data, max(200, max_points))
        if indices.size == 0:
            continue
        seconds = float(trace.stats.starttime - origin) + indices / float(trace.stats.sampling_rate)
        x_values = left + seconds / duration * plot_width
        y_values = center - values * row_height * 0.36
        commands = [f'M {x_values[0]:.1f} {y_values[0]:.1f}']
        commands.extend(f'L {x:.1f} {y:.1f}' for x, y in zip(x_values[1:], y_values[1:]))
        path_data = " ".join(commands)
        elements.append(f'<path d="{path_data}" fill="none" stroke="{TRACE_COLOR}" stroke-width="1.05" stroke-linejoin="round"/>')

    parsed_picks: list[tuple[float, str, str]] = []
    for row in rows:
        raw_time = row.get("time", "").strip()
        if not raw_time:
            continue
        try:
            second = float(UTCDateTime(raw_time) - origin)
        except (TypeError, ValueError):
            continue
        if second < 0 or second > float(end - origin):
            continue
        phase = row.get("phase", "").strip() or "Pick"
        family = phase_family(phase)
        color = PHASE_COLORS.get(family, FALLBACK_PHASE_COLOR)
        parsed_picks.append((second, phase, color))

    for second, phase, color in parsed_picks:
        x = left + second / duration * plot_width
        elements.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top + plot_height}" stroke="{color}" stroke-width="1.5" opacity="0.9"/>')
        elements.append(f'<text class="phase" x="{x + 4:.1f}" y="{top + 14}" fill="{color}">{escape(phase)}</text>')

    elements.append(f'<line x1="{left}" y1="{top + plot_height}" x2="{left + plot_width}" y2="{top + plot_height}" stroke="#aab1bc" stroke-width="1"/>')
    elements.append(f'<text class="tick" x="{left + plot_width / 2:.1f}" y="{height - 9}" text-anchor="middle">Seconds from {escape(origin.isoformat())}</text>')
    elements.append('</svg>')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(elements), encoding="utf-8")
    return len(traces), len(parsed_picks)


def main() -> None:
    args = parse_args()
    picks_path = Path(args.picks).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    rows = read_pick_rows(picks_path)
    selected_station, station_rows = select_station(rows)
    paths = waveform_paths(station_rows, picks_path)
    stream = load_stream(paths, selected_station)
    trace_count, pick_count = render(stream, station_rows, output_path, args.max_traces, args.max_points)
    station = ".".join(part for part in selected_station if part)
    print(json.dumps({
        "output_path": str(output_path),
        "trace_count": trace_count,
        "pick_count": pick_count,
        "station": station,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
