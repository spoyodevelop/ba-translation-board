import { useEffect, useMemo } from "react";
import styled from "@emotion/styled";
import { AppHeader } from "./components/AppHeader";
import { SourceLinks } from "./components/SourceLinks";
import { BoardTabs } from "./components/BoardTabs";
import { searchForBoard, useBoardTab } from "./hooks/useBoardTab";
import { PostBoard } from "./components/PostBoard";
import { createBadgeCatalog } from "./badges.ts";
import { characterAliases, characters } from "../characters/characterList.ts";
import { clubs } from "../characters/clubList.ts";
import { createBadgeMatcher } from "../characters/matchBadges.ts";
import { titleWords } from "../characters/titleWords.ts";
import { useTursoBoard } from "./hooks/useTursoBoard";
import { usePersonalState } from "./hooks/usePersonalState";
import { mergePostGroups } from "../grouping/postGroups.ts";
import {
  trackArtistFilter,
  trackBadgeFilter,
  trackFollowArtist,
  trackOpenPost,
  trackSearch,
} from "./analytics.ts";
import type { OpenedPost } from "./analytics.ts";
import { colors } from "./theme";
import { boardConfigs } from "../shared/boards.ts";
import { postRetentionMonths } from "../shared/post.ts";

const koreanDate = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "long",
  timeZone: "Asia/Seoul",
});


// 캐시를 탭 전환과 목록 갱신 사이에 함께 쓰도록 앱에서 한 번만 만든다.
const badgeCatalog = createBadgeCatalog({
  matchTitle: createBadgeMatcher({ characters, aliases: characterAliases, clubs, words: titleWords }),
  characters,
  clubs,
});

export function TursoBoard() {
  const tab = useBoardTab();
  const boardConfig = boardConfigs[tab.board];
  const board = useTursoBoard(boardConfig.board);
  useEffect(() => {
    document.title = `블루아카이브 ${boardConfig.label} 모아보기 | 블루아카이브 ${boardConfig.label} 탭`;
  }, [boardConfig.label]);
  useEffect(() => {
    // 탭마다 글이 달라 따로 색인하고, 작가·배지 필터는 같은 탭의 일부라 탭 주소 하나로 모은다.
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) return;
    canonical.href = `${window.location.origin}/${searchForBoard("", tab.board)}`;
  }, [tab.board]);
  const personal = usePersonalState();
  const posts = useMemo(
    () => mergePostGroups(board.snapshot.posts, board.snapshot.automaticEdges),
    [board.snapshot],
  );
  function openPost(opened: OpenedPost) {
    trackOpenPost({ ...opened, board: tab.board });
    personal.markVisited(opened.post.id);
  }
  const oldestPost = board.snapshot.posts.at(-1);
  let status = "목록을 불러오는 중…";
  // 새로 연 탭은 글이 있어도 아직 수집에 성공한 기록이 없을 수 있다.
  if (!board.loading) status = "아직 수집 기록이 없어요.";
  if (board.snapshot.updatedAt)
    status = `목록 갱신 · ${new Date(board.snapshot.updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`;
  if (board.error) status = `목록 연결 오류 · ${board.error}`;
  return (
    <Shell>
      <AppHeader board={boardConfig} />
      <BoardTabs board={tab.board} onSelect={tab.selectBoard} />
      <SourceLinks board={boardConfig} />
      <BoardInfo>
        <p>글은 작성일 기준으로 최근 {postRetentionMonths}개월간 보관해요.</p>
        {oldestPost && (
          <p>가장 오래된 글 {koreanDate.format(new Date(oldestPost.publishedAt))} 작성</p>
        )}
        <p role="status">{status}</p>
      </BoardInfo>
      {personal.error && <Status role="alert">{personal.error}</Status>}
      {/* 탭을 바꾸면 검색어·추천수 조건·페이지를 새로 시작한다. 다른 탭의 조건이 남으면 빈 목록처럼 보인다. */}
      <PostBoard
        key={tab.board}
        posts={posts}
        artists={board.snapshot.artists}
        badgeCatalog={badgeCatalog}
        followedArtists={personal.followedArtists}
        visitedPostIds={personal.visits}
        onOpenPost={openPost}
        onSearch={(search) => trackSearch({ ...search, board: tab.board })}
        onFilterArtist={(event) =>
          trackArtistFilter({ ...event, board: tab.board })
        }
        onFilterBadge={(event) => trackBadgeFilter({ ...event, board: tab.board })}
        onFollowArtist={(artist) => {
          personal.follow(artist);
          trackFollowArtist({ board: tab.board, action: "follow" });
        }}
        onUnfollowArtist={(key) => {
          personal.unfollow(key);
          trackFollowArtist({ board: tab.board, action: "unfollow" });
        }}
        loading={board.loading}
        hasLoadError={Boolean(board.error) && board.snapshot.posts.length === 0}
        loadErrorMessage="목록을 불러오지 못했어요. 잠시 후 다시 접속해 주세요."
        emptyMessage="새 글이 수집되면 여기에 표시돼요."
        showsOriginalArtists={boardConfig.showsOriginalArtists}
      />
      {/* 다른 사이트처럼 짧게 알린다. 수집 항목을 나열하면 오히려 감시처럼 읽힌다. */}
      <AnalyticsNotice>
        사이트 개선을 위해 Google Analytics를 사용하며, 데이터는 익명으로
        보관해요.
      </AnalyticsNotice>
    </Shell>
  );
}
const Shell = styled.main`
  width: min(100%, 860px);
  margin: 0 auto;
  padding: 72px 24px;
  @media (max-width: 560px) {
    padding: 42px 14px;
  }
`;
const BoardInfo = styled.div`
  margin: -12px 0 20px;
  color: ${colors.textMuted};
  font-size: 13px;
  line-height: 1.6;

  p {
    margin: 0;
  }
`;
const Status = styled.p`
  margin: -12px 0 20px;
  color: ${colors.textMuted};
  font-size: 12px;
`;
const AnalyticsNotice = styled.p`
  margin: 24px 0 0;
  color: ${colors.textMuted};
  font-size: 12px;
  line-height: 1.6;
`;
