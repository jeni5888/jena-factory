import { statSync, readFileSync } from "fs";

interface CacheEntry {
  mtime: number;
  data: unknown;
}

export class Cache {
  private store = new Map<string, CacheEntry>();

  get<T>(path: string): T | null {
    const entry = this.store.get(path);
    if (!entry) return null;

    try {
      const currentMtime = statSync(path).mtimeMs;
      if (currentMtime === entry.mtime) return entry.data as T;
      // Stale — remove
      this.store.delete(path);
    } catch {
      this.store.delete(path);
    }
    return null;
  }

  set(path: string, data: unknown, mtime?: number): void {
    const mt = mtime ?? statSync(path).mtimeMs;
    this.store.set(path, { mtime: mt, data });
  }

  getJson<T>(path: string): T | null {
    const cached = this.get<T>(path);
    if (cached) return cached;

    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      this.set(path, data);
      return data as T;
    } catch {
      return null;
    }
  }

  get size(): number {
    return this.store.size;
  }
}
