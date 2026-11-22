import { useCallback, useEffect, useState } from "react";
import { badgeFromKey } from "../badges";
import type { Badge } from "../badges";

// 뱃지 필터를 주소에 남겨 뒤로 가기·새로고침·공유한 링크가 같은 목록을 연다.
const badgeParam = "badge";

function badgeFromSearch(search: string): Badge | null {
  const value = new URLSearchParams(search).get(badgeParam);
  if (!value) return null;
  return badgeFromKey(value);
}

function searchForBadge(search: string, badge: Badge | null): string {
  const params = new URLSearchParams(search);
  if (badge === null) params.delete(badgeParam);
  else params.set(badgeParam, badge.key);
  const query = params.toString();
  if (!query) return "";
  return `?${query}`;
}

export function useBadgeFilter() {
  const [badge, setBadge] = useState(() => badgeFromSearch(window.location.search));
  useEffect(() => {
    const onPopState = () => setBadge(badgeFromSearch(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const selectBadge = useCallback((next: Badge | null) => {
    const search = searchForBadge(window.location.search, next);
    if (search !== window.location.search)
      window.history.pushState(null, "", `${window.location.pathname}${search}`);
    setBadge(next);
  }, []);
  return { badge, selectBadge };
}
