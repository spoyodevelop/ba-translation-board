import type { WorkerRepositories } from "../database/repositories.ts";
import {
  PixivFormatError,
  parsePixivIllust,
  parsePixivProfileXHandle,
  xHandleFromStatusUrl,
} from "../sources/originalArtists.ts";
import { describeError } from "./describeError.ts";

// X 작가는 출처 URL에서 바로 읽으므로 요청 없이 한 번에 처리한다.
const xArtworksPerRun = 500;
// 픽시브는 로그인 없는 공개 응답을 쓴다. 차단되지 않도록 작업마다 조금씩, 요청 사이를 1초 둔다.
// 하루 새 픽시브 작품은 수십 개라 10분마다 30개면 밀리지 않는다.
const pixivArtworksPerRun = 30;
const pixivRequestGapMs = 1000;

// 픽시브 요청이 실패했다(네트워크·차단·서버 오류). 작업 중단은 여기에 담지 않는다.
class PixivRequestError extends Error {}

export type ArtistRunResult = {
  xFound: number;
  xMissing: number;
  pixivFound: number;
  pixivMissing: number;
  // 픽시브 실패는 이번 실행을 멈춘다. 다음 작업에서 이어 간다.
  pixivError: string | null;
};

export function createNodeArtistResolver(deps: {
  repositories: Pick<WorkerRepositories, "artists">;
  request: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}) {
  const { artists } = deps.repositories;
  let requested = false;
  let signal = new AbortController().signal;

  // 404는 지워졌거나 비공개인 작품·작가다. 그 밖의 실패는 다시 시도할 수 있게 오류로 올린다.
  async function pixivJson(url: string): Promise<unknown | "missing"> {
    if (requested) await deps.sleep(pixivRequestGapMs);
    requested = true;
    let response: Response;
    try {
      response = await deps.request(url, {
        headers: {
          Accept: "application/json",
          Referer: "https://www.pixiv.net/",
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new PixivRequestError(describeError(error), { cause: error });
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return "missing";
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PixivRequestError(`픽시브 응답 ${response.status}`);
    }
    try {
      return await response.json();
    } catch (error) {
      signal.throwIfAborted();
      throw new PixivFormatError("픽시브 응답이 JSON이 아닙니다.", { cause: error });
    }
  }

  async function resolveX(result: ArtistRunResult) {
    for (const artwork of await artists.listPending("x", xArtworksPerRun)) {
      const handle = xHandleFromStatusUrl(artwork.url);
      const checkedAt = deps.now();
      if (handle) {
        await artists.save({
          platform: "x",
          originalId: artwork.originalId,
          status: "found",
          artistId: handle.toLowerCase(),
          artistName: handle,
          checkedAt,
        });
        result.xFound += 1;
      } else {
        await artists.save({
          platform: "x",
          originalId: artwork.originalId,
          status: "missing",
          checkedAt,
        });
        result.xMissing += 1;
      }
    }
  }

  async function resolvePixivArtwork(originalId: string, result: ArtistRunResult) {
    const illust = await pixivJson(
      `https://www.pixiv.net/ajax/illust/${originalId}`,
    );
    if (illust === "missing") {
      await artists.save({
        platform: "pixiv",
        originalId,
        status: "missing",
        checkedAt: deps.now(),
      });
      result.pixivMissing += 1;
      return;
    }
    const { userId, userName } = parsePixivIllust(illust);
    let profile: { userId: string; xHandle: string | null } | undefined;
    if (!(await artists.readPixivProfile(userId))) {
      const json = await pixivJson(
        `https://www.pixiv.net/ajax/user/${userId}?full=1`,
      );
      let xHandle: string | null = null;
      if (json !== "missing") xHandle = parsePixivProfileXHandle(json);
      profile = { userId, xHandle };
    }
    await artists.save(
      {
        platform: "pixiv",
        originalId,
        status: "found",
        artistId: userId,
        artistName: userName,
        checkedAt: deps.now(),
      },
      profile,
    );
    result.pixivFound += 1;
  }

  async function resolvePixiv(result: ArtistRunResult) {
    const pending = await artists.listPending("pixiv", pixivArtworksPerRun);
    for (const artwork of pending) {
      signal.throwIfAborted();
      try {
        await resolvePixivArtwork(artwork.originalId, result);
      } catch (error) {
        // 픽시브 요청·응답 문제만 작품의 실패로 센다. 작업 중단과 DB 오류는 작업이 처리한다.
        const pixivFailed =
          error instanceof PixivRequestError || error instanceof PixivFormatError;
        if (!pixivFailed) throw error;
        await artists.recordFailure("pixiv", artwork.originalId, deps.now());
        result.pixivError = describeError(error);
        return;
      }
    }
  }

  return {
    async resolve(jobSignal: AbortSignal): Promise<ArtistRunResult> {
      requested = false;
      signal = jobSignal;
      const result: ArtistRunResult = {
        xFound: 0,
        xMissing: 0,
        pixivFound: 0,
        pixivMissing: 0,
        pixivError: null,
      };
      await resolveX(result);
      await resolvePixiv(result);
      return result;
    },
  };
}
