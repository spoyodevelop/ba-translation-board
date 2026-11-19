import { postPairKey } from "../grouping/findCandidates.ts";
import {
  makeTitlePair,
  JEV_MATCH_THRESHOLD,
} from "../grouping/evaluateWithJev.ts";
import type {
  JevTitleDecision,
  TitleEvaluator,
} from "../grouping/evaluateWithJev.ts";
import type { Post } from "../shared/post";
import type { WorkerRepositories } from "../database/repositories.ts";
import type { WorkerLog } from "./log.ts";

export function createNodeTitleMatcher(deps: {
  repositories: WorkerRepositories;
  // 캐시에 없는 쌍만 평가한다.
  evaluate: TitleEvaluator;
  signal: AbortSignal;
  now?: () => number;
  log?: WorkerLog;
}) {
  const now = deps.now || Date.now;
  return {
    async lookup(
      target: Post,
      candidates: Post[],
    ): Promise<JevTitleDecision[]> {
      const started = performance.now();
      deps.signal.throwIfAborted();
      const pairs = candidates.map((candidate) =>
        makeTitlePair(target, candidate),
      );
      const cached = await deps.repositories.titles.read(pairs, now());
      const pending = pairs.filter(
        (pair) => !cached.has(postPairKey(pair.first.id, pair.second.id)),
      );
      let fresh: JevTitleDecision[] = [];
      if (pending.length > 0) {
        fresh = await deps.evaluate(pending, deps.signal);
        deps.signal.throwIfAborted();
        await deps.repositories.titles.save(fresh, now());
      }
      const decisions = [...cached.values(), ...fresh];
      deps.log?.({
        event: "jev-evaluated",
        postId: target.id,
        elapsedMs: Math.round(performance.now() - started),
        evaluatedPairs: fresh.length,
        cacheHitCount: cached.size,
        matchedCount: decisions.filter(
          (decision) => decision.probability >= JEV_MATCH_THRESHOLD,
        ).length,
        threshold: JEV_MATCH_THRESHOLD,
      });
      return decisions;
    },
  };
}
