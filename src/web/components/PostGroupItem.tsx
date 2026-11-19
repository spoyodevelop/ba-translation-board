import styled from "@emotion/styled";
import type { Post, Source } from "../../shared/post";
import { sources } from "../config";
import { formatPostTime } from "../format";
import { colors } from "../theme";

// 묶음에 실린 원작의 작가다. 목록 전체에서 이 작가의 묶음 수와 팔로우 여부를 함께 보여 준다.
export type GroupArtist = {
  key: string;
  name: string;
  groupCount: number;
  followed: boolean;
};

type Props = {
  posts: Post[];
  artists: GroupArtist[];
  selectedArtist: string | null;
  onSelectArtist: (key: string) => void;
  visitedPostIds: Set<string>;
  onOpenPost: (post: Post) => void;
};

const sourceOrder: Record<Source, number> = { dc: 0, arca: 1 };

export function PostGroupItem({
  posts,
  artists,
  selectedArtist,
  onSelectArtist,
  visitedPostIds,
  onOpenPost,
}: Props) {
  const representative = posts[0];
  const links = [...posts].sort((a, b) => {
    const sourceDifference = sourceOrder[a.source] - sourceOrder[b.source];
    return (
      sourceDifference || Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
    );
  });
  const anyVisited = posts.some((post) => visitedPostIds.has(post.id));
  const singlePost = posts.length === 1 ? representative : undefined;

  return (
    <Group $grouped={posts.length > 1} $visited={anyVisited}>
      <TitleRow>
        <ContentTitle $visited={anyVisited}>
          {singlePost ? (
            <TitleLink
              href={singlePost.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => onOpenPost(singlePost)}
              onAuxClick={(event) => {
                if (event.button === 1) onOpenPost(singlePost);
              }}
            >
              {singlePost.title}
            </TitleLink>
          ) : (
            representative.title
          )}
        </ContentTitle>
        {artists.map((artist) => (
          <ArtistChip
            key={artist.key}
            type="button"
            aria-pressed={artist.key === selectedArtist}
            title={`${artist.name} 작가의 작품 모아보기`}
            onClick={() => onSelectArtist(artist.key)}
          >
            {artist.followed && <Star aria-label="팔로우 중">★</Star>}
            {artist.name}
            {artist.groupCount > 1 && <span>{artist.groupCount}</span>}
          </ArtistChip>
        ))}
      </TitleRow>
      <SourceLinks>
        {links.map((post) => {
          const visited = visitedPostIds.has(post.id);
          return (
            <SourceRow key={post.id}>
              <SourceLink
                $visited={visited}
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onOpenPost(post)}
                onAuxClick={(event) => {
                  if (event.button === 1) onOpenPost(post);
                }}
                title={post.title}
                aria-label={`${sources[post.source].label} 원문: ${post.title}`}
              >
                <Branch aria-hidden="true">└</Branch>
                <SourceBadge $source={post.source}>
                  {sources[post.source].label}
                </SourceBadge>
                <PostMeta>
                  {post.author && `${post.author} · `}
                  <time
                    dateTime={post.publishedAt}
                    title={new Date(post.publishedAt).toLocaleString("ko-KR")}
                  >
                    {formatPostTime(post.publishedAt)}
                  </time>
                  {post.viewCount != null &&
                    ` · 조회 ${post.viewCount.toLocaleString()}`}
                  {post.recommendCount != null &&
                    ` · 추천 ${post.recommendCount.toLocaleString()}`}
                </PostMeta>
              </SourceLink>
            </SourceRow>
          );
        })}
      </SourceLinks>
    </Group>
  );
}

const Group = styled.article<{ $grouped: boolean; $visited: boolean }>`
  padding: 17px 24px 16px;
  border-bottom: 1px solid ${colors.borderSoft};
  background: ${({ $visited }) =>
    $visited ? colors.surfaceVisited : colors.surface};
  box-shadow: ${({ $grouped }) =>
    $grouped ? `inset 3px 0 ${colors.accent}` : "none"};

  &:hover {
    background: ${({ $visited }) =>
      $visited ? "#1c1d1f" : colors.surfaceRaised};
  }

  @media (max-width: 560px) {
    padding: 15px 16px 14px;
  }
`;

// 칩을 제목 밖에 두어 제목의 접근성 이름에 작가가 섞이지 않게 한다. 긴 제목이면 칩은 다음 줄로 내려간다.
const TitleRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  margin: 0 0 9px;
`;

const ContentTitle = styled.h3<{ $visited: boolean }>`
  margin: 0;
  color: ${({ $visited }) => ($visited ? colors.textVisited : colors.text)};
  font-size: 15px;
  font-weight: ${({ $visited }) => ($visited ? 500 : 650)};
  line-height: 1.45;
`;

const ArtistChip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid ${colors.border};
  border-radius: 999px;
  background: transparent;
  color: ${colors.textMuted};
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  cursor: pointer;

  span {
    color: ${colors.disabled};
    font-size: 11px;
  }
  &:hover,
  &[aria-pressed="true"] {
    border-color: ${colors.accent};
    color: ${colors.textStrong};
  }
`;

const Star = styled.b`
  color: ${colors.accent};
  font-size: 11px;
  font-weight: 700;
`;

const TitleLink = styled.a`
  color: inherit;
  text-decoration: none;

  &:visited {
    color: ${colors.textVisited};
  }
  &:hover {
    color: ${colors.textStrong};
  }
`;

const SourceLinks = styled.div`
  display: grid;
  gap: 4px;
`;

const SourceRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  > a {
    flex: 1;
  }
`;

const SourceLink = styled.a<{ $visited: boolean }>`
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  border-radius: 6px;
  padding: 3px 5px 3px 1px;
  color: ${colors.textMuted};
  opacity: ${({ $visited }) => ($visited ? 0.58 : 1)};
  text-decoration: none;

  /* Browsers allow visited colors, but not opacity or parent/group styling. */
  &:visited {
    color: ${colors.textVisited};
  }
  &:visited > span {
    color: ${colors.textVisited};
  }

  &:hover {
    color: ${colors.textStrong};
    background: rgb(255 255 255 / 0.035);
  }
`;

const Branch = styled.span`
  width: 14px;
  flex: none;
  color: ${colors.border};
  font-size: 13px;
  text-align: right;
`;

const SourceBadge = styled.span<{ $source: Source }>`
  flex: none;
  border: 1px solid
    ${({ $source }) => ($source === "arca" ? "#4b6157" : "#555866")};
  border-radius: 5px;
  padding: 3px 6px;
  color: ${({ $source }) =>
    $source === "arca" ? colors.arcaBadgeText : colors.dcBadgeText};
  background: ${({ $source }) =>
    $source === "arca" ? colors.arcaBadge : colors.dcBadge};
  font-size: 10px;
  font-weight: 700;
`;

const PostMeta = styled.small`
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
