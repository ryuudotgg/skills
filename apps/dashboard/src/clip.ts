function widthOf(character: string): number {
  return (character.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
}

function widthText(text: string): number {
  return [...text].reduce((sum, character) => sum + widthOf(character), 0);
}

export function labelled(name: string, suffix: string, limit: number): string {
  return `${clipped(name, limit - widthText(suffix))}${suffix}`;
}

export function clipped(name: string, limit: number): string {
  const characters = [...name];
  if (widthText(name) <= limit) return name;

  let kept = "";
  let width = 3;
  for (const character of characters) {
    width += widthOf(character);
    if (width > limit) break;
    kept += character;
  }

  return `${kept}...`;
}
