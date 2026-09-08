/**
 * Append-only JSONL event log. This is the plugin's only source of truth;
 * everything else is a derived view rebuilt from it.
 *
 * The log is irreplaceable memory, so it lives as plain files in the plugin
 * folder (they sync with the vault), sharded per device and month:
 * log/{deviceId}-{YYYY-MM}.jsonl. Per-device shards mean append-only writers
 * on different machines never conflict; merging is a sort by timestamp.
 */
import type { DataAdapter } from "obsidian";
import type { LogEvent } from "./recorder";

const DEVICE_KEY = "contexts-device-id";

/** Stable per-device id. localStorage is per-device and does not sync, which is exactly what we want. */
export function getDeviceId(): string {
  try {
    let id = window.localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 8);
      window.localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "device";
  }
}

export class EventLog {
  private dirReady: Promise<void> | null = null;

  constructor(
    private adapter: DataAdapter,
    private dir: string,
    private deviceId: string
  ) {}

  private shardPath(t: number): string {
    const d = new Date(t);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return `${this.dir}/${this.deviceId}-${month}.jsonl`;
  }

  private ensureDir(): Promise<void> {
    if (!this.dirReady) {
      this.dirReady = (async () => {
        if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
      })();
    }
    return this.dirReady;
  }

  async append(ev: LogEvent): Promise<void> {
    await this.ensureDir();
    await this.adapter.append(this.shardPath(ev.t), JSON.stringify(ev) + "\n");
  }

  /** All events across every shard (any device), oldest first. */
  async readAll(): Promise<LogEvent[]> {
    if (!(await this.adapter.exists(this.dir))) return [];
    const { files } = await this.adapter.list(this.dir);
    const events: LogEvent[] = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const text = await this.adapter.read(f);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // ponytail: skip corrupt/truncated lines (crash mid-append) rather than fail the read
        }
      }
    }
    events.sort((a, b) => a.t - b.t);
    return events;
  }
}
