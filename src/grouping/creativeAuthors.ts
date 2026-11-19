// 창작 글은 작가가 양쪽 사이트에 직접 올리는 경우가 많아, 두 글의 작가가 같은 사람인지가 판정의 가장 강한 근거다.
// 사이트마다 닉네임이 다른 사람은 사람이 확인한 별칭 목록으로 잇는다. 목록은 저장소 밖(운영 worker 서버)에만 둔다.

export type DcAuthor = { uid: string | null; nick: string };
export type AliasEntry = { dc: DcAuthor; arca: string; decidedAt: string };
export type AliasStore = { aliases: AliasEntry[]; rejected: AliasEntry[] };

export type AuthorRelation =
  | "same-nick"
  | "uid-nick"
  | "alias"
  | "rejected-alias"
  | "different";

// 디시 기본 닉네임이다. 여러 계정이 함께 쓰고 아카에서는 익명 사용자 이름이라 닉네임끼리 비교하지 않는다.
const defaultNick = "ㅇㅇ";

export function normalizeNick(nick: string) {
  return nick.normalize("NFKC").trim().toLowerCase();
}

// 고닉은 닉네임을 바꿔도 uid가 같으므로 uid를 우선한다.
function dcKey(author: DcAuthor) {
  if (author.uid) return `uid:${author.uid}`;
  return `nick:${normalizeNick(author.nick)}`;
}

export function authorPairKey(dc: DcAuthor, arca: string) {
  return `${dcKey(dc)}\u0000${normalizeNick(arca)}`;
}

// 유동만 아이디가 없다. 창작 말머리는 유동이 쓸 수 없어 창작 글은 모두 아이디가 있다.
// 닉네임이 기본값이어도 아이디로 같은 사람을 알아볼 수 있다.
export function isAnonymousDcAuthor(author: DcAuthor) {
  return !author.uid;
}

export function createAuthorRelation(store: AliasStore) {
  const aliases = new Set(
    store.aliases.map((entry) => authorPairKey(entry.dc, entry.arca)),
  );
  const rejected = new Set(
    store.rejected.map((entry) => authorPairKey(entry.dc, entry.arca)),
  );
  return (
    dc: { author: DcAuthor; anonymous: boolean },
    arcaNick: string,
  ): AuthorRelation => {
    const key = authorPairKey(dc.author, arcaNick);
    if (rejected.has(key)) return "rejected-alias";
    if (aliases.has(key)) return "alias";
    if (dc.anonymous) return "different";
    const arca = normalizeNick(arcaNick);
    const sharedNick = dc.author.nick === defaultNick;
    if (!sharedNick && normalizeNick(dc.author.nick) === arca)
      return "same-nick";
    // 디시 아이디를 아카 닉네임으로 쓰는 작가도 있다.
    if (dc.author.uid && normalizeNick(dc.author.uid) === arca)
      return "uid-nick";
    return "different";
  };
}

export function isSameAuthor(relation: AuthorRelation) {
  return (
    relation === "same-nick" || relation === "uid-nick" || relation === "alias"
  );
}
