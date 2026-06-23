import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";

/**
 * Watches plan files for live edits. Watches the parent directory and filters by
 * basename so atomic saves (write-temp-then-rename, as most editors do) are caught.
 * Debounced; reads the file and hands content to `onChange`, which hash-gates.
 */
export class FileWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly onChange: (abspath: string, content: string) => void,
    private readonly debounceMs = 150,
  ) {}

  watch(path: string): void {
    const abspath = resolvePath(path);
    if (this.watchers.has(abspath)) return;
    const base = basename(abspath);
    const w = watch(dirname(abspath), (_event, filename) => {
      if (filename && basename(filename) !== base) return;
      this.schedule(abspath);
    });
    this.watchers.set(abspath, w);
  }

  private schedule(abspath: string): void {
    const existing = this.timers.get(abspath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      abspath,
      setTimeout(async () => {
        this.timers.delete(abspath);
        try {
          const content = await Bun.file(abspath).text();
          this.onChange(abspath, content);
        } catch {
          // file may be mid-write or transiently missing during an atomic save
        }
      }, this.debounceMs),
    );
  }

  close(): void {
    for (const w of this.watchers.values()) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.watchers.clear();
    this.timers.clear();
  }
}
