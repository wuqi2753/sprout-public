// REQ-071: bounds for the contained image, measured in screen points.
export function clampImageScale(scale: number) {
  'worklet';
  return Math.max(1, Math.min(4, scale));
}

export function clampImageOffset(offset: number, imageSize: number, viewportSize: number, scale: number) {
  'worklet';
  const limit = Math.max(0, (imageSize * scale - viewportSize) / 2);
  return Math.max(-limit, Math.min(limit, offset));
}
