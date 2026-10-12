/**
 * In-memory stand-in for the Drive v3 endpoints src/shared/drive.ts uses:
 * list (appProperties filters only), download, get, metadata patch (rename,
 * trash), folder create, multipart create, media update, copy, delete. Every account sees the
 * same files; tokens are not checked beyond being present. CORS is open so an extension service worker can call it.
 *
 *   bun run test/fake-drive.ts [port] [--file state.json]   # standalone, for browser probes
 *
 * Standalone extras: GET /__files (every file with its content), POST /__reset.
 * With --file, files survive restarts, so probe steps run as separate processes can share them.
 */
import type { DriveFile } from "../src/shared/drive";

interface Stored extends DriveFile {
  content: string;
  trashed: boolean;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

export class FakeDrive {
  readonly files = new Map<string, Stored>();
  readonly log: string[] = [];
  private seq = 0;
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private readonly file?: string) {}

  async load(): Promise<this> {
    if (this.file && (await Bun.file(this.file).exists())) {
      const saved = (await Bun.file(this.file).json()) as { seq: number; files: Stored[] };
      this.seq = saved.seq;
      for (const f of saved.files) this.files.set(f.id, f);
    }
    return this;
  }

  private async save(): Promise<void> {
    if (this.file) await Bun.write(this.file, JSON.stringify({ seq: this.seq, files: [...this.files.values()] }));
  }

  get url(): string {
    return `http://127.0.0.1:${this.server!.port}`;
  }

  start(port = 0): this {
    this.server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const res = await this.handle(req);
        if (req.method !== "GET" && req.method !== "OPTIONS") await this.save();
        return res;
      },
    });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
  }

  byKind(kind: string): Stored[] {
    return [...this.files.values()].filter((f) => f.appProperties?.stvSync === kind && !f.trashed);
  }

  private stamp(f: Stored): void {
    f.modifiedTime = new Date(Date.now() + this.seq).toISOString();
    f.md5Checksum = String(Bun.hash(f.content));
  }

  private add(meta: Partial<DriveFile>, content: string): Stored {
    const id = `f${++this.seq}`;
    const f: Stored = {
      id,
      name: meta.name ?? "untitled",
      mimeType: meta.mimeType,
      appProperties: meta.appProperties,
      createdTime: new Date(Date.now() + this.seq).toISOString(),
      content,
      trashed: false,
    };
    this.stamp(f);
    this.files.set(id, f);
    return f;
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  private meta(f: Stored): DriveFile {
    const { content: _c, trashed: _t, ...m } = f;
    return m;
  }

  async handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    this.log.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/__files") return this.json([...this.files.values()]);
    if (url.pathname === "/__reset" && req.method === "POST") {
      this.files.clear();
      return this.json({ ok: true });
    }
    if (!req.headers.get("Authorization")?.startsWith("Bearer ")) return this.json({ error: { message: "no token" } }, 401);
    const m = /^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?(\/copy)?$/.exec(url.pathname);
    if (!m) return this.json({ error: { message: "not found" } }, 404);
    const [, upload, id, copy] = m;

    if (req.method === "GET" && !id) {
      const q = url.searchParams.get("q") ?? "";
      const kinds = [...q.matchAll(/key='stvSync' and value='(\w+)'/g)].map((x) => x[1]);
      const device = /key='device' and value='([^']*)'/.exec(q)?.[1];
      const files = [...this.files.values()].filter(
        (f) =>
          !f.trashed &&
          (kinds.length === 0 || kinds.includes(f.appProperties?.stvSync ?? "")) &&
          (device === undefined || f.appProperties?.device === device),
      );
      return this.json({ files: files.map((f) => this.meta(f)) });
    }
    const f = id ? this.files.get(id) : undefined;
    if (id && !f) return this.json({ error: { message: "File not found" } }, 404);
    if (req.method === "GET" && f && url.searchParams.get("alt") !== "media") return this.json({ ...this.meta(f), trashed: f.trashed });
    if (req.method === "GET" && f) {
      return new Response(f.content, { headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (req.method === "POST" && copy && f) {
      const meta = (await req.json()) as DriveFile;
      return this.json(this.meta(this.add({ ...meta, appProperties: { ...f.appProperties, ...meta.appProperties } }, f.content)));
    }
    if (req.method === "DELETE" && f) {
      this.files.delete(f.id);
      return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method === "PATCH" && !upload && f) {
      const meta = (await req.json()) as DriveFile;
      if (meta.appProperties) f.appProperties = { ...f.appProperties, ...meta.appProperties };
      if (meta.trashed !== undefined) f.trashed = meta.trashed;
      return this.json({ ...this.meta(f), trashed: f.trashed });
    }
    if (req.method === "POST" && !upload) return this.json(this.meta(this.add((await req.json()) as DriveFile, "")));
    if (upload && (req.method === "POST" || (req.method === "PATCH" && f))) {
      if (url.searchParams.get("uploadType") !== "multipart") return this.json({ error: { message: "expected multipart" } }, 400);
      const boundary = /boundary=(.+)$/.exec(req.headers.get("Content-Type") ?? "")?.[1];
      const parts = (await req.text()).split(`--${boundary}`);
      const body = (p: string) => p.slice(p.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
      const meta = JSON.parse(body(parts[1]!)) as DriveFile;
      if (!f) return this.json(this.meta(this.add(meta, body(parts[2]!))));
      f.content = body(parts[2]!);
      if (meta.appProperties) f.appProperties = { ...f.appProperties, ...meta.appProperties };
      this.stamp(f);
      return this.json(this.meta(f));
    }
    return this.json({ error: { message: "unsupported" } }, 400);
  }
}

if (import.meta.main) {
  const file = process.argv.includes("--file") ? process.argv[process.argv.indexOf("--file") + 1] : undefined;
  const d = (await new FakeDrive(file).load()).start(Number(process.argv[2] ?? 0));
  console.log(d.url);
}
