export interface LatLng {
  lat: number;
  lng: number;
}

export interface ScoreCurve {
  maxScore: number;
  scaleKm: number;
}

const EARTH_RADIUS_KM = 6371;
const DEFAULT_MAX_SCORE = 1000;
const DEFAULT_SCALE_KM = 750;

export function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function calculateDistanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;

  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  const distance = EARTH_RADIUS_KM * c;

  if (!Number.isFinite(distance) || distance < 0) {
    return 0;
  }
  return distance;
}

export function calculateLocationScore(
  distanceKm: number,
  curve?: ScoreCurve
): number {
  const safeDistance =
    Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : 0;

  const maxScore =
    curve && Number.isFinite(curve.maxScore) && curve.maxScore > 0
      ? curve.maxScore
      : DEFAULT_MAX_SCORE;

  const scaleKm =
    curve && Number.isFinite(curve.scaleKm) && curve.scaleKm > 0
      ? curve.scaleKm
      : DEFAULT_SCALE_KM;

  if (safeDistance === 0) {
    return maxScore;
  }

  const raw = maxScore * Math.exp(-safeDistance / scaleKm);
  const score = Math.round(raw);
  return Math.max(0, score);
}
