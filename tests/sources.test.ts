import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artistIdentity,
  PixivFormatError,
  parsePixivIllust,
  parsePixivProfileXHandle,
  xHandleFromProfileUrl,
  xHandleFromStatusUrl,
} from "../src/sources/originalArtists.ts";
import {
  extractSources,
  normalizeSourceUrl,
} from "../src/sources/extractSources.ts";

test("normalizes source links and ignores profiles", () => {
  assert.equal(
    normalizeSourceUrl(
      "https://unsafelink.com/https://www.pixiv.net/artworks/150315699",
    )?.key,
    "pixiv:150315699",
  );
  assert.equal(
    normalizeSourceUrl("https://twitter.com/author/status/12345/photo/1?s=20")
      ?.key,
    "x:12345",
  );
  assert.deepEqual(
    normalizeSourceUrl(
      "https://x.com/onionn5656/status/2102798914424570217?s=20",
    ),
    {
      key: "x:2102798914424570217",
      url: "https://x.com/onionn5656/status/2102798914424570217",
    },
  );
  assert.equal(
    normalizeSourceUrl("https://x.com/13iwak/status/2098365501156245648?s=20")
      ?.key,
    "x:2098365501156245648",
  );
  for (const url of [
    "https://x.com/author",
    "https://pixiv.net/users/12345",
    "https://x.com.evil.test/a/status/12345",
    "javascript:alert(1)",
  ]) {
    assert.equal(normalizeSourceUrl(url), null);
  }
});

test("extracts multiple unique works from links and visible text only", () => {
  const result =
    extractSources(`<a href="https://unsafelink.com/https://www.pixiv.net/artworks/150315699">출처</a>
    <p>https://www.pixiv.net/artworks/150315699</p><p>(https://x.com/author/status/12345?s=20).</p>
    <script>https://x.com/advert/status/99999</script><img src="https://x.com/advert/status/88888">
    <a href="https://x.com/author">작가</a>`);
  assert.equal(result.kind, "found");
  assert.deepEqual(
    result.sources.map((source) => source.key),
    ["pixiv:150315699", "x:12345"],
  );
  assert.deepEqual(extractSources("<p>출처 없음</p>"), {
    kind: "none",
    sources: [],
  });
});

test("reads original artists from X status links and pixiv responses", () => {
  assert.equal(xHandleFromStatusUrl("https://x.com/Kakapo_Milk/status/123"), "Kakapo_Milk");
  // `i`는 계정이 아니라 공용 경로다.
  assert.equal(xHandleFromStatusUrl("https://x.com/i/status/123"), null);
  assert.equal(xHandleFromStatusUrl("https://x.com/a/status/123/photo/1"), null);

  assert.equal(xHandleFromProfileUrl("https://twitter.com/kakapomilk"), "kakapomilk");
  assert.equal(xHandleFromProfileUrl("https://x.com/@kakapomilk/"), "kakapomilk");
  assert.equal(xHandleFromProfileUrl("https://www.twitter.com/kakapomilk?s=20"), "kakapomilk");
  assert.equal(xHandleFromProfileUrl("https://twitter.com/i/user/1"), null);
  assert.equal(xHandleFromProfileUrl("https://example.com/kakapomilk"), null);
  assert.equal(xHandleFromProfileUrl("not a url"), null);

  assert.deepEqual(
    parsePixivIllust({ error: false, body: { userId: "90987221", userName: "カカポ" } }),
    { userId: "90987221", userName: "カカポ" },
  );
  assert.throws(() => parsePixivIllust({ error: false, body: {} }), PixivFormatError);
  assert.throws(() => parsePixivIllust(null), PixivFormatError);

  assert.equal(
    parsePixivProfileXHandle({ body: { social: { twitter: { url: "https://twitter.com/kakapomilk" } } } }),
    "kakapomilk",
  );
  // 연결이 없으면 픽시브는 빈 배열을 준다.
  assert.equal(parsePixivProfileXHandle({ body: { social: [] } }), null);
  assert.throws(() => parsePixivProfileXHandle({ error: true }), PixivFormatError);
});

test("pixiv artists with a linked X account share the X artist key", () => {
  assert.deepEqual(
    artistIdentity({ platform: "x", artistId: "kakapomilk", artistName: "KakapoMilk", xHandle: null }),
    { key: "x:kakapomilk", name: "@KakapoMilk" },
  );
  assert.deepEqual(
    artistIdentity({ platform: "pixiv", artistId: "7", artistName: "カカポ", xHandle: "KakapoMilk" }),
    { key: "x:kakapomilk", name: "@KakapoMilk" },
  );
  assert.deepEqual(
    artistIdentity({ platform: "pixiv", artistId: "8", artistName: "", xHandle: null }),
    { key: "pixiv:8", name: "pixiv 8" },
  );
});
