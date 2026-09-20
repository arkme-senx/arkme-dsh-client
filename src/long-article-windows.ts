export interface LongArticleTarget {
  accountKey: string;
  sourceKey: string;
  sourceRef: string;
  displayName: string;
  article?: { mode: "existing" | "snapshot"; item: { itemUid: string; [key: string]: unknown } };
}
export interface ArticleWindow {
  id: number;
  show(): void;
  focus(): void;
  restore(): void;
  isMinimized(): boolean;
  close(): void;
  load(): Promise<void>;
  send(event: string, value?: unknown): void;
  on(event: "close", listener: (event: { preventDefault(): void }) => void): void;
  on(event: "closed", listener: () => void): void;
}
interface Entry {
  target: LongArticleTarget;
  scope: string;
  window: ArticleWindow;
  invalidated: boolean;
  closing: boolean;
  published: boolean;
  ready: boolean;
}
export class LongArticleWindows {
  private entries = new Map<number, Entry>();
  private account: string | null = null;
  private quit: (() => void) | undefined;
  constructor(private readonly ports: {
    scope(): string;
    create(target: LongArticleTarget): ArticleWindow;
    notify(value: LongArticleTarget & { item: unknown }): void;
  }) {}
  get size(): number { return this.entries.size; }
  setAccount(account: string | null): void {
    this.account = account;
    for (const entry of this.entries.values()) {
      if (entry.target.accountKey !== account && !entry.invalidated) {
        entry.invalidated = true;
        entry.window.send("invalidated", undefined);
      }
    }
  }
  async open(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") throw new Error("Invalid article target");
    const raw = value as Record<string, unknown>;
    for (const key of ["accountKey", "sourceKey", "sourceRef", "displayName"]) {
      if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 16384) throw new Error("Invalid article target");
    }
    if (raw.accountKey !== this.account) throw new Error("Article account changed");
    const target: LongArticleTarget = { accountKey: raw.accountKey as string, sourceKey: raw.sourceKey as string,
      sourceRef: raw.sourceRef as string, displayName: raw.displayName as string };
    if (raw.article !== undefined) {
      const article = raw.article as NonNullable<LongArticleTarget["article"]>;
      if (!article || !["existing", "snapshot"].includes(article.mode) || !article.item || typeof article.item.itemUid !== "string" || !article.item.itemUid.trim() || JSON.stringify(article).length > 2_000_000) throw new Error("Invalid article context");
      target.article = structuredClone(article);
    }
    for (const entry of this.entries.values()) {
      if (entry.target.article?.mode === target.article?.mode && entry.target.article?.item.itemUid === target.article?.item.itemUid && this.isActive(entry.window.id) && entry.target.sourceKey === target.sourceKey) {
        if (entry.window.isMinimized()) entry.window.restore();
        entry.window.show(); entry.window.focus(); return;
      }
    }
    const window = this.ports.create(target);
    const entry: Entry = { target, scope: this.ports.scope(), window, invalidated: false, closing: false, published: false, ready: false };
    this.entries.set(window.id, entry);
    window.on("close", event => {
      if (entry.closing || !entry.ready) return;
      event.preventDefault(); window.send("request-close", undefined);
    });
    window.on("closed", () => {
      this.entries.delete(window.id);
      if (!this.entries.size && this.quit) { const quit = this.quit; this.quit = undefined; quit(); }
    });
    try { await window.load(); window.show(); }
    catch (error) { this.cancelClose(); this.finishClose(window.id); throw error; }
  }
  ready(id: number): void { const entry = this.entries.get(id); if (entry) entry.ready = true; }
  context(id: number): LongArticleTarget | undefined { return this.entries.get(id)?.target; }
  isActive(id: number): boolean {
    const entry = this.entries.get(id);
    return !!entry && !entry.invalidated && entry.scope === this.ports.scope() && entry.target.accountKey === this.account;
  }
  created(id: number, item: unknown): boolean {
    const entry = this.entries.get(id);
    if (!entry || !this.isActive(id) || entry.published || !item || typeof item !== "object"
      || typeof (item as { itemUid?: unknown }).itemUid !== "string") return false;
    if (entry.target.article && (entry.target.article.mode === "snapshot" || (item as { itemUid: string }).itemUid !== entry.target.article.item.itemUid)) return false;
    entry.published = true;
    this.ports.notify({ ...entry.target, item }); return true;
  }
  finishClose(id: number): void {
    const entry = this.entries.get(id);
    if (entry) { entry.closing = true; entry.window.close(); }
  }
  cancelClose(): void { this.quit = undefined; }
  requestQuit(quit: () => void): boolean {
    if (!this.entries.size) return false;
    if (this.quit) return true;
    this.quit = quit;
    for (const entry of this.entries.values()) { entry.window.show(); if (entry.ready) entry.window.send("request-close", undefined); else entry.window.close(); }
    return true;
  }
}
