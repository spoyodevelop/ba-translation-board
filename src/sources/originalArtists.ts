// 원작 작가를 출처 URL과 픽시브 공개 응답에서 알아낸다. 네트워크 요청은 worker가 맡는다.

// X 계정명 규칙이다. `i`는 계정이 아니라 `x.com/i/status/...` 같은 공용 경로다.
const xHandlePattern = /^[A-Za-z0-9_]{1,15}$/;
const xHosts = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);

function readXHandle(segment: string | undefined): string | null {
  if (!segment || !xHandlePattern.test(segment)) return null;
  if (segment.toLowerCase() === "i") return null;
  return segment;
}

// 정규화된 출처 URL(`https://x.com/{계정}/status/{id}`)에서 계정명을 꺼낸다.
export function xHandleFromStatusUrl(value: string): string | null {
  const match = value.match(/^https:\/\/x\.com\/([^/]+)\/status\/\d+$/);
  return readXHandle(match?.[1]);
}

// 픽시브 프로필의 X 링크(`https://twitter.com/{계정}` 등)에서 계정명을 꺼낸다.
export function xHandleFromProfileUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!xHosts.has(url.hostname.replace(/^www\./, ""))) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  return readXHandle(segments[0].replace(/^@/, ""));
}

// 응답 형식이 예상과 다르다. 작가가 없는 작품으로 굳히지 않고 다시 시도할 실패로 다룬다.
export class PixivFormatError extends Error {}

export type PixivIllust = { userId: string; userName: string };

// `GET /ajax/illust/{id}` 응답이다.
export function parsePixivIllust(json: unknown): PixivIllust {
  const body = (json as { body?: { userId?: unknown; userName?: unknown } })
    ?.body;
  const userId = body?.userId;
  if (typeof userId !== "string" || !/^[1-9]\d*$/.test(userId))
    throw new PixivFormatError("픽시브 작품 응답에 작가 ID가 없습니다.");
  let userName = "";
  if (typeof body?.userName === "string") userName = body.userName;
  return { userId, userName };
}

// `GET /ajax/user/{id}?full=1` 응답이다. X 연결이 없는 작가가 많으므로 없으면 null이다.
export function parsePixivProfileXHandle(json: unknown): string | null {
  const body = (json as { body?: { social?: unknown } })?.body;
  if (!body || typeof body !== "object")
    throw new PixivFormatError("픽시브 프로필 응답 형식이 다릅니다.");
  const social = body.social as { twitter?: { url?: unknown } } | undefined;
  const url = social?.twitter?.url;
  if (typeof url !== "string") return null;
  return xHandleFromProfileUrl(url);
}

export type ArtistIdentity = { key: string; name: string };

// 작가 모아보기에서 같은 사람으로 묶는 기준이다. 픽시브 작가의 프로필에 X 계정이 있으면
// X 작가와 같은 사람으로 보고 X 계정을 키로 쓴다. 계정명은 대소문자를 가리지 않는다.
export function artistIdentity(artist: {
  platform: "x" | "pixiv";
  artistId: string;
  artistName: string | null;
  xHandle: string | null;
}): ArtistIdentity {
  if (artist.platform === "x")
    return { key: `x:${artist.artistId}`, name: `@${artist.artistName ?? artist.artistId}` };
  if (artist.xHandle)
    return { key: `x:${artist.xHandle.toLowerCase()}`, name: `@${artist.xHandle}` };
  return {
    key: `pixiv:${artist.artistId}`,
    name: artist.artistName || `pixiv ${artist.artistId}`,
  };
}
