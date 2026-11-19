export type OriginalSource = {
  key: `x:${string}` | `pixiv:${string}`;
  url: string;
};

export type SourceLookupResult =
  | { kind: "found"; sources: OriginalSource[]; imageUrl?: string }
  | { kind: "none"; sources: []; imageUrl?: string }
  | { kind: "failed"; error: string; status?: number | null };

export type SourceLookupSuccess = Exclude<
  SourceLookupResult,
  { kind: "failed" }
>;
