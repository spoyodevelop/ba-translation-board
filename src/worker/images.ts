import type { Post } from "../shared/post";
import type { SourceLookupResult } from "../sources/types";
import type { ImageFingerprint } from "../sources/imageHash";
import { NODE_IMAGE_FINGERPRINT_VERSION } from "../sources/imageHash.ts";
import { SourceRequestError } from "../sources/requestError.ts";
import { imageUrlExpiresAt } from "../shared/sites.ts";
import type { WorkerRepositories } from "../database/repositories.ts";
import type { ImageDownloader } from "./imageDownload.ts";
import { fingerprintNodeImage } from "./fingerprint.ts";

const imageCacheTtlMs = 4 * 24 * 60 * 60_000;
const imageUrlRefreshMarginMs = 10_000;

export type NodeImageResult =
  | { kind: "found"; fingerprint: ImageFingerprint }
  | { kind: "none" }
  | { kind: "failed"; status: number | null; error: string };

export function createNodeImageCollector(deps: {
  repositories: WorkerRepositories;
  download: ImageDownloader;
  refreshSource?: (post: Post) => Promise<SourceLookupResult>;
  now?: () => number;
}) {
  const now = deps.now || Date.now;
  const { caches, state } = deps.repositories;
  return {
    async lookup(
      post: Post,
      source: SourceLookupResult,
      signal: AbortSignal,
    ): Promise<NodeImageResult> {
      if (source.kind === "failed")
        return {
          kind: "failed",
          status: source.status ?? null,
          error: source.error,
        };
      if (!source.imageUrl) return { kind: "none" };
      const key = `body:${post.id}`;
      const entry = await caches.readImage(
        key,
        NODE_IMAGE_FINGERPRINT_VERSION,
        now(),
      );
      if (entry)
        return {
          kind: "found",
          fingerprint: {
            version: NODE_IMAGE_FINGERPRINT_VERSION,
            width: entry.width,
            height: entry.height,
            whole: entry.wholeHash,
            regions: entry.regions,
          },
        };
      let url = source.imageUrl;
      let bytes: Uint8Array;
      try {
        signal.throwIfAborted();
        if ((await state.nextRequestAt("images")) > now())
          throw new SourceRequestError(
            "이미지 요청 대기 중입니다.",
            "cooldown",
          );
        const expiresAt = imageUrlExpiresAt(new URL(url));
        // 받는 도중 만료되지 않도록 여유를 두고 미리 갱신한다.
        const expiredImageUrl =
          expiresAt !== null && expiresAt <= now() + imageUrlRefreshMarginMs;
        // 출처와 해시 캐시는 4일 재사용한다. 실제 이미지 다운로드에 필요한 주소만 갱신한다.
        if (expiredImageUrl) {
          if (!deps.refreshSource)
            throw new Error("만료된 이미지 주소를 갱신할 수 없습니다.");
          const refreshed = await deps.refreshSource(post);
          signal.throwIfAborted();
          if (refreshed.kind === "failed")
            return {
              kind: "failed",
              status: refreshed.status ?? null,
              error: refreshed.error,
            };
          if (!refreshed.imageUrl) return { kind: "none" };
          url = refreshed.imageUrl;
        }
        bytes = (await deps.download(url, signal)).bytes;
        signal.throwIfAborted();
      } catch (error) {
        const detail =
          error instanceof SourceRequestError
            ? error
            : new SourceRequestError(
                error instanceof Error ? error.message : String(error),
                signal.aborted ? "timeout" : "invalid-response",
              );
        if (detail.status === 429)
          await state.deferRequests("images", now() + detail.retryAfterMs);
        return { kind: "failed", status: detail.status, error: detail.message };
      }
      let fingerprint: ImageFingerprint;
      try {
        fingerprint = await fingerprintNodeImage(bytes);
      } catch {
        // 받은 이미지를 해석하지 못하면 다시 받아도 결과가 같다.
        // 재시도 사유로 두면 이 글이 후보 기간 내내 모든 수집 작업을 실패시키므로,
        // 이미지 근거가 없는 글로 보고 출처·제목 판정 결과만 남긴다.
        return { kind: "none" };
      }
      const checkedAt = now();
      await caches.saveImage({
        key,
        version: fingerprint.version,
        checkedAt,
        expiresAt: checkedAt + imageCacheTtlMs,
        width: fingerprint.width,
        height: fingerprint.height,
        wholeHash: fingerprint.whole,
        regions: fingerprint.regions,
      });
      return { kind: "found", fingerprint };
    },
  };
}
