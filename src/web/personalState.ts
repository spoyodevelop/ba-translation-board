export const personalKeys = {
  visits: "translation-board-visits",
  followedArtists: "translation-board-followed-artists",
};

// 팔로우한 원작 작가다. 지금 목록에 그 작가 글이 없어도 이름을 보여 줄 수 있게 이름도 둔다.
export type FollowedArtist = { key: string; name: string };
// 작가 키 규칙(src/sources/originalArtists.ts의 artistIdentity)과 맞춘다.
const artistKey = /^(x:[a-z0-9_]{1,15}|pixiv:[1-9]\d*)$/;
type BrowserStorage = Pick<Storage, "getItem" | "setItem">;
const postId = /^(arca|dc)-\d+$/;


export function createPersonalStateStore(storage: BrowserStorage) {
  function readVisits(): Set<string> {
    const value: unknown = JSON.parse(
      storage.getItem(personalKeys.visits) || "[]",
    );
    if (!Array.isArray(value))
      throw new Error("방문 기록 형식이 올바르지 않아요.");
    return new Set(
      value.filter(
        (id): id is string => typeof id === "string" && postId.test(id),
      ),
    );
  }
  function readFollowedArtists(): FollowedArtist[] {
    const value: unknown = JSON.parse(
      storage.getItem(personalKeys.followedArtists) || "[]",
    );
    if (!Array.isArray(value))
      throw new Error("팔로우한 작가 형식이 올바르지 않아요.");
    const artists = new Map<string, FollowedArtist>();
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const artist = entry as Record<string, unknown>;
      if (typeof artist.key !== "string" || !artistKey.test(artist.key)) continue;
      if (typeof artist.name !== "string" || artist.name === "") continue;
      artists.set(artist.key, { key: artist.key, name: artist.name });
    }
    return [...artists.values()];
  }
  function saveFollowedArtists(artists: FollowedArtist[]) {
    storage.setItem(personalKeys.followedArtists, JSON.stringify(artists));
    return artists;
  }
  return {
    readVisits,
    readFollowedArtists,
    // 다른 탭에서 바꾼 목록을 덮어쓰지 않도록 저장된 값을 다시 읽어 고친다.
    follow(artist: FollowedArtist): FollowedArtist[] {
      if (!artistKey.test(artist.key)) throw new Error("작가 키가 올바르지 않아요.");
      const others = readFollowedArtists().filter((a) => a.key !== artist.key);
      return saveFollowedArtists([...others, artist]);
    },
    unfollow(key: string): FollowedArtist[] {
      return saveFollowedArtists(
        readFollowedArtists().filter((artist) => artist.key !== key),
      );
    },
    visit(id: string, current: Set<string>): Set<string> {
      if (!postId.test(id)) throw new Error("글 ID가 올바르지 않아요.");
      const visits = new Set([...readVisits(), ...current, id]);
      storage.setItem(personalKeys.visits, JSON.stringify([...visits]));
      return visits;
    },
  };
}
