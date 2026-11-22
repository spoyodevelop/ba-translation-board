import { characterAliases, characters } from "../characters/characterList";
import { groups } from "../characters/groupList";
import { createBadgeMatcher } from "../characters/matchCharacters";
import type { Post } from "../shared/post";

export type Badge = {
  kind: "character" | "group";
  id: string;
  name: string;
  // 주소와 필터에서 쓰는 값이다. 캐릭터와 단체의 id가 겹쳐도 구별된다.
  key: string;
};

// 판정 결과를 아직 DB에 저장하지 않아서 받아 온 글 제목으로 화면에서 판정한다.
const matchBadges = createBadgeMatcher({
  characters,
  aliases: characterAliases,
  groups,
});
const characterNames = new Map(characters.map((c) => [c.id, c.name]));
const groupNames = new Map(groups.map((g) => [g.id, g.name]));

// 묶음의 어느 제목에든 이름이 나오면 묶음 전체에 뱃지를 붙인다. 캐릭터를 단체보다 앞에 둔다.
export function findBadges(posts: Post[]): Badge[] {
  const found = posts.map((post) => matchBadges(post.title));
  const characterIds = new Set(found.flatMap((f) => f.characterIds));
  const groupIds = new Set(found.flatMap((f) => f.groupIds));
  return [
    ...[...characterIds].map((id) => badge("character", id, characterNames.get(id)!)),
    ...[...groupIds].map((id) => badge("group", id, groupNames.get(id)!)),
  ];
}

// 주소에 남은 값에서 뱃지를 되살린다. 목록에 없는 값이면 null이다.
export function badgeFromKey(key: string): Badge | null {
  const [kind, id] = key.split(":");
  if (kind === "character" && characterNames.has(id))
    return badge("character", id, characterNames.get(id)!);
  if (kind === "group" && groupNames.has(id))
    return badge("group", id, groupNames.get(id)!);
  return null;
}

function badge(kind: Badge["kind"], id: string, name: string): Badge {
  return { kind, id, name, key: `${kind}:${id}` };
}
