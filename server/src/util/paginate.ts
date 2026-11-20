/** Default and hard upper bound for list page sizes, keeping tool outputs cheap in context. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;
/** Default character budget for free-text outputs (logs, docs). */
export const DEFAULT_TEXT_BUDGET = 8000;

export interface PageRequest {
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  /** Present only when more items exist; pass it as `offset` to get the next page. */
  nextOffset?: number;
}

/** Slices `items` into a page, clamping offset/limit into valid ranges. */
export function paginate<T>(items: readonly T[], request: PageRequest = {}): Page<T> {
  const limit = clamp(request.limit ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = clamp(request.offset ?? 0, 0, items.length);
  const end = offset + limit;
  const page: Page<T> = { items: items.slice(offset, end), total: items.length, offset };
  if (end < items.length) {
    page.nextOffset = end;
  }
  return page;
}

/**
 * Truncates text to `budget` characters, cutting at a line boundary when possible and appending a
 * note that tells the agent how to get the rest.
 */
export function truncateText(text: string, budget: number, howToGetMore: string): string {
  if (text.length <= budget) {
    return text;
  }
  const cut = text.lastIndexOf('\n', budget);
  const end = cut > 0 ? cut : budget;
  const omitted = text.length - end;
  return `${text.slice(0, end)}\n… [truncated ${omitted} chars; ${howToGetMore}]`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
