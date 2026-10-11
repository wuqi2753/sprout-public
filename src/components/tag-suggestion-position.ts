// REQ-054: keep a caret-adjacent list inside the visible editor, above its toolbar.
export function positionTagSuggestions({ caretX, lineTop, lineBottom, width, height, count, forceAbove = false }: {
  caretX: number; lineTop: number; lineBottom: number; width: number; height: number; count: number; forceAbove?: boolean;
}) {
  const gap = 8;
  if (!count || width <= gap * 2 || lineBottom < 0 || lineTop > height) return undefined;
  const popupWidth = forceAbove ? width - gap * 2 : Math.min(220, width - gap * 2);
  const desiredHeight = Math.min(240, count * 48);
  const below = Math.max(0, height - lineBottom - gap * 2);
  const above = Math.max(0, lineTop - gap * 2);
  const placeBelow = !forceAbove && (below >= desiredHeight || below >= above);
  const popupHeight = Math.min(desiredHeight, placeBelow ? below : above);
  if (popupHeight < 48) return undefined;
  return {
    left: forceAbove ? gap : Math.max(gap, Math.min(caretX, width - popupWidth - gap)),
    top: placeBelow ? lineBottom + gap : lineTop - gap - popupHeight,
    width: popupWidth,
    height: popupHeight,
  };
}
