import {
  creativePairWindowMs,
  judgeCreativePairs,
} from "../grouping/creativeMatch.ts";
import {
  createAuthorRelation,
  isAnonymousDcAuthor,
  isSameAuthor,
} from "../grouping/creativeAuthors.ts";
import type { AliasStore } from "../grouping/creativeAuthors.ts";
import type { WorkerRepositories } from "../database/repositories.ts";
import type { MatchChange, StoredPost } from "../database/types";

// 창작 글은 본문·이미지·Jev 없이 목록 정보만으로 판정한다. 사이트 요청이 생기지 않는다.
export const CREATIVE_GROUPING_VERSION = "creative-author-title-v1";
// 창작 탭을 열기 전에 사람이 판정해 넣은 짝이다. 규칙이 바뀌어도 다시 판정하지 않는다.
export const CREATIVE_MANUAL_VERSION = "creative-manual-v1";

export function createCreativeGrouper(deps: {
  // 창작 board 저장소여야 한다.
  repositories: WorkerRepositories;
  aliases: AliasStore;
  now: () => number;
}) {
  const relationOf = createAuthorRelation(deps.aliases);

  function sameAuthor(dc: StoredPost, arca: StoredPost) {
    if (!dc.author || !arca.author) return false;
    const author = { uid: dc.authorId, nick: dc.author };
    const relation = relationOf(
      { author, anonymous: isAnonymousDcAuthor(author) },
      arca.author,
    );
    return isSameAuthor(relation);
  }

  return {
    async process(
      target: StoredPost,
    ): Promise<{ comparedCount: number; groupedCount: number }> {
      const time = Date.parse(target.publishedAt);
      const nearby = await deps.repositories.posts.listRecent(
        time - creativePairWindowMs,
      );
      const nearbyOpposite = nearby.filter((post) => {
        const gap = Math.abs(Date.parse(post.publishedAt) - time);
        return post.source !== target.source && gap <= creativePairWindowMs;
      });
      const matches = await deps.repositories.grouping.listMatchesInvolving([
        target.id,
        ...nearbyOpposite.map((post) => post.id),
      ]);
      const involvesTarget = (match: (typeof matches)[number]) =>
        match.firstPostId === target.id || match.secondPostId === target.id;
      const own = matches.filter(involvesTarget);
      const processed = [
        {
          postId: target.id,
          algorithmVersion: CREATIVE_GROUPING_VERSION,
          processedAt: deps.now(),
        },
      ];
      if (own.some((match) => match.algorithmVersion === CREATIVE_MANUAL_VERSION)) {
        await deps.repositories.grouping.commit({ comparisons: [], processed });
        return { comparedCount: 0, groupedCount: 0 };
      }

      // 한 글은 반대 사이트의 한 글하고만 같다. 이미 다른 글과 짝이 정해진 글은 후보에서 뺀다.
      const pairedElsewhere = new Set(
        matches
          .filter((match) => !involvesTarget(match))
          .flatMap((match) => [match.firstPostId, match.secondPostId]),
      );
      const candidates = nearbyOpposite.filter(
        (post) => !pairedElsewhere.has(post.id),
      );
      const listed = (post: StoredPost) => ({
        id: post.id,
        title: post.title,
        publishedAt: Date.parse(post.publishedAt),
      });
      const pairs = candidates.map((candidate) => {
        const [dc, arca] =
          target.source === "dc" ? [target, candidate] : [candidate, target];
        return {
          dc: listed(dc),
          arca: listed(arca),
          sameAuthor: sameAuthor(dc, arca),
          other: candidate,
        };
      });
      // 이미지 비교가 필요한 쌍은 묶지 않고 두 줄로 둔다.
      const chosen = judgeCreativePairs(pairs).find(
        (result) => result.verdict === "same",
      );

      const comparisons: MatchChange[] = own
        .map((match) =>
          match.firstPostId === target.id ? match.secondPostId : match.firstPostId,
        )
        .filter((otherId) => otherId !== chosen?.other.id)
        .map((otherId) => ({
          firstPostId: target.id,
          secondPostId: otherId,
          match: null,
        }));
      if (chosen) {
        comparisons.push({
          firstPostId: target.id,
          secondPostId: chosen.other.id,
          match: {
            firstPostId: target.id,
            secondPostId: chosen.other.id,
            sourceKeys: [],
            imageEvidence: null,
            titleEvidence: null,
            creativeEvidence: {
              kind: "rule",
              reason: chosen.reason,
              similarity: Number(chosen.similarity.toFixed(3)),
              gapMinutes: Math.round(chosen.gapMs / 60_000),
              sameAuthor: chosen.sameAuthor,
            },
            algorithmVersion: CREATIVE_GROUPING_VERSION,
            matchedAt: deps.now(),
          },
        });
      }
      await deps.repositories.grouping.commit({ comparisons, processed });
      return { comparedCount: candidates.length, groupedCount: chosen ? 1 : 0 };
    },
  };
}
