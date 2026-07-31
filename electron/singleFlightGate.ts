/**
 * Main 进程内的同步单航班闸门。`tryAcquire` 在任何异步边界之前抢占，
 * 用于阻止同一个外部写操作被重复审批并并发执行。
 */
export class SingleFlightGate {
  private locked = false;

  isLocked() {
    return this.locked;
  }

  tryAcquire() {
    if (this.locked) return null;
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locked = false;
    };
  }
}
