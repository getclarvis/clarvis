/** Stop a turn after repeated completed semantic denials. */
export class DenialCircuitBreaker {
  private consecutive = 0;
  private readonly recent: boolean[] = [];

  record(denied: boolean): boolean {
    this.consecutive = denied ? this.consecutive + 1 : 0;
    this.recent.push(denied);
    if (this.recent.length > 50) this.recent.shift();
    return this.open;
  }

  get open(): boolean {
    return this.consecutive >= 3 || this.recent.filter(Boolean).length >= 10;
  }
}
