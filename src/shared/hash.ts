/**
 * 32-bit FNV-1a over UTF-16 code units. Used by both the data builder and the
 * client to decide which shard file a key lives in, so it must never change
 * without rebuilding the data.
 */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The part of a Japanese index key that picks its shard: its first two characters. */
export function jaBucket(key: string): string {
  return Array.from(key).slice(0, 2).join('');
}

export function jaShard(key: string, shards: number): number {
  return fnv1a(jaBucket(key)) % shards;
}

export function enShard(word: string, shards: number): number {
  return fnv1a(word) % shards;
}

export function entryShard(id: number, shards: number): number {
  return id % shards;
}

export function kanjiShard(kanji: string, shards: number): number {
  return kanji.codePointAt(0)! % shards;
}

/** Shard file name, zero padded so directory listings sort. */
export function shardName(n: number): string {
  return String(n).padStart(4, '0');
}
