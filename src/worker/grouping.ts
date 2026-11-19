import { sourceCacheVersion } from "../sources/sourceCache.ts";
import { JEV_MATCH_THRESHOLD } from "../grouping/evaluateWithJev.ts";
import { titleSimilarity } from "../grouping/titleSimilarity.ts";
import {
  postPairKey,
  findTitleCandidates,
  candidateWindowMs,
} from "../grouping/findCandidates.ts";
import type { createNodeTitleMatcher } from "./titles.ts";
import type { Post } from "../shared/post";
import type { MatchChange } from "../database/types";
import type { WorkerRepositories } from "../database/repositories.ts";
import type { WorkerLog } from "./log.ts";
import type { createNodeSourceCollector } from "./sources.ts";
import type { createNodeImageCollector } from "./images.ts";
import {
  compareFingerprints,
  isImageMatch,
  NODE_IMAGE_FINGERPRINT_VERSION,
} from "../sources/imageHash.ts";

export const NODE_GROUPING_VERSION =
  "node-source-first48h-jev095-v2-grid3-title010-v1";
const imageComparisonTimeoutMs = 10_000;
const candidateImageBatchSize = 3;
const minimumRegionContrast = 12;
// 제목 관련성이 낮은 후보는 이미지 비교에서 제외하고, 누락되는 중복은 수동 판정으로 보완한다.
export const MINIMUM_IMAGE_TITLE_SIMILARITY = 0.1;

export function createNodeGrouper(deps: {
  repositories: WorkerRepositories;
  sources: ReturnType<typeof createNodeSourceCollector>;
  images: ReturnType<typeof createNodeImageCollector>;
  titles: Pick<ReturnType<typeof createNodeTitleMatcher>, "lookup">;
  log?: WorkerLog;
  signal: AbortSignal;
  now?: () => number;
}) {
  const now = deps.now || Date.now;
  return {
    async process(
      target: Post,
    ): Promise<{ comparedCount: number; groupedCount: number }> {
      deps.signal.throwIfAborted();
      const started = performance.now();
      let stage = "source",
        titleMs = 0,
        imageMs = 0;
      let candidateCount = 0,
        cachedSourceMatchCount = 0;
      let imageCandidateCount = 0,
        imageSkippedCandidateCount = 0;
      // 대상 글의 기존 연결만 쓰므로 그것만 읽는다. 연결 전체를 읽으면 글마다 연결 수만큼 읽기 비용이 든다.
      // 한 원문의 여러 번역은 연결 쌍들이 웹에서 합쳐져 한 묶음이 되므로 이 글의 연결만 알면 된다.
      const existing = await deps.repositories.grouping.listMatchesInvolving([
        target.id,
      ]);
      const changes = new Map<string, MatchChange>();
      // 재판정에서 채택하지 않은 기존 근거는 판정 전체가 성공했을 때만 삭제한다.
      for (const match of existing) {
        const otherId =
          match.firstPostId === target.id
            ? match.secondPostId
            : match.firstPostId;
        changes.set(otherId, {
          firstPostId: target.id,
          secondPostId: otherId,
          match: null,
        });
      }
      const sourceStarted = performance.now();
      const targetSource = (await deps.sources.lookup([target]))[target.id];
      let sourceMs = Math.round(performance.now() - sourceStarted);
      if (!targetSource) throw new Error(`본문 조회 실패: ${target.id}`);

      async function decide() {
        if (targetSource.kind === "failed") {
          if (targetSource.status === 404) {
            stage = "deleted";
            return;
          }
          throw new Error(
            `본문 조회 실패: ${target.id}: ${targetSource.error}`,
          );
        }
        if (targetSource.kind === "found") {
          const time = Date.parse(target.publishedAt);
          const searchStarted = performance.now();
          const matches = await deps.repositories.caches.findSourceMatches({
            source: target.source,
            sourceKeys: targetSource.sources.map((source) => source.key),
            since: time - candidateWindowMs,
            until: time + candidateWindowMs,
            version: sourceCacheVersion,
            now: now(),
          });
          sourceMs += Math.round(performance.now() - searchStarted);
          cachedSourceMatchCount = matches.length;
          for (const cached of matches) {
            changes.set(cached.post.id, {
              firstPostId: target.id,
              secondPostId: cached.post.id,
              match: {
                firstPostId: target.id,
                secondPostId: cached.post.id,
                sourceKeys: cached.sourceKeys,
                imageEvidence: null,
                titleEvidence: null,
                creativeEvidence: null,
                algorithmVersion: NODE_GROUPING_VERSION,
                matchedAt: now(),
              },
            });
          }
          // 출처 ID가 다른 중복은 허용하고, 미등록 출처를 이미지 비교로 넘기지 않는다.
          return;
        }
        const nearby = await deps.repositories.posts.listRecent(
          Date.parse(target.publishedAt) - candidateWindowMs,
        );
        const candidates = findTitleCandidates(target, nearby);
        for (const otherId of changes.keys()) {
          if (candidates.some((post) => post.id === otherId)) continue;
          const other = await deps.repositories.posts.get(otherId);
          if (other) candidates.push(other);
        }
        candidateCount = candidates.length;
        for (const candidate of candidates) {
          changes.set(candidate.id, {
            firstPostId: target.id,
            secondPostId: candidate.id,
            match: null,
          });
        }
        if (candidates.length === 0) return;
        stage = "jev";
        const titleStarted = performance.now();
        const decisions = await deps.titles.lookup(target, candidates);
        titleMs = Math.round(performance.now() - titleStarted);
        const titleMatches = new Map(
          decisions
            .filter((decision) => decision.probability >= JEV_MATCH_THRESHOLD)
            .map((decision) => [
              postPairKey(decision.firstPostId, decision.secondPostId),
              decision,
            ]),
        );
        if (titleMatches.size > 0) {
          for (const candidate of candidates) {
            const titleEvidence = titleMatches.get(
              postPairKey(target.id, candidate.id),
            );
            if (!titleEvidence) continue;
            changes.get(candidate.id)!.match = {
              firstPostId: target.id,
              secondPostId: candidate.id,
              sourceKeys: [],
              imageEvidence: null,
              titleEvidence,
              creativeEvidence: null,
              algorithmVersion: NODE_GROUPING_VERSION,
              matchedAt: now(),
            };
          }
          return;
        }
        const imageCandidates = candidates.filter(
          (candidate) =>
            titleSimilarity(target.title, candidate.title) >=
            MINIMUM_IMAGE_TITLE_SIMILARITY,
        );
        imageCandidateCount = imageCandidates.length;
        imageSkippedCandidateCount = candidates.length - imageCandidates.length;
        if (imageCandidates.length === 0) return;
        stage = "image";
        const imageStarted = performance.now();
        const signal = AbortSignal.any([
          deps.signal,
          AbortSignal.timeout(imageComparisonTimeoutMs),
        ]);
        const image = await deps.images.lookup(target, targetSource, signal);
        if (image.kind === "failed" && image.status !== 404)
          throw new Error(`이미지 조회 실패: ${target.id}: ${image.error}`);
        if (image.kind === "found") {
          for (
            let offset = 0;
            offset < imageCandidates.length;
            offset += candidateImageBatchSize
          ) {
            const batch = imageCandidates.slice(
              offset,
              offset + candidateImageBatchSize,
            );
            const lookupStarted = performance.now();
            const sources = await deps.sources.lookup(batch);
            sourceMs += Math.round(performance.now() - lookupStarted);
            signal.throwIfAborted();
            const results = await Promise.all(
              batch.map(async (candidate) => {
                const source = sources[candidate.id];
                if (
                  !source ||
                  (source.kind === "failed" && source.status !== 404)
                )
                  throw new Error(`본문 조회 실패: ${candidate.id}`);
                return deps.images.lookup(candidate, source, signal);
              }),
            );
            for (let index = 0; index < batch.length; index++) {
              const candidate = batch[index];
              const other = results[index];
              if (other.kind === "failed" && other.status !== 404)
                throw new Error(
                  `이미지 조회 실패: ${candidate.id}: ${other.error}`,
                );
              if (other.kind !== "found") continue;
              const evidence = compareFingerprints(
                image.fingerprint,
                other.fingerprint,
                minimumRegionContrast,
                NODE_IMAGE_FINGERPRINT_VERSION,
              );
              if (!isImageMatch(evidence)) continue;
              changes.get(candidate.id)!.match = {
                firstPostId: target.id,
                secondPostId: candidate.id,
                sourceKeys: [],
                imageEvidence: evidence,
                titleEvidence: null,
                creativeEvidence: null,
                algorithmVersion: NODE_GROUPING_VERSION,
                matchedAt: now(),
              };
            }
          }
        }
        imageMs = Math.round(performance.now() - imageStarted);
      }
      await decide();
      deps.signal.throwIfAborted();
      await deps.repositories.grouping.commit({
        comparisons: [...changes.values()],
        processed: [
          {
            postId: target.id,
            algorithmVersion: NODE_GROUPING_VERSION,
            processedAt: now(),
          },
        ],
      });
      const groupedCount = [...changes.values()].filter(
        (change) => change.match !== null,
      ).length;
      deps.log?.({
        event: "grouping-decision",
        postId: target.id,
        stage,
        algorithmVersion: NODE_GROUPING_VERSION,
        sourceOutcome: targetSource.kind,
        candidateCount,
        cachedSourceMatchCount,
        imageCandidateCount,
        imageSkippedCandidateCount,
        matchedCount: groupedCount,
        elapsedMs: Math.round(performance.now() - started),
        titleMs,
        sourceMs,
        imageMs,
      });
      return { comparedCount: changes.size, groupedCount };
    },
  };
}
