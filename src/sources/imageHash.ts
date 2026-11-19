// pHash port from JohannesBuchner/imagehash. See public/licenses/ImageHash.txt.
// Decoders resample differently; compare only fingerprints from the same version.
export const NODE_IMAGE_FINGERPRINT_VERSION = "phash-grid3-sharp-v1";
const GRID_SIZE = 3;
const SAMPLE_SIZE = 32;
const HASH_SIZE = 8;
const maxWholeHashDistance = 9;
const maxRegionHashDistance = 8;
const maxAspectRatioDifference = 0.05;
const minimumMatchingRegionCount = 6;

const cosine = Array.from({ length: HASH_SIZE }, (_, frequency) =>
  Float64Array.from({ length: SAMPLE_SIZE }, (_, position) =>
    Math.cos((Math.PI * (2 * position + 1) * frequency) / (2 * SAMPLE_SIZE)),
  ),
);

/** ImageHash's default 64-bit pHash, from a row-major 32×32 grayscale sample. */
export function hashGrayscale(pixels: ArrayLike<number>): string {
  if (pixels.length !== SAMPLE_SIZE * SAMPLE_SIZE) {
    throw new Error("pHash requires 32×32 grayscale pixels.");
  }
  for (let i = 0; i < pixels.length; i++) {
    if (!Number.isFinite(pixels[i]) || pixels[i] < 0 || pixels[i] > 255) {
      throw new Error("Grayscale pixels must be finite values from 0 to 255.");
    }
  }

  const rows = new Float64Array(SAMPLE_SIZE * HASH_SIZE);
  for (let y = 0; y < SAMPLE_SIZE; y++) {
    for (let u = 0; u < HASH_SIZE; u++) {
      let sum = 0;
      for (let x = 0; x < SAMPLE_SIZE; x++) {
        sum += pixels[y * SAMPLE_SIZE + x] * cosine[u][x];
      }
      rows[y * HASH_SIZE + u] = sum;
    }
  }
  const coefficients = new Float64Array(HASH_SIZE * HASH_SIZE);
  for (let v = 0; v < HASH_SIZE; v++) {
    for (let u = 0; u < HASH_SIZE; u++) {
      let sum = 0;
      for (let y = 0; y < SAMPLE_SIZE; y++) {
        sum += rows[y * HASH_SIZE + u] * cosine[v][y];
      }
      coefficients[v * HASH_SIZE + u] = sum;
    }
  }
  // ImageHash includes the DC coefficient and uses the median of all 64 values.
  const sorted = [...coefficients].sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;
  let bits = 0n;
  for (const coefficient of coefficients) {
    bits = (bits << 1n) | BigInt(coefficient > median);
  }
  return bits.toString(16).padStart(16, "0");
}

export interface ImageFingerprint {
  version: string;
  width: number;
  height: number;
  whole: string;
  regions: { hash: string; contrast: number }[];
}

export interface ImageComparison {
  wholeDistance: number;
  // A blank area provides little evidence, even if its hash agrees.
  regionDistances: (number | null)[];
  informativeRegionCount: number;
  medianRegionDistance: number | null;
  aspectRatioDifference: number;
}

/** Report evidence only: duplicate thresholds need labeled positive/negative examples. */
export function compareFingerprints(
  first: ImageFingerprint,
  second: ImageFingerprint,
  minimumContrast = 12,
  expectedVersion: ImageFingerprint["version"] = NODE_IMAGE_FINGERPRINT_VERSION,
): ImageComparison {
  if (
    first.version !== expectedVersion ||
    second.version !== expectedVersion ||
    first.regions.length !== 9 ||
    second.regions.length !== 9
  ) {
    throw new Error("Incompatible image fingerprints.");
  }
  if (
    ![first.width, first.height, second.width, second.height].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    !Number.isFinite(minimumContrast) ||
    minimumContrast < 0
  ) {
    throw new Error("Invalid image dimensions or contrast threshold.");
  }
  const regionDistances = first.regions.map((region, index) => {
    const other = second.regions[index];
    const distance = hashDistance(region.hash, other.hash);
    if (
      ![region.contrast, other.contrast].every(
        (value) => Number.isFinite(value) && value >= 0,
      )
    ) {
      throw new Error("Invalid region contrast.");
    }
    if (region.contrast < minimumContrast || other.contrast < minimumContrast)
      return null;
    return distance;
  });
  const distances = regionDistances
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  let medianRegionDistance: number | null = null;
  if (distances.length) {
    const middle = Math.floor(distances.length / 2);
    medianRegionDistance = distances[middle];
    if (distances.length % 2 === 0)
      medianRegionDistance = (distances[middle - 1] + distances[middle]) / 2;
  }
  const firstRatio = first.width / first.height;
  const secondRatio = second.width / second.height;
  return {
    wholeDistance: hashDistance(first.whole, second.whole),
    regionDistances,
    informativeRegionCount: distances.length,
    medianRegionDistance,
    aspectRatioDifference:
      Math.abs(firstRatio - secondRatio) / Math.max(firstRatio, secondRatio),
  };
}

/** Initial conservative rule, based on the recorded translation experiment. */
export function isImageMatch(comparison: ImageComparison): boolean {
  if (
    !Number.isInteger(comparison.wholeDistance) ||
    comparison.wholeDistance < 0 ||
    !Number.isFinite(comparison.aspectRatioDifference) ||
    comparison.aspectRatioDifference < 0 ||
    comparison.regionDistances.length !== 9
  )
    return false;
  if (
    comparison.wholeDistance > maxWholeHashDistance ||
    comparison.aspectRatioDifference > maxAspectRatioDifference
  )
    return false;
  const matching = comparison.regionDistances
    .map((distance, index) =>
      distance !== null &&
      Number.isInteger(distance) &&
      distance >= 0 &&
      distance <= maxRegionHashDistance
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  const rows = new Set(matching.map((index) => Math.floor(index / GRID_SIZE)));
  return (
    matching.length >= minimumMatchingRegionCount && rows.size === GRID_SIZE
  );
}

/** Hamming distance, 0–64. Bit agreement is not a duplicate probability. */
export function hashDistance(first: string, second: string): number {
  if (!/^[a-f0-9]{16}$/i.test(first) || !/^[a-f0-9]{16}$/i.test(second)) {
    throw new Error("Expected two 64-bit hexadecimal image hashes.");
  }
  let different = BigInt(`0x${first}`) ^ BigInt(`0x${second}`);
  let distance = 0;
  while (different) {
    different &= different - 1n;
    distance++;
  }
  return distance;
}
