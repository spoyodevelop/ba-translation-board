import type { Post } from "../shared/post";

export const JEV_MATCH_THRESHOLD = 0.95;
export const JEV_TITLE_POLICY_VERSION = 2;
export const JEV_TITLE_CACHE_TTL_MS = 72 * 60 * 60_000;
const endpoint = "https://api.typesafe.ai/v1/systemone";
const model = "jev-latest";
const questionsPerRequest = 100;
const requestTimeoutMs = 30_000;

export type TitlePair = { first: Post; second: Post };
export type JevTitleEvidence = {
  firstTitle: string;
  secondTitle: string;
  probability: number;
  model: string;
  evaluatedAt: number;
};
export type JevTitleDecision = JevTitleEvidence & {
  firstPostId: string;
  secondPostId: string;
};

// 제목 쌍이 같은 장면·회차인지 확률로 답한다. worker는 키 대신 이 함수를 받아 쓴다.
export type TitleEvaluator = (
  pairs: TitlePair[],
  signal: AbortSignal,
) => Promise<JevTitleDecision[]>;

// 키가 없으면 worker를 시작할 때 실패한다. 빈 키로 판정 요청을 보내지 않는다.
export function createJevTitleEvaluator(
  apiKey: string,
  options: { request?: typeof fetch; now?: () => number } = {},
): TitleEvaluator {
  if (!apiKey.trim()) throw new Error("JEV_KEY를 설정하세요.");
  return (pairs, signal) =>
    evaluateTitlePairs(pairs, apiKey, { ...options, signal });
}

export function makeTitlePair(first: Post, second: Post): TitlePair {
  if (first.id < second.id) return { first, second };
  return { first: second, second: first };
}

export async function evaluateTitlePairs(
  pairs: TitlePair[],
  apiKey: string,
  options: { signal: AbortSignal; request?: typeof fetch; now?: () => number },
): Promise<JevTitleDecision[]> {
  if (!apiKey.trim()) throw new Error("JEV_KEY를 설정하세요.");
  const request = options.request || fetch;
  const now = options.now || Date.now;
  const decisions: JevTitleDecision[] = [];
  for (let offset = 0; offset < pairs.length; offset += questionsPerRequest) {
    options.signal.throwIfAborted();
    const batch = pairs.slice(offset, offset + questionsPerRequest);
    const questions = Object.fromEntries(
      batch.map((pair, index) => [
        `pair_${index}`,
        {
          type: "noul",
          // 시리즈 전체가 아닌 개별 장면·회차를 비교한다. 정보가 부족하면 출처 단계가 판단한다.
          instructions: `Are title A and title B semantically equivalent, referring to the same individual scene or episode? 제목 A: ${pair.first.title} / 제목 B: ${pair.second.title}`,
          criteria: {
            true: "The titles have the same meaning. Ignore translation tags such as 핫산 and 번역, spelling variations, punctuation, spacing, and paraphrasing.",
            false:
              "The titles describe different scenes or episodes, or merely share characters or a series name. Episode numbers are meaningful and must not be ignored. If only one title specifies an episode or part, the titles alone do not establish that they refer to the same episode.",
          },
        },
      ]),
    );
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        state:
          "블루 아카이브 번역 게시물의 제목 의미를 비교한다. 원문을 추측하지 않고 주어진 제목의 의미가 동일한지 판단한다.",
        questions,
      }),
      signal: AbortSignal.any([
        options.signal,
        AbortSignal.timeout(requestTimeoutMs),
      ]),
    });
    // 응답 본문에는 요청 정보가 포함될 수 있으므로 오류 로그에는 상태만 남긴다.
    if (!response.ok) throw new Error(`Jev 요청 실패: HTTP ${response.status}`);
    const result = (await response.json()) as {
      model?: string;
      answers?: Record<string, { type?: string; noul?: number }>;
    };
    if (!result.model) throw new Error("Jev 응답에 모델 정보가 없습니다.");
    for (const [index, pair] of batch.entries()) {
      const answer = result.answers?.[`pair_${index}`];
      const probability = answer?.noul;
      const valid =
        answer?.type === "noul" &&
        typeof probability === "number" &&
        Number.isFinite(probability) &&
        probability >= 0 &&
        probability <= 1;
      if (!valid) throw new Error("Jev 응답에 올바른 확률이 없습니다.");
      decisions.push({
        firstPostId: pair.first.id,
        secondPostId: pair.second.id,
        firstTitle: pair.first.title,
        secondTitle: pair.second.title,
        probability,
        model: result.model,
        evaluatedAt: now(),
      });
    }
  }
  options.signal.throwIfAborted();
  return decisions;
}
