import { useCallback, useEffect, useState } from "react";

// 작가 필터를 주소에 남겨 뒤로 가기·새로고침·공유한 링크가 같은 목록을 연다.
export const artistParam = "artist";
// 팔로우한 작가 전부를 보는 값이다. 작가 키에는 항상 `:`가 있어 겹치지 않는다.
const followedValue = "followed";

export type ArtistFilter =
  | { kind: "artist"; key: string }
  | { kind: "followed" };

export function artistFilterFromSearch(search: string): ArtistFilter | null {
  const value = new URLSearchParams(search).get(artistParam);
  if (!value) return null;
  if (value === followedValue) return { kind: "followed" };
  return { kind: "artist", key: value };
}

export function searchForArtistFilter(
  search: string,
  filter: ArtistFilter | null,
): string {
  const params = new URLSearchParams(search);
  if (filter === null) params.delete(artistParam);
  else if (filter.kind === "followed") params.set(artistParam, followedValue);
  else params.set(artistParam, filter.key);
  const query = params.toString();
  if (!query) return "";
  return `?${query}`;
}

export function useArtistFilter() {
  const [filter, setFilter] = useState(() =>
    artistFilterFromSearch(window.location.search),
  );
  useEffect(() => {
    const onPopState = () =>
      setFilter(artistFilterFromSearch(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const selectFilter = useCallback((next: ArtistFilter | null) => {
    const search = searchForArtistFilter(window.location.search, next);
    if (search !== window.location.search)
      window.history.pushState(
        null,
        "",
        `${window.location.pathname}${search}`,
      );
    setFilter(next);
  }, []);
  return { filter, selectFilter };
}
