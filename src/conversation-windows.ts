export interface ConversationTarget {
  accountKey: string;
  sourceKey: string;
  source: { kind: 'private_chat' | 'group_chat' | 'send_to_self'; sourceRef: string; displayName: string; sourceKey?: string; [key: string]: unknown };
}
export type ConversationEvent = {kind: 'article'; key: string; value: unknown} | {kind: 'call'; source: ConversationTarget['source']; mediaType: 'audio' | 'video'} | { kind: 'draft'; key: string; value: unknown } | { kind: 'changed' } | { kind: 'activate'; source: ConversationTarget['source'] } | { kind: 'busy'; key: string; value: boolean };
export interface ConversationWindow {
  id: number; show(): void; focus(): void; restore(): void; isMinimized(): boolean;
  close(): void; destroy?(): void; load(): Promise<void>; send(event: string, value?: unknown): void;
  on(event: 'closed', listener: () => void): void;
}
export class ConversationWindows {
  private entries = new Map<number, { target: ConversationTarget; scope: string; window: ConversationWindow }>();
  private account: string | null = null;
  private accountScope = "";
  private closing = new Set<number>();
  matchesAccount(account: unknown): boolean { return account === this.account && account !== null && this.accountScope === this.ports.scope(); }
  private drafts = new Map<string, ConversationEvent>();
  private locks = new Map<string, {sender: number; token: string}>();
  private submissions = new Map<string, {sender: number; key: string}>();
  constructor(private readonly ports: { scope(): string; create(target: ConversationTarget): ConversationWindow; notify(event: ConversationEvent): void }) {}
  get size() { return this.entries.size; }
  setAccount(account: string | null): void {
    if (account === this.account && this.accountScope === this.ports.scope()) return;
    this.account = account; this.accountScope = this.ports.scope(); this.closeAll(); this.drafts.clear(); this.locks.clear();
  }
  validateTarget(value: unknown): ConversationTarget {
    const raw = value as ConversationTarget | null;
    if (!raw || typeof raw !== 'object' || !raw.source || !['private_chat', 'group_chat', 'send_to_self'].includes(raw.source.kind)
      || [raw.accountKey, raw.sourceKey, raw.source.sourceRef, raw.source.displayName].some(v => typeof v !== 'string' || !v.trim() || v.length > 16384)
      || JSON.stringify(raw).length > 100000 || !this.matchesAccount(raw.accountKey)) throw new Error('Invalid conversation target');
    const identity = raw.source.kind === 'send_to_self' ? raw.source.sourceRef : raw.source.sourceKey?.trim() || raw.source.sourceRef;
    if (identity !== raw.sourceKey) throw new Error('Conversation identity mismatch');
    return structuredClone(raw);
  }
  async open(value: unknown): Promise<void> {
    const raw = this.validateTarget(value);
    for (const entry of this.entries.values()) {
      if (this.isActive(entry.window.id) && entry.target.sourceKey === raw.sourceKey) {
        if (entry.window.isMinimized()) entry.window.restore(); entry.window.show(); entry.window.focus(); return;
      }
    }
    const target = structuredClone(raw);
    const window = this.ports.create(target);
    this.entries.set(window.id, {target, scope: this.ports.scope(), window});
    window.on('closed', () => {
      this.entries.delete(window.id);
      for (const [token, item] of this.submissions) if (item.sender === window.id) this.release(item.sender, item.key, token);
    });
    try { await window.load(); if (this.isActive(window.id)) { window.show(); window.focus(); } }
    catch (error) { window.close(); throw error; }
  }
  context(id: number): ConversationTarget | undefined { return this.isActive(id) ? this.entries.get(id)?.target : undefined; }
  isActive(id: number): boolean {
    const entry = this.entries.get(id);
    return !!entry && entry.target.accountKey === this.account && entry.scope === this.ports.scope();
  }
  closeAll(): void { this.closing.clear(); for (const entry of [...this.entries.values()]) { if (entry.window.destroy) entry.window.destroy(); else entry.window.close(); } this.entries.clear(); this.locks.clear(); this.submissions.clear(); }
  deferClose(id: number): boolean {
    if (![...this.submissions.values()].some(item => item.sender === id)) return false;
    this.closing.add(id); return true;
  }
  close(id: number): void { if (!this.deferClose(id)) this.entries.get(id)?.window.close(); }
  snapshot(): ConversationEvent[] { return [...this.drafts.values(), ...[...this.locks.keys()].map(key => ({kind: 'busy' as const, key, value: true}))]; }
  publish(sender: number, event: ConversationEvent): void {
    if (sender > 0 && !this.isActive(sender)) return;
    if (event.kind === 'draft' || event.kind === 'article') this.drafts.set(event.key, event);
    const scoped = {...event, accountKey: this.account ?? undefined};
    if (sender !== 0) this.ports.notify(scoped);
    for (const entry of this.entries.values()) if (entry.window.id !== sender && this.isActive(entry.window.id)) entry.window.send('event', scoped);
  }
  acquire(sender: number, key: string, token = key): boolean {
    if ((sender !== 0 && !this.isActive(sender)) || this.locks.has(key) || this.submissions.has(token)) return false;
    this.locks.set(key, {sender, token}); this.submissions.set(token, {sender, key});
    this.publish(-1, {kind: 'busy', key, value: true}); return true;
  }
  consumed(sender: number, key: string, token = key): void {
    const lock = this.locks.get(key);
    if (lock?.sender !== sender || lock.token !== token) return;
    this.locks.delete(key); this.publish(-1, {kind: 'busy', key, value: false});
  }
  release(sender: number, key: string, token = key): void {
    const submission = this.submissions.get(token);
    if (submission?.sender !== sender || submission.key !== key) return;
    this.consumed(sender, key, token); this.submissions.delete(token);
    if (this.closing.has(sender) && ![...this.submissions.values()].some(item => item.sender === sender)) {
      this.closing.delete(sender); this.entries.get(sender)?.window.close();
    }
  }
}
