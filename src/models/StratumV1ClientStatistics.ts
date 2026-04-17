import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';

const CACHE_SIZE = 30;
const TARGET_SUBMISSION_PER_SECOND = 10;
const MIN_DIFF = 0.00001;
export class StratumV1ClientStatistics {
  private shares = 0;
  private acceptedCount = 0;

  private submissionCacheStart: Date;
  private submissionCache: { time: Date; difficulty: number }[] = [];

  private currentTimeSlot: number = null;
  private lastSave: number = null;

  public hashRate = 0;

  private previousTimeSlotTime: Date;
  private currentTimeSlotTime: Date;

  private previousShares = 0;

  // Flag: whether current time slot has been inserted into DB
  private currentSlotInserted = false;
  // Dirty flag: whether in-memory data has unsaved changes
  private dirty = false;

  constructor(
    private readonly clientStatisticsService: ClientStatisticsService,
  ) {
    this.submissionCacheStart = new Date();
  }

  /**
   * Accumulate shares in memory. NO direct DB writes.
   * All DB operations are batched via flushToDb().
   */
  public addShares(client: ClientEntity, targetDifficulty: number) {
    // 10 min
    const coeff = 1000 * 60 * 10;
    const date = new Date();
    const timeSlot = new Date(
      Math.floor(date.getTime() / coeff) * coeff,
    ).getTime();

    if (this.submissionCache.length > CACHE_SIZE) {
      this.submissionCache.shift();
    }
    this.submissionCache.push({
      time: date,
      difficulty: targetDifficulty,
    });

    if (this.currentTimeSlot == null) {
      // First record
      this.previousTimeSlotTime = new Date();
      this.currentTimeSlotTime = new Date();
      this.currentTimeSlot = timeSlot;
      this.shares += targetDifficulty;
      this.acceptedCount++;
      this.currentSlotInserted = false;
      this.dirty = true;
    } else if (this.currentTimeSlot != timeSlot) {
      // Transitioning to a new time slot
      // Flush the old slot data before transitioning
      this.flushCurrentSlot(client);

      this.previousShares = this.shares;
      this.previousTimeSlotTime = this.currentTimeSlotTime;
      this.currentTimeSlotTime = new Date();
      // New time slot
      this.currentTimeSlot = timeSlot;
      this.shares = targetDifficulty;
      this.acceptedCount = 1;
      this.currentSlotInserted = false;
      this.dirty = true;
    } else {
      // Same time slot
      this.shares += targetDifficulty;
      this.acceptedCount++;
      this.dirty = true;

      if (this.shares > 0) {
        const time = new Date().getTime() - this.previousTimeSlotTime.getTime();
        this.hashRate =
          ((this.previousShares + this.shares) * 4294967296) / (time / 1000);
      }
    }
  }

  /**
   * Queue current statistics to the batched write system.
   * Called by the centralized flush timer, NOT per-share.
   */
  public flushCurrentSlot(client: ClientEntity) {
    if (!this.dirty || this.currentTimeSlot == null || client == null) return;

    const stat = {
      time: this.currentTimeSlot,
      shares: this.shares,
      acceptedCount: this.acceptedCount,
      address: client.address,
      clientName: client.clientName,
      sessionId: client.sessionId,
    };

    if (!this.currentSlotInserted) {
      this.clientStatisticsService.queueInsert(stat);
      this.currentSlotInserted = true;
    } else {
      this.clientStatisticsService.queueUpdate(stat);
    }

    this.lastSave = new Date().getTime();
    this.dirty = false;
  }

  public getSuggestedDifficulty(clientDifficulty: number) {
    // miner hasn't submitted shares in one minute
    if (this.submissionCache.length < 5) {
      if (
        (new Date().getTime() - this.submissionCacheStart.getTime()) / 1000 >
        60
      ) {
        return this.nearestPowerOfTwo(clientDifficulty / 6);
      } else {
        return null;
      }
    }

    const sum = this.submissionCache.reduce((pre, cur) => {
      pre += cur.difficulty;
      return pre;
    }, 0);
    const diffSeconds =
      (this.submissionCache[this.submissionCache.length - 1].time.getTime() -
        this.submissionCache[0].time.getTime()) /
      1000;

    const difficultyPerSecond = sum / diffSeconds;

    const targetDifficulty = difficultyPerSecond * TARGET_SUBMISSION_PER_SECOND;

    if (
      clientDifficulty * 2 < targetDifficulty ||
      clientDifficulty / 2 > targetDifficulty
    ) {
      return this.nearestPowerOfTwo(targetDifficulty);
    }

    return null;
  }

  private nearestPowerOfTwo(val): number {
    if (val === 0 || !Number.isFinite(val)) {
      return null;
    }
    if (val < MIN_DIFF) {
      return MIN_DIFF;
    }
    // For fractional values, scale up iteratively then scale back down
    let scale = 1;
    let v = val;
    while (v < 1 && scale < 1e15) {
      v *= 100;
      scale *= 100;
    }
    let x = v | (v >> 1);
    x = x | (x >> 2);
    x = x | (x >> 4);
    x = x | (x >> 8);
    x = x | (x >> 16);
    x = x | (x >> 32);
    const res = x - (x >> 1);
    if (res == 0) {
      return MIN_DIFF;
    }
    const result = res / scale;
    return result < MIN_DIFF ? MIN_DIFF : result;
  }
}
