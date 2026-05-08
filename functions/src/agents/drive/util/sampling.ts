import {DriveFileEntry} from "../types";

export const SAMPLE_SCHEDULE: readonly number[] = [25, 50, 100, 200, 400];

export function nextSampleSize(currentSize: number): number | null {
  for (const size of SAMPLE_SCHEDULE) {
    if (size > currentSize) {
      return size;
    }
  }
  return null;
}

export function hashStringToSeed(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  return () => {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleFilesAdditive(
    eligible: DriveFileEntry[],
    targetCount: number,
    alreadySampledIds: Set<string>,
    seed: string,
): DriveFileEntry[] {
  const cappedTarget = Math.min(Math.max(targetCount, 0), eligible.length);
  const previouslySampled = eligible.filter((file) => alreadySampledIds.has(file.id));
  if (previouslySampled.length >= cappedTarget) {
    return previouslySampled.slice(0, cappedTarget);
  }

  const unsampled = eligible.filter((file) => !alreadySampledIds.has(file.id));
  const random = mulberry32(hashStringToSeed(seed));
  for (let i = unsampled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [unsampled[i], unsampled[j]] = [unsampled[j], unsampled[i]];
  }

  return [
    ...previouslySampled,
    ...unsampled.slice(0, cappedTarget - previouslySampled.length),
  ];
}
