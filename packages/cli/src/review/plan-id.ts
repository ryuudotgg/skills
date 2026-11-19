export const webUrl = /https?:\/\/\S+/gu;

const word = "[\\p{L}\\p{N}_]";
const planIdPattern = new RegExp(
  `(?<!${word})plan\\s*#?\\s*\\p{Nd}+(?!${word})|(?<!${word})plans\\s*#?\\s*\\p{Nd}+\\s*(?:,|and|or)\\s*#?\\s*\\p{Nd}+(?!${word})`,
  "iu",
);

export function planId(text: string): string | undefined {
  return planIdPattern.exec(text.replace(webUrl, ""))?.[0];
}
