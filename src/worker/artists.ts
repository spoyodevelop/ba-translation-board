import type { WorkerRepositories } from "../database/repositories.ts";
import {
  PixivFormatError,
  parsePixivIllust,
  parsePixivProfileXHandle,
  xHandleFromStatusRedirect,
  xHandleFromStatusUrl,
} from "../sources/originalArtists.ts";
import { describeError } from "./describeError.ts";

// X 작가는 대부분 출처 URL의 계정명으로 알아내므로 요청 없이 한 번에 처리한다.
const xArtworksPerRun = 500;
// 계정명 없는 `x.com/i/status/{id}` 링크와 픽시브는 로그인 없는 공개 응답을 쓴다.
// 차단되지 않도록 작업마다 조금씩, 두 사이트의 요청을 합쳐 요청 사이를 1초 둔다.
// 하루 새 작품은 수십 개라 10분마다 30개씩이면 밀리지 않는다.
const xLookupsPerRun = 30;
const pixivArtworksPerRun = 30;
const requestGapMs = 1000;

// 요청이 실패했다(네트워크·차단·서버 오류). 작업 중단은 여기에 담지 않는다.
class LookupRequestError extends Error {}

export type ArtistRunResult = {
  xFound: number;
  xMissing: number;
  pixivFound: number;
  pixivMissing: number;
  // 사이트별 첫 실패에서 그 사이트 조회를 멈춘다. 다음 작업에서 이어 간다.
  xError: string | null;
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

  async function send(url: string, init: RequestInit): Promise<Response> {
    if (requested) await deps.sleep(requestGapMs);
    requested = true;
    try {
      return await deps.request(url, init);
    } catch (error) {
      signal.throwIfAborted();
      throw new LookupRequestError(describeError(error), { cause: error });
    }
  }

  // 404는 지워졌거나 비공개인 작품·작가다. 그 밖의 실패는 다시 시도할 수 있게 오류로 올린다.
  async function pixivJson(url: string): Promise<unknown | "missing"> {
    const response = await send(url, {
      headers: {
        Accept: "application/json",
        Referer: "https://www.pixiv.net/",
      },
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return "missing";
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LookupRequestError(`픽시브 응답 ${response.status}`);
    }
    try {
      return await response.json();
    } catch (error) {
      signal.throwIfAborted();
      throw new PixivFormatError("픽시브 응답이 JSON이 아닙니다.", { cause: error });
    }
  }

  // 계정명 없는 링크는 x.com이 로그인 없이도 작가 주소로 리다이렉트해 준다. 본문은 받지 않는다.
  // 404는 지워졌거나 비공개인 트윗이다.
  async function lookupXHandle(statusId: string): Promise<string | "missing"> {
    const response = await send(`https://x.com/i/status/${statusId}`, {
      method: "HEAD",
      redirect: "manual",
    });
    await response.body?.cancel();
    if (response.status === 404) return "missing";
    const location = response.headers.get("Location");
    const redirected = response.status >= 300 && response.status < 400;
    if (!redirected || !location)
      throw new LookupRequestError(`X 응답 ${response.status}`);
    const handle = xHandleFromStatusRedirect(location, statusId);
    if (!handle) throw new LookupRequestError("X 리다이렉트에 계정명이 없습니다.");
    return handle;
  }

  async function saveX(originalId: string, handle: string | "missing", result: ArtistRunResult) {
    const checkedAt = deps.now();
    if (handle === "missing") {
      await artists.save({ platform: "x", originalId, status: "missing", checkedAt });
      result.xMissing += 1;
      return;
    }
    await artists.save({
      platform: "x",
      originalId,
      status: "found",
      artistId: handle.toLowerCase(),
      artistName: handle,
      checkedAt,
    });
    result.xFound += 1;
  }

  async function resolveX(result: ArtistRunResult) {
    let lookupsLeft = xLookupsPerRun;
    for (const artwork of await artists.listPending("x", xArtworksPerRun)) {
      const handle = xHandleFromStatusUrl(artwork.url);
      if (handle) {
        await saveX(artwork.originalId, handle, result);
        continue;
      }
      // 요청 한도를 쓰거나 실패한 뒤에도 URL에 계정명이 있는 작품은 계속 처리한다.
      if (lookupsLeft === 0 || result.xError !== null) continue;
      lookupsLeft -= 1;
      signal.throwIfAborted();
      try {
        await saveX(artwork.originalId, await lookupXHandle(artwork.originalId), result);
      } catch (error) {
        if (!(error instanceof LookupRequestError)) throw error;
        await artists.recordFailure("x", artwork.originalId, deps.now());
        result.xError = describeError(error);
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
          error instanceof LookupRequestError || error instanceof PixivFormatError;
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
        xError: null,
        pixivError: null,
      };
      await resolveX(result);
      await resolvePixiv(result);
      return result;
    },
  };
}
