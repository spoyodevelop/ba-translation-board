const titlePrefix =
  /^(?:(?:소설|요청)\s*)?(?:핫산|번역)(?:\s*요청)?\s*[)）:]\s*/;

function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(titlePrefix, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function bigrams(title: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < title.length - 1; index += 1) {
    const gram = title.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

// Dice similarity keeps reordered words and small spelling differences close.
export function titleSimilarity(
  firstTitle: string,
  secondTitle: string,
): number {
  const first = normalizeTitle(firstTitle);
  const second = normalizeTitle(secondTitle);
  if (!first || !second) return 0;
  if (first === second) return 1;
  if (first.length < 2 || second.length < 2) return 0;

  const firstBigrams = bigrams(first);
  const secondBigrams = bigrams(second);
  let shared = 0;
  for (const [gram, count] of firstBigrams) {
    shared += Math.min(count, secondBigrams.get(gram) || 0);
  }
  return (2 * shared) / (first.length + second.length - 2);
}
