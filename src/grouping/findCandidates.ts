import type { Post } from "../shared/post";
import { titleSimilarity } from "./titleSimilarity.ts";

export const candidateWindowMs = 48 * 60 * 60_000;
export const candidateLimit = 100;
export const titleCandidateLimit = 10;

export function postPairKey(firstId: string, secondId: string) {
  return [firstId, secondId].sort().join("\u0000");
}

export function findTitleCandidates(target: Post, allPosts: Post[]): Post[] {
  const targetTime = Date.parse(target.publishedAt);
  if (!Number.isFinite(targetTime)) return [];

  const nearby: Array<{ post: Post; distance: number }> = [];
  for (const post of allPosts) {
    if (post.source === target.source || post.id === target.id) continue;
    const distance = Math.abs(Date.parse(post.publishedAt) - targetTime);
    if (Number.isFinite(distance) && distance <= candidateWindowMs) {
      nearby.push({ post, distance });
    }
  }
  nearby.sort((a, b) => a.distance - b.distance);

  const ranked: Array<{ post: Post; distance: number; similarity: number }> =
    [];
  for (const { post, distance } of nearby.slice(0, candidateLimit)) {
    const similarity = titleSimilarity(target.title, post.title);
    ranked.push({ post, distance, similarity });
  }
  ranked.sort((a, b) => b.similarity - a.similarity || a.distance - b.distance);

  return ranked.slice(0, titleCandidateLimit).map(({ post }) => post);
}
