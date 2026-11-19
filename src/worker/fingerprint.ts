import sharp from "sharp";
import {
  hashGrayscale,
  NODE_IMAGE_FINGERPRINT_VERSION,
} from "../sources/imageHash.ts";
import type { ImageFingerprint } from "../sources/imageHash";

const maxImagePixelsBeforeResize = 12_000_000;
const resizedImageMaxSide = 1024;

export async function fingerprintNodeImage(
  bytes: Uint8Array,
): Promise<ImageFingerprint> {
  const image = sharp(bytes);
  const metadata = await image.metadata();
  const needsResize =
    (metadata.width ?? 0) * (metadata.height ?? 0) > maxImagePixelsBeforeResize;
  image.rotate();
  if (needsResize) {
    // 큰 이미지는 원본 크기로 메모리에 펼치기 전에 줄인다.
    image.resize(resizedImageMaxSide, resizedImageMaxSide, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  const { data, info } = await image
    .flatten({ background: "#fff" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (width < 3 || height < 3 || channels !== 3)
    throw new Error("이미지 크기 또는 색상 형식이 올바르지 않습니다.");
  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(
      0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2],
    );
  }
  async function sample(
    left: number,
    top: number,
    regionWidth: number,
    regionHeight: number,
  ) {
    const rgb = await sharp(gray, { raw: { width, height, channels: 1 } })
      .extract({ left, top, width: regionWidth, height: regionHeight })
      .resize(32, 32, { fit: "fill", kernel: "lanczos3" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = Uint8Array.from(
      { length: 1024 },
      (_, i) => rgb.data[i * rgb.info.channels],
    );
    const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
    const variance =
      pixels.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      pixels.length;
    return { hash: hashGrayscale(pixels), contrast: Math.sqrt(variance) };
  }
  const whole = (await sample(0, 0, width, height)).hash;
  const regions: ImageFingerprint["regions"] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      const left = Math.floor((column * width) / 3);
      const top = Math.floor((row * height) / 3);
      regions.push(
        await sample(
          left,
          top,
          Math.floor(((column + 1) * width) / 3) - left,
          Math.floor(((row + 1) * height) / 3) - top,
        ),
      );
    }
  }
  // Sharp and Canvas resample differently; hashes are reusable only within their own version.
  return {
    version: NODE_IMAGE_FINGERPRINT_VERSION,
    width,
    height,
    whole,
    regions,
  };
}
