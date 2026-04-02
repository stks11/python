import math
import xml.etree.ElementTree as ET

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SplitRequest(BaseModel):
    coordinates: list[list[float]]
    mode: str = Field(pattern="^(parts|distance)$")
    parts: int | None = None
    segment_length_km: float | None = None


class SegmentsRequest(BaseModel):
    segments: list[list[list[float]]]


class ExportRequest(BaseModel):
    coordinates: list[list[float]]
    file_name: str = "Trasa"


def parse_gpx_text(text):
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise HTTPException(status_code=400, detail="Niepoprawny plik GPX.") from exc

    coordinates = []
    for trkpt in root.iter():
        if not trkpt.tag.endswith("trkpt"):
            continue
        lat = trkpt.attrib.get("lat")
        lon = trkpt.attrib.get("lon")
        if lat is None or lon is None:
            continue
        ele = 0.0
        for child in trkpt:
            if child.tag.endswith("ele") and child.text:
                ele = float(child.text)
                break
        coordinates.append([float(lon), float(lat), ele])
    return coordinates


def validate_coordinates(coordinates):
    if len(coordinates) < 2:
        raise HTTPException(status_code=400, detail="Trasa musi zawierać co najmniej 2 punkty.")
    for point in coordinates:
        if len(point) < 2:
            raise HTTPException(status_code=400, detail="Każdy punkt musi zawierać lon i lat.")


def haversine_km(start, end):
    lon1, lat1 = math.radians(start[0]), math.radians(start[1])
    lon2, lat2 = math.radians(end[0]), math.radians(end[1])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def interpolate_point(start, end, ratio):
    start_ele = start[2] if len(start) > 2 else 0.0
    end_ele = end[2] if len(end) > 2 else 0.0
    return [
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio,
        start_ele + (end_ele - start_ele) * ratio,
    ]


def split_by_parts(coordinates, parts):
    if parts <= 0:
        raise HTTPException(status_code=400, detail="Liczba części musi być większa od zera.")
    total_points = len(coordinates)
    base_segments = total_points // parts
    extra_segments = total_points % parts
    start_index = 0
    result = []
    for index in range(parts):
        segment_count = base_segments + (1 if index < extra_segments else 0)
        end_index = start_index + segment_count
        segment_coordinates = coordinates[start_index:end_index + 1]
        if len(segment_coordinates) > 1:
            result.append(segment_coordinates)
        start_index = end_index
    return result


def split_by_distance(coordinates, segment_length_km):
    if segment_length_km <= 0:
        raise HTTPException(status_code=400, detail="Długość segmentu musi być większa od zera.")
    result = []
    current_segment = [coordinates[0]]
    current_point = coordinates[0]
    distance_in_segment = 0.0
    for next_original in coordinates[1:]:
        target_point = next_original
        while True:
            leg_distance = haversine_km(current_point, target_point)
            remaining = segment_length_km - distance_in_segment
            if remaining <= 1e-9:
                result.append(current_segment)
                current_segment = [current_point]
                distance_in_segment = 0.0
                continue
            if leg_distance == 0:
                current_point = target_point
                break
            if leg_distance < remaining:
                current_segment.append(target_point)
                distance_in_segment += leg_distance
                current_point = target_point
                break
            ratio = remaining / leg_distance
            split_point = interpolate_point(current_point, target_point, ratio)
            current_segment.append(split_point)
            result.append(current_segment)
            current_segment = [split_point]
            current_point = split_point
            distance_in_segment = 0.0
        if current_point != next_original:
            leg_distance = haversine_km(current_point, next_original)
            if leg_distance > 0:
                current_segment.append(next_original)
                distance_in_segment += leg_distance
                current_point = next_original

    if len(current_segment) > 1:
        result.append(current_segment)
    return result

def merge_segments(segments):
    merged_coordinates = []
    for segment in segments:
        if not segment:
            continue
        if merged_coordinates and merged_coordinates[-1] == segment[0]:
            merged_coordinates.extend(segment[1:])
        else:
            merged_coordinates.extend(segment)
    if len(merged_coordinates) < 2:
        raise HTTPException(status_code=400, detail="Brak segmentów do scalenia.")
    return merged_coordinates


def calculate_stats(segments):
    point_count = 0
    total_length = 0.0
    elevation_gain = 0.0
    distances_km = []
    elevations_m = []
    cumulative_distance = 0.0
    for coordinates in segments:
        validate_coordinates(coordinates)
        point_count += len(coordinates)
        for index in range(len(coordinates) - 1):
            start = coordinates[index]
            end = coordinates[index + 1]
            distance = haversine_km(start, end)
            total_length += distance
            cumulative_distance += distance
            distances_km.append(round(cumulative_distance, 6))
            start_ele = start[2] if len(start) > 2 else 0.0
            end_ele = end[2] if len(end) > 2 else 0.0
            elevation_diff = end_ele - start_ele
            if elevation_diff > 0:
                elevation_gain += elevation_diff
            elevations_m.append(round(end_ele, 6))

    return {
        "point_count": point_count,
        "total_length_km": round(total_length, 6),
        "elevation_gain_m": round(elevation_gain, 6),
        "distances_km": distances_km,
        "elevations_m": elevations_m,
    }


def build_gpx(coordinates, file_name):
    validate_coordinates(coordinates)
    safe_name = file_name.strip() or "Trasa"
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1">',
        "  <metadata>",
        f"    <name>{safe_name}</name>",
        "  </metadata>",
        "  <trk>",
        "    <trkseg>",
    ]

    for lon, lat, *rest in coordinates:
        ele = rest[0] if rest else 0.0
        lines.extend(
            [
                f'      <trkpt lon="{lon}" lat="{lat}">',
                f"        <ele>{ele}</ele>",
                "      </trkpt>",
            ]
        )

    lines.extend(["    </trkseg>", "  </trk>", "</gpx>"])
    return "\n".join(lines)


@app.post("/upload-gpx")
async def upload_gpx(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode("utf-8")
    coordinates = parse_gpx_text(text)
    validate_coordinates(coordinates)
    return {"points_count": len(coordinates), "coordinates": coordinates}


@app.post("/split-gpx")
def split_gpx(payload: SplitRequest):
    validate_coordinates(payload.coordinates)

    if payload.mode == "parts":
        if payload.parts is None:
            raise HTTPException(status_code=400, detail="Brakuje parametru parts.")
        segments = split_by_parts(payload.coordinates, payload.parts)
    else:
        if payload.segment_length_km is None:
            raise HTTPException(status_code=400, detail="Brakuje parametru segment_length_km.")
        segments = split_by_distance(payload.coordinates, payload.segment_length_km)

    return {"segments": segments, "segments_count": len(segments)}


@app.post("/merge-gpx")
def merge_gpx(payload: SegmentsRequest):
    merged_coordinates = merge_segments(payload.segments)
    return {"coordinates": merged_coordinates, "points_count": len(merged_coordinates)}


@app.post("/stats-gpx")
def stats_gpx(payload: SegmentsRequest):
    if not payload.segments:
        raise HTTPException(status_code=400, detail="Brak segmentów do analizy.")
    return calculate_stats(payload.segments)


@app.post("/export-gpx")
def export_gpx(payload: ExportRequest):
    gpx_content = build_gpx(payload.coordinates, payload.file_name)
    download_name = f'{(payload.file_name.strip() or "Trasa")}.gpx'
    return Response(
        content=gpx_content,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )
