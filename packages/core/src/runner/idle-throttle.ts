const DELAYS = [0, 1000, 2000, 5000, 10000];

export class IdleThrottle {
  private consecutiveIdleCount = 0;

  onIteration(hadMessages: boolean): number {
    if (hadMessages) {
      this.consecutiveIdleCount = 0;
      return 0;
    }

    this.consecutiveIdleCount++;
    const idx = Math.min(this.consecutiveIdleCount, DELAYS.length - 1);
    return DELAYS[idx];
  }

  reset(): void {
    this.consecutiveIdleCount = 0;
  }
}
