import {
  enShard,
  entryShard,
  jaShard,
  kanjiShard,
  shardName,
} from '../shared/hash.ts';
import type {
  EnIndexShard,
  Entry,
  EntryShard,
  JaIndexShard,
  KanjiInfo,
  KanjiShard,
  Meta,
  RadicalData,
} from '../shared/types.ts';

/** Loads a data file by its path relative to the data directory. */
export type JsonLoader = (path: string) => Promise<unknown>;

/** A match from the Japanese index. */
export interface JaHit {
  id: number;
  /** the matched form is marked common */
  common: boolean;
}

/**
 * Access to the sharded dictionary data. Every file is fetched at most once;
 * the promise is cached so concurrent lookups share one request.
 */
export class Dict {
  readonly meta: Meta;
  private readonly load: JsonLoader;
  private readonly cache = new Map<string, Promise<unknown>>();

  private constructor(meta: Meta, load: JsonLoader) {
    this.meta = meta;
    this.load = load;
  }

  static async open(load: JsonLoader): Promise<Dict> {
    const meta = (await load('meta.json')) as Meta;
    return new Dict(meta, load);
  }

  private file<T>(path: string): Promise<T> {
    let p = this.cache.get(path);
    if (!p) {
      p = this.load(path);
      // Don't cache failures, so a flaky network doesn't break a shard forever.
      p.catch(() => this.cache.delete(path));
      this.cache.set(path, p);
    }
    return p as Promise<T>;
  }

  jaShardFor(key: string): Promise<JaIndexShard> {
    return this.file(`ja/${shardName(jaShard(key, this.meta.shards.ja))}.json`);
  }

  /** Entries for a normalized key, best first. */
  async lookupJa(key: string): Promise<JaHit[]> {
    const shard = await this.jaShardFor(key);
    return toHits(shard[key]);
  }

  /** True if the normalized key is in the dictionary. */
  async hasJa(key: string): Promise<boolean> {
    return (await this.jaShardFor(key))[key] !== undefined;
  }

  /**
   * Keys that start with `prefix` (not including `prefix` itself).
   * Only works for prefixes of two or more characters, since shards are
   * bucketed by the first two characters.
   */
  async jaKeysWithPrefix(prefix: string): Promise<[string, JaHit[]][]> {
    if (Array.from(prefix).length < 2) return [];
    const shard = await this.jaShardFor(prefix);
    const out: [string, JaHit[]][] = [];
    for (const [key, ids] of Object.entries(shard)) {
      if (key !== prefix && key.startsWith(prefix)) {
        out.push([key, toHits(ids)]);
      }
    }
    return out;
  }

  async lookupEn(word: string): Promise<[number, number][]> {
    const shard = await this.file<EnIndexShard>(
      `en/${shardName(enShard(word, this.meta.shards.en))}.json`,
    );
    return shard[word] ?? [];
  }

  async entry(id: number): Promise<Entry | undefined> {
    const shard = await this.file<EntryShard>(
      `ent/${shardName(entryShard(id, this.meta.shards.entries))}.json`,
    );
    return shard[id];
  }

  /** Entries for the ids, in the same order, skipping any that are missing. */
  async entries(ids: number[]): Promise<Entry[]> {
    const entries = await Promise.all(ids.map(id => this.entry(id)));
    return entries.filter((e): e is Entry => e !== undefined);
  }

  async kanji(ch: string): Promise<KanjiInfo | undefined> {
    const shard = await this.file<KanjiShard>(
      `kanji/${shardName(kanjiShard(ch, this.meta.shards.kanji))}.json`,
    );
    return shard[ch];
  }

  radicals(): Promise<RadicalData> {
    return this.file('radk.json');
  }

  tagDescription(tag: string): string {
    return this.meta.tags[tag] ?? tag;
  }
}

function toHits(ids: number[] | undefined): JaHit[] {
  return (ids ?? []).map(id => ({id: Math.abs(id), common: id < 0}));
}
