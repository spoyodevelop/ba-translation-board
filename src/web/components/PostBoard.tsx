import styled from "@emotion/styled";
import { useMemo, useRef, useState } from "react";
import type { Post } from "../../shared/post";
import type { PostArtist } from "../../database/boardSnapshot";
import type { ArtistFilterEvent, OpenedPost, SearchEvent } from "../analytics.ts";
import { useArtistFilter } from "../hooks/useArtistFilter.ts";
import type { ArtistFilter } from "../hooks/useArtistFilter.ts";
import type { FollowedArtist } from "../personalState.ts";
import { ArtistFilterBar } from "./ArtistFilterBar";
import { pageSize } from "../config";
import { colors } from "../theme";
import { Pagination } from "./Pagination";
import { PostGroupItem } from "./PostGroupItem";
import type { GroupArtist } from "./PostGroupItem";

type Props = {
  posts: Post[];
  artists: PostArtist[];
  followedArtists: FollowedArtist[];
  visitedPostIds: Set<string>;
  onOpenPost: (opened: OpenedPost) => void;
  onSearch: (search: Omit<SearchEvent, "board">) => void;
  onFilterArtist: (event: Omit<ArtistFilterEvent, "board">) => void;
  onFollowArtist: (artist: FollowedArtist) => void;
  onUnfollowArtist: (key: string) => void;
  loading: boolean;
  hasLoadError: boolean;
  loadErrorMessage: string;
  emptyMessage: string;
  showsOriginalArtists: boolean;
};

export function PostBoard({
  posts,
  artists,
  followedArtists,
  visitedPostIds,
  onOpenPost,
  onSearch,
  onFilterArtist,
  onFollowArtist,
  onUnfollowArtist,
  loading,
  hasLoadError,
  loadErrorMessage,
  emptyMessage,
  showsOriginalArtists,
}: Props) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [recommendationChoice, setRecommendationChoice] = useState("");
  const [minRecommendations, setMinRecommendations] = useState<number | null>(null);
  const { filter: requestedArtistFilter, selectFilter: selectArtistFilter } =
    useArtistFilter();
  // 원작 작가를 보여 주지 않는 board에서는 주소에 작가 필터가 남아 있어도 거르지 않는다.
  let artistFilter: ArtistFilter | null = null;
  if (showsOriginalArtists) artistFilter = requestedArtistFilter;
  let selectedArtistKey: string | null = null;
  if (artistFilter?.kind === "artist") selectedArtistKey = artistFilter.key;
  const hasFilters =
    query !== "" || minRecommendations !== null || artistFilter !== null;
  const boardRef = useRef<HTMLElement>(null);
  const groups = useMemo(() => groupPosts(posts, artists), [posts, artists]);
  const artistGroupCounts = useMemo(() => countArtistGroups(groups), [groups]);
  const followedKeys = useMemo(
    () => new Set(followedArtists.map((artist) => artist.key)),
    [followedArtists],
  );
  const filteredGroups = useMemo(() => {
    if (!hasFilters) return groups;
    const needle = query.toLowerCase();
    return groups.filter((group) => {
      if (!matchesArtistFilter(group, artistFilter, followedKeys)) return false;
      return group.posts.some((post) => {
        const meetsMinimum = minRecommendations === null ||
          (post.recommendCount != null && post.recommendCount >= minRecommendations);
        return meetsMinimum && post.title.toLowerCase().includes(needle);
      });
    });
  }, [groups, hasFilters, query, minRecommendations, artistFilter, followedKeys]);
  // 지금 목록에 그 작가 글이 없으면 팔로우할 때 저장해 둔 이름을 쓴다.
  const selectedArtist = useMemo((): FollowedArtist | null => {
    if (selectedArtistKey === null) return null;
    const found =
      artists.find((artist) => artist.key === selectedArtistKey) ??
      followedArtists.find((artist) => artist.key === selectedArtistKey);
    if (found) return { key: found.key, name: found.name };
    return { key: selectedArtistKey, name: selectedArtistKey };
  }, [artists, followedArtists, selectedArtistKey]);
  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleGroups = filteredGroups.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  function selectArtist(next: ArtistFilter | null) {
    selectArtistFilter(next);
    setPage(1);
    boardRef.current?.scrollIntoView({ block: "start" });
    if (next === null) return;
    const groupCount = groups.filter((group) =>
      matchesArtistFilter(group, next, followedKeys),
    ).length;
    onFilterArtist({ mode: next.kind, groupCount });
  }

  function goToPage(nextPage: number) {
    setPage(nextPage);
    boardRef.current?.scrollIntoView({ block: "start" });
  }

  const showPagination = filteredGroups.length > pageSize;

  return (
    <Board ref={boardRef} aria-label="통합 게시판">
      <BoardHeading>
        <h2>{hasFilters ? "검색 결과" : "전체 글"}</h2>
        <span role="status">
          {!hasFilters && `${posts.length}개 · `}{filteredGroups.length}묶음
        </span>
      </BoardHeading>
      <SearchForm
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const nextQuery = String(data.get("title") ?? "").trim();
          setQuery(nextQuery);
          onSearch({ hasQuery: nextQuery !== "", minRecommend: recommendationChoice });
          const minimum = recommendationChoice === "custom"
            ? String(data.get("customMinimum") ?? "")
            : recommendationChoice;
          setMinRecommendations(minimum === "" ? null : Number(minimum));
          setPage(1);
        }}
      >
        <input type="search" name="title" aria-label="제목 검색" placeholder="제목 검색" />
        <select
          aria-label="최소 추천수"
          value={recommendationChoice}
          onChange={(event) => setRecommendationChoice(event.target.value)}
        >
          <option value="">추천컷</option>
          {[5, 10, 20, 30, 50, 70, 100].map((count) => (
            <option key={count} value={count}>{count}</option>
          ))}
          <option value="custom">기타</option>
        </select>
        {recommendationChoice === "custom" && (
          <input
            type="number"
            name="customMinimum"
            aria-label="최소 추천수 직접 입력"
            placeholder="직접 입력"
            min="0"
            step="1"
            inputMode="numeric"
            required
          />
        )}
        <button type="submit">검색</button>
      </SearchForm>
      {showsOriginalArtists && (
        <ArtistFilterBar
          filter={artistFilter}
          selectedArtist={selectedArtist}
          followedArtists={followedArtists}
          onSelect={selectArtist}
          onFollow={onFollowArtist}
          onUnfollow={onUnfollowArtist}
        />
      )}
      {showPagination && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={goToPage}
        />
      )}
      {loading && <State>불러오는 중…</State>}
      {hasLoadError && <State>{loadErrorMessage}</State>}
      {!loading && !hasLoadError && posts.length === 0 && (
        <Empty>
          <strong>아직 모아둔 글이 없어요.</strong>
          <p>{emptyMessage}</p>
        </Empty>
      )}
      {!loading && !hasLoadError && posts.length > 0 && filteredGroups.length === 0 && (
        <Empty><strong>검색 조건에 맞는 글이 없어요.</strong></Empty>
      )}
      {!loading &&
        !hasLoadError &&
        visibleGroups.map((group, index) => (
          <PostGroupItem
            key={group.key}
            posts={group.posts}
            artists={group.artists.map((artist) => ({
              ...artist,
              groupCount: artistGroupCounts.get(artist.key) ?? 1,
              followed: followedKeys.has(artist.key),
            }))}
            selectedArtist={selectedArtistKey}
            onSelectArtist={(key) => selectArtist({ kind: "artist", key })}
            visitedPostIds={visitedPostIds}
            onOpenPost={(post) =>
              onOpenPost({
                post,
                groupSize: group.posts.length,
                position: (currentPage - 1) * pageSize + index + 1,
                page: currentPage,
                filtered: hasFilters,
              })
            }
          />
        ))}
      {showPagination && (
        <Pagination
          bottom
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={goToPage}
        />
      )}
    </Board>
  );
}

type PostGroup = {
  key: string;
  posts: Post[];
  artists: Omit<GroupArtist, "groupCount" | "followed">[];
  publishedAt: number;
};

function groupPosts(posts: Post[], postArtists: PostArtist[]): PostGroup[] {
  const artistsByPost = new Map<string, PostArtist[]>();
  for (const artist of postArtists) {
    const list = artistsByPost.get(artist.postId) || [];
    list.push(artist);
    artistsByPost.set(artist.postId, list);
  }
  const groups = new Map<string, Post[]>();
  for (const post of posts) {
    const key = post.duplicateGroupId || `post:${post.id}`;
    const group = groups.get(key) || [];
    group.push(post);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, groupedPosts]) => ({
      key,
      posts: groupedPosts.sort(
        (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
      ),
      artists: groupArtists(groupedPosts, artistsByPost),
      publishedAt: Math.max(
        ...groupedPosts.map((post) => Date.parse(post.publishedAt)),
      ),
    }))
    .sort((a, b) => b.publishedAt - a.publishedAt);
}

// 같은 번역이 두 사이트에 올라와 출처가 달라도 작가는 한 번만 보인다.
function groupArtists(
  posts: Post[],
  artistsByPost: Map<string, PostArtist[]>,
): PostGroup["artists"] {
  const artists = new Map<string, string>();
  for (const post of posts) {
    for (const artist of artistsByPost.get(post.id) || []) {
      if (!artists.has(artist.key)) artists.set(artist.key, artist.name);
    }
  }
  return [...artists].map(([key, name]) => ({ key, name }));
}

function matchesArtistFilter(
  group: PostGroup,
  filter: ArtistFilter | null,
  followedKeys: Set<string>,
): boolean {
  if (filter === null) return true;
  if (filter.kind === "artist")
    return group.artists.some((artist) => artist.key === filter.key);
  return group.artists.some((artist) => followedKeys.has(artist.key));
}

function countArtistGroups(groups: PostGroup[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const artist of group.artists)
      counts.set(artist.key, (counts.get(artist.key) ?? 0) + 1);
  }
  return counts;
}

const Board = styled.section`
  overflow: hidden;
  border: 1px solid ${colors.border};
  border-radius: 16px;
  background: ${colors.surface};
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.28);
`;

const BoardHeading = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 22px 24px;
  border-bottom: 1px solid ${colors.border};
  background: ${colors.surfaceRaised};

  h2 {
    margin: 0;
    font-size: 18px;
  }
  h2 {
    color: ${colors.textStrong};
  }
  span {
    color: ${colors.textMuted};
    font-size: 14px;
  }
`;

const SearchForm = styled.form`
  display: flex;
  gap: 8px;
  padding: 12px 24px;
  border-bottom: 1px solid ${colors.border};

  flex-wrap: wrap;
  input[type="search"] {
    flex: 1 1 130px;
  }
  input[type="number"] {
    flex: none;
    width: 7em;
  }
  input, select, button {
    padding: 8px 12px;
    border: 1px solid ${colors.border};
    border-radius: 6px;
    color: ${colors.textStrong};
    font: inherit;
  }
  input {
    flex: 1;
    min-width: 0;
    background: ${colors.canvas};
  }
  select, button {
    background: ${colors.button};
    cursor: pointer;
  }
`;

const State = styled.p`
  padding: 32px 24px;
  color: ${colors.textMuted};
  font-size: 14px;
  line-height: 1.6;
`;

const Empty = styled.div`
  padding: 64px 20px 70px;
  text-align: center;

  strong {
    font-size: 17px;
  }
  strong {
    color: ${colors.textStrong};
  }
  p {
    color: ${colors.textMuted};
    font-size: 14px;
    line-height: 1.6;
  }
`;
