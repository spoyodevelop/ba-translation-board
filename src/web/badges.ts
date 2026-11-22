import type { BadgeMatcher, TitleBadges } from "../characters/matchBadges.ts";
import type { Post } from "../shared/post.ts";

export type BadgeKind = "character" | "club";

export type Badge = { kind: BadgeKind; id: string; name: string };

export type BadgeCatalog = {
  // 묶음의 제목 중 하나에만 나와도 묶음 전체에 붙인다.
  findBadges(posts: Post[]): Badge[];
  lookup(kind: BadgeKind, id: string): Badge | null;
};

export function isSameBadge(a: Badge, b: Badge): boolean {
  return a.kind === b.kind && a.id === b.id;
}

// 글을 전부 받아 화면에서 거르므로 뱃지도 화면에서 판정한다. 목록을 새로 받아도 새 제목만 판정한다.
export function createBadgeCatalog(options: {
  matchTitle: BadgeMatcher;
  characters: { id: string; name: string }[];
  clubs: { id: string; name: string }[];
}): BadgeCatalog {
  const names: Record<BadgeKind, Map<string, string>> = {
    character: new Map(options.characters.map((c) => [c.id, c.name])),
    club: new Map(options.clubs.map((c) => [c.id, c.name])),
  };
  const badgesByTitle = new Map<string, TitleBadges>();

  function badgesOfTitle(title: string): TitleBadges {
    const cached = badgesByTitle.get(title);
    if (cached) return cached;
    const found = options.matchTitle(title);
    badgesByTitle.set(title, found);
    return found;
  }

  function lookup(kind: BadgeKind, id: string): Badge | null {
    const name = names[kind].get(id);
    if (name === undefined) return null;
    return { kind, id, name };
  }

  function findBadges(posts: Post[]): Badge[] {
    const found = posts.map((post) => badgesOfTitle(post.title));
    const characterIds = new Set(found.flatMap((f) => f.characterIds));
    const clubIds = new Set(found.flatMap((f) => f.clubIds));
    const badges: Badge[] = [];
    for (const id of characterIds) badges.push(lookup("character", id)!);
    for (const id of clubIds) badges.push(lookup("club", id)!);
    return badges;
  }

  return { findBadges, lookup };
}
