import type { Post } from "../shared/post";

export type GroupEdge = { firstId: string; secondId: string };

// worker가 저장한 자동 연결로 같은 글끼리 묶는다. 연결은 이어진 만큼 모두 한 묶음이 된다.
export function mergePostGroups(
  posts: Omit<Post, "duplicateGroupId">[],
  edges: GroupEdge[],
): Post[] {
  const roots = new Map(posts.map((post) => [post.id, post.id]));
  const members = new Map(posts.map((post) => [post.id, new Set([post.id])]));

  function connect(firstId: string, secondId: string) {
    const firstRoot = roots.get(firstId);
    const secondRoot = roots.get(secondId);
    if (!firstRoot || !secondRoot || firstRoot === secondRoot) return;
    const firstMembers = members.get(firstRoot)!;
    for (const id of members.get(secondRoot)!) {
      roots.set(id, firstRoot);
      firstMembers.add(id);
    }
    members.delete(secondRoot);
  }

  for (const edge of edges) connect(edge.firstId, edge.secondId);

  const groupIds = new Map<string, string>();
  for (const [root, ids] of members) {
    if (ids.size < 2) continue;
    const sorted = [...ids].sort();
    groupIds.set(root, `source:${sorted[0]}:${sorted[1]}`);
  }
  return posts.map((post) => ({
    ...post,
    duplicateGroupId: groupIds.get(roots.get(post.id)!) || null,
  }));
}
