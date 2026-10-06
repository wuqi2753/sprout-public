// REQ-059: local sorting preference; no Server requests.
import { readTagOrder } from './tag-order-rules';
const TAG_ORDER_KEY = 'sprout.tag-order';
export async function getTagOrder(): Promise<string[]> {
  return typeof window === 'undefined' ? [] : readTagOrder(window.localStorage.getItem(TAG_ORDER_KEY));
}
export async function saveTagOrder(names: string[]): Promise<void> {
  const serialized = JSON.stringify(names);
  readTagOrder(serialized);
  window.localStorage.setItem(TAG_ORDER_KEY, serialized);
}
