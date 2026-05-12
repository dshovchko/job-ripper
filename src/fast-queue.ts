/**
 * Internal singly-linked list node used by {@link FastQueue}.
 *
 * @typeParam T - The type of value stored in the node.
 */
interface Node<T> {
  /** The stored value. */
  value: T;
  /** Pointer to the next node, or `null` if this is the tail. */
  next: Node<T> | null;
}

/**
 * A lightweight FIFO queue backed by a singly-linked list.
 *
 * Provides O(1) `enqueue` and `dequeue` operations without the
 * overhead of array shifting, making it well-suited for
 * high-throughput task scheduling in the thread pool.
 *
 * @typeParam T - The type of elements held in the queue.
 */
export class FastQueue<T> {
  private head: Node<T> | null = null;
  private tail: Node<T> | null = null;
  private _size = 0;

  /** The number of elements currently in the queue. */
  get size(): number {
    return this._size;
  }

  /**
   * Appends a value to the back of the queue.
   *
   * @param value - The value to enqueue.
   */
  enqueue(value: T): void {
    const node: Node<T> = {value, next: null};
    if (this.tail) {
      this.tail.next = node;
      this.tail = node;
    } else {
      this.head = node;
      this.tail = node;
    }
    this._size++;
  }

  /**
   * Removes and returns the value at the front of the queue.
   *
   * @returns The front value, or `undefined` if the queue is empty.
   */
  dequeue(): T | undefined {
    if (!this.head) return undefined;

    const value = this.head.value;
    this.head = this.head.next;
    if (!this.head) {
      this.tail = null;
    }
    this._size--;
    return value;
  }
}
