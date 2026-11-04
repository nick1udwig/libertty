/** FIFO with amortized constant-time removal and prompt release of consumed values. */
export class Queue<T> implements Iterable<T> {
  private items: (T | undefined)[];
  private head = 0;
  constructor(values: Iterable<T> = []) {
    this.items = [...values];
  }
  get length() {
    return this.items.length - this.head;
  }
  peek(): T | undefined {
    return this.items[this.head];
  }
  push(value: T) {
    this.items.push(value);
  }
  shift(): T | undefined {
    if (!this.length) return undefined;
    const value = this.items[this.head];
    this.items[this.head++] = undefined;
    if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    if (!this.length) this.clear();
    return value;
  }
  clear() {
    this.items = [];
    this.head = 0;
  }
  *[Symbol.iterator](): Iterator<T> {
    for (let i = this.head; i < this.items.length; i++) yield this.items[i]!;
  }
}
