/**
 * 本地持久化。
 * failNextWrites(n) 让接下来 n 次写盘抛错，用于模拟“写盘失败后按预占编号重试”：
 * 调用方捕获写盘失败后，用同一个 holdNo 重放 claim/confirm，账本保证不重复占号、不重复占名额。
 */
let pendingFailures = 0;

export function failNextWrites(count = 1) {
  pendingFailures += count;
}

export function writeFailureQueued() {
  return pendingFailures;
}

export function readLocal<T>(key: string, fallback: T): T {
  if (!import.meta.client) return fallback;
  const raw = localStorage.getItem(key);
  return raw ? (JSON.parse(raw) as T) : fallback;
}

export function writeLocal<T>(key: string, value: T) {
  if (!import.meta.client) return;
  if (pendingFailures > 0) {
    pendingFailures -= 1;
    throw new Error('模拟写盘失败（存储暂不可用）');
  }
  localStorage.setItem(key, JSON.stringify(value));
}
