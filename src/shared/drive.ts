/**
 * The few Google Drive v3 calls the sync needs. The `drive.file` scope only
 * shows files this app created, so files are found by their appProperties
 * (stvSync = root | device | ops | export | backup), never by name. Versions are
 * dulieu.txt's own revisions, kept forever.
 */

export const DRIVE_BASE = "https://www.googleapis.com";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,md5Checksum,modifiedTime,createdTime,trashed,appProperties";

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  createdTime?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

/** One version of a file's content. Only revisions kept forever can be downloaded. */
export interface Revision {
  id: string;
  modifiedTime?: string;
  keepForever?: boolean;
  md5Checksum?: string;
  size?: string;
  originalFilename?: string;
}
const REVISION_FIELDS = "id,modifiedTime,keepForever,md5Checksum,size,originalFilename";

/** A Drive query string literal: 'it\'s'. */
export const quote = (s: string) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export interface FileMeta {
  name: string;
  mimeType?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  /** Recorded on the revision the upload creates (Drive's "Manage versions" shows it). */
  originalFilename?: string;
}

export interface UploadOptions {
  /** Keep the revision this upload creates (otherwise Drive drops it 30 days after a newer one). */
  keepForever?: boolean;
}

export class DriveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Returns an access token; `stale` is the one Drive just rejected, so a fresh one is needed. */
export type TokenSource = (stale?: string) => Promise<string>;

export class Drive {
  constructor(
    private readonly token: TokenSource,
    private readonly base = DRIVE_BASE,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    let token = await this.token();
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const res = await fetch(this.base + path, { ...init, headers });
      if (res.ok) return res;
      if (res.status === 401 && attempt === 0) {
        token = await this.token(token);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {}
      throw new DriveError(res.status, `Google Drive: ${message}`);
    }
  }

  async list(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken = "";
    do {
      const p = new URLSearchParams({ q, spaces: "drive", pageSize: "1000", fields: `nextPageToken,files(${FIELDS})` });
      if (pageToken) p.set("pageToken", pageToken);
      const body = (await (await this.call(`/drive/v3/files?${p}`)).json()) as { files: DriveFile[]; nextPageToken?: string };
      out.push(...body.files);
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  /** Files tagged stvSync=<kind>, oldest first. */
  async byKind(kind: string): Promise<DriveFile[]> {
    const files = await this.list(`appProperties has { key='stvSync' and value='${kind}' } and trashed=false`);
    return files.sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));
  }

  async download(id: string): Promise<string> {
    return (await this.call(`/drive/v3/files/${encodeURIComponent(id)}?alt=media`)).text();
  }

  /** The file's metadata, trashed or not; throws DriveError 404 once it is deleted for good. */
  async get(id: string): Promise<DriveFile> {
    return (await this.call(`/drive/v3/files/${encodeURIComponent(id)}?fields=${FIELDS}`)).json() as Promise<DriveFile>;
  }

  /** Deletes for good (no trash). */
  async remove(id: string): Promise<void> {
    await this.call(`/drive/v3/files/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Changes metadata only: `appProperties` are merged into the file's; `trashed: true` moves it to the trash. */
  async patch(id: string, meta: { appProperties?: Record<string, string>; trashed?: boolean }): Promise<DriveFile> {
    const res = await this.call(`/drive/v3/files/${encodeURIComponent(id)}?fields=${FIELDS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(meta),
    });
    return res.json() as Promise<DriveFile>;
  }

  async createFolder(meta: FileMeta): Promise<DriveFile> {
    const res = await this.call(`/drive/v3/files?fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ ...meta, mimeType: FOLDER_MIME }),
    });
    return res.json() as Promise<DriveFile>;
  }

  private async multipart(method: string, path: string, meta: object, content: string, contentType: string, opts: UploadOptions = {}): Promise<DriveFile> {
    const boundary = `stv${crypto.randomUUID().replaceAll("-", "")}`;
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n--${boundary}--`;
    const keep = opts.keepForever ? "&keepRevisionForever=true" : "";
    const res = await this.call(`${path}?uploadType=multipart&fields=${FIELDS}${keep}`, {
      method,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json() as Promise<DriveFile>;
  }

  create(meta: FileMeta, content: string, contentType: string, opts?: UploadOptions): Promise<DriveFile> {
    return this.multipart("POST", "/upload/drive/v3/files", meta, content, contentType, opts);
  }

  /** Replaces the content; `meta.appProperties` (if given) are merged into the file's. */
  update(id: string, content: string, contentType: string, meta: Partial<FileMeta> = {}, opts?: UploadOptions): Promise<DriveFile> {
    const { parents: _p, ...rest } = meta;
    return this.multipart("PATCH", `/upload/drive/v3/files/${encodeURIComponent(id)}`, rest, content, contentType, opts);
  }

  /** The file's revisions, oldest first; the last one is the current content. */
  async revisions(fileId: string): Promise<Revision[]> {
    const out: Revision[] = [];
    let pageToken = "";
    do {
      const p = new URLSearchParams({ pageSize: "1000", fields: `nextPageToken,revisions(${REVISION_FIELDS})` });
      if (pageToken) p.set("pageToken", pageToken);
      const body = (await (await this.call(`/drive/v3/files/${encodeURIComponent(fileId)}/revisions?${p}`)).json()) as { revisions?: Revision[]; nextPageToken?: string };
      out.push(...(body.revisions ?? []));
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  async downloadRevision(fileId: string, revisionId: string): Promise<string> {
    return (await this.call(`/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?alt=media`)).text();
  }

  /** Marks a revision to be kept forever (at most 200 per file), or temporary again. */
  async keepRevision(fileId: string, revisionId: string, keepForever: boolean): Promise<void> {
    await this.call(`/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?fields=id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ keepForever }),
    });
  }

  /** Deletes a revision for good; Drive refuses the current one. */
  async removeRevision(fileId: string, revisionId: string): Promise<void> {
    await this.call(`/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`, { method: "DELETE" });
  }
}