const assert = require("node:assert/strict");
const test = require("node:test");
const { TaskSemaphore } = require("../bridge/task-semaphore.js");

test("동시 작업 수가 설정된 상한을 넘지 않는다", async () => {
  const semaphore = new TaskSemaphore(3);
  let running = 0;
  let maximumObserved = 0;

  await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    await semaphore.acquire();
    running += 1;
    maximumObserved = Math.max(maximumObserved, running);
    await new Promise((resolve) => setTimeout(resolve, 4 + index % 3));
    running -= 1;
    semaphore.release();
  }));

  assert.equal(maximumObserved, 3);
  assert.equal(semaphore.active, 0);
  assert.equal(semaphore.queued, 0);
});

test("빈 슬롯이 있으면 대기열 없이 즉시 획득한다", async () => {
  const semaphore = new TaskSemaphore(2);
  assert.deepEqual(await semaphore.acquire(), { queued: false });
  assert.deepEqual(await semaphore.acquire(), { queued: false });
  assert.equal(semaphore.active, 2);
  semaphore.release();
  semaphore.release();
});
