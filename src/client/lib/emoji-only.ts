const emojiGrapheme = new RegExp(
  String.raw`^(?:\p{RGI_Emoji}|\p{Extended_Pictographic}\uFE0F?|[0-9#*]\uFE0F?\u20E3)$`,
  "v",
);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Test source text, not rendered Markdown: code and formatting stay ordinary size. */
export function isEmojiOnly(text: string): boolean {
  let hasEmoji = false;
  for (const { segment } of graphemes.segment(text)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!emojiGrapheme.test(segment)) return false;
    hasEmoji = true;
  }
  return hasEmoji;
}
