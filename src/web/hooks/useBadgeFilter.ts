import { useCallback, useEffect, useState } from "react";
import type { Badge, BadgeCatalog, BadgeKind } from "../badges.ts";

// 뱃지 필터를 주소에 남겨 뒤로 가기·새로고침·공유한 링크가 같은 목록을 연다. 값은 `종류:id`다.
const badgeParam = "badge";
// 단체를 club으로 부르기 전에 공유된 링크(`group:id`)도 연다.
const legacyKinds: Record<string, BadgeKind> = { group: "club" };

export function badgeFromSearch(search: string, catalog: BadgeCatalog): Badge | null {
  const value = new URLSearchParams(search).get(badgeParam);
  if (!value) return null;
  const [rawKind, id] = value.split(":");
  let kind: BadgeKind | null = null;
  if (rawKind === "character" || rawKind === "club") kind = rawKind;
  else if (Object.hasOwn(legacyKinds, rawKind)) kind = legacyKinds[rawKind];
  if (kind === null || !id) return null;
  return catalog.lookup(kind, id);
}

export function searchForBadge(search: string, badge: Badge | null): string {
  const params = new URLSearchParams(search);
  if (badge === null) params.delete(badgeParam);
  else params.set(badgeParam, `${badge.kind}:${badge.id}`);
  const query = params.toString();
  if (!query) return "";
  return `?${query}`;
}

export function useBadgeFilter(catalog: BadgeCatalog) {
  const [badge, setBadge] = useState(() => badgeFromSearch(window.location.search, catalog));
  useEffect(() => {
    const onPopState = () => setBadge(badgeFromSearch(window.location.search, catalog));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [catalog]);
  const selectBadge = useCallback((next: Badge | null) => {
    const search = searchForBadge(window.location.search, next);
    if (search !== window.location.search)
      window.history.pushState(null, "", `${window.location.pathname}${search}`);
    setBadge(next);
  }, []);
  return { badge, selectBadge };
}
