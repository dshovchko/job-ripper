import {describe, it, expect} from 'vitest';
import {FastQueue} from '../src/fast-queue.js';

describe('FastQueue', () => {
  it('should initialize empty', () => {
    const q = new FastQueue<number>();
    expect(q.size).toBe(0);
    expect(q.dequeue()).toBeUndefined();
  });

  it('should enqueue and dequeue items in FIFO order', () => {
    const q = new FastQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);

    expect(q.size).toBe(3);

    expect(q.dequeue()).toBe(1);
    expect(q.size).toBe(2);

    expect(q.dequeue()).toBe(2);
    expect(q.size).toBe(1);

    expect(q.dequeue()).toBe(3);
    expect(q.size).toBe(0);
  });

  it('should handle dequeueing from an empty queue properly', () => {
    const q = new FastQueue<string>();

    q.enqueue('a');
    expect(q.dequeue()).toBe('a');
    expect(q.size).toBe(0);

    // Extraneous dequeues
    expect(q.dequeue()).toBeUndefined();
    expect(q.size).toBe(0);

    // Make sure we can enqueue again
    q.enqueue('b');
    expect(q.size).toBe(1);
    expect(q.dequeue()).toBe('b');
  });

  it('should support large number of items without issues', () => {
    const q = new FastQueue<number>();
    const count = 10000;

    for (let i = 0; i < count; i++) {
      q.enqueue(i);
    }
    expect(q.size).toBe(count);

    for (let i = 0; i < count; i++) {
      const val = q.dequeue();
      expect(val).toBe(i);
    }

    expect(q.size).toBe(0);
    expect(q.dequeue()).toBeUndefined();
  });
});
