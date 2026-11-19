import { httpError, SourceRequestError } from "../sources/requestError.ts";

const imageRequestTimeoutMs = 10_000;
// Content-Length를 믿지 않고 받는 도중에도 이 상한을 확인해, 큰 응답을 끝까지 메모리에 읽지 않는다.
const maxImageBytes = 8 * 1024 * 1024;

export type DownloadedImage = { bytes: Uint8Array; contentType: string };
export type ImageDownloader = (
  url: string,
  signal?: AbortSignal,
) => Promise<DownloadedImage>;

function imageContentType(bytes: Uint8Array): string | null {
  const prefix = Buffer.from(bytes.subarray(0, 16));
  if (prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff)
    return "image/jpeg";
  const text = prefix.toString("ascii");
  if (text.startsWith("GIF87a") || text.startsWith("GIF89a"))
    return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP")
    return "image/webp";
  if (
    text.slice(4, 8) === "ftyp" &&
    ["avif", "avis"].includes(text.slice(8, 12))
  )
    return "image/avif";
  return null;
}

// 본문 첫 이미지를 받아 실제 이미지 파일인지 확인한다. 목록 요청과는 상한·형식 검사가 달라 따로 둔다.
export function createImageDownloader(request: typeof fetch): ImageDownloader {
  return async (url, signal) => {
    const timeout = AbortSignal.timeout(imageRequestTimeoutMs);
    const response = await request(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw httpError("이미지 요청 실패", response);
    }
    if (Number(response.headers.get("content-length")) > maxImageBytes) {
      await response.body?.cancel();
      throw new SourceRequestError(
        "이미지가 8MiB 상한을 초과했습니다.",
        "invalid-response",
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new SourceRequestError(
        "이미지 응답 본문이 없습니다.",
        "missing-body",
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxImageBytes)
          throw new SourceRequestError(
            "이미지가 8MiB 상한을 초과했습니다.",
            "invalid-response",
          );
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // DC serves real PNG files as application/octet-stream; verify file bytes instead of trusting MIME.
    const contentType = imageContentType(bytes);
    if (!contentType)
      throw new SourceRequestError(
        "이미지 형식의 응답이 아닙니다.",
        "invalid-response",
      );
    return { bytes, contentType };
  };
}
