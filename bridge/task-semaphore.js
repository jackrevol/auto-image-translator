"use strict";

class TaskSemaphore {
  constructor(maximum) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error("maximum은 1 이상의 정수여야 합니다.");
    this.maximum = maximum;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.maximum) {
      this.active += 1;
      return { queued: false };
    }
    const position = this.queue.length + 1;
    await new Promise((resolve) => this.queue.push(resolve));
    return { queued: true, position };
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return { transferred: true };
    }
    this.active = Math.max(0, this.active - 1);
    return { transferred: false };
  }

  get queued() {
    return this.queue.length;
  }
}

module.exports = { TaskSemaphore };
