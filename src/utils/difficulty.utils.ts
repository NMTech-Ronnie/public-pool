import * as crypto from 'crypto';

const TRUEDIFFONE = BigInt(
  '26959535291011309493156476344723991336010898738574164086137773096960',
);

export class DifficultyUtils {
  static calculateDifficulty(header: Buffer): { submissionDifficulty: number } {
    const hash1 = crypto.createHash('sha256').update(header).digest();
    const hashResult = crypto.createHash('sha256').update(hash1).digest();

    let hashBigInt = 0n;
    for (let i = hashResult.length - 1; i >= 0; i--) {
      hashBigInt = (hashBigInt << 8n) | BigInt(hashResult[i]);
    }

    if (hashBigInt === 0n) {
      return { submissionDifficulty: Number.MAX_SAFE_INTEGER };
    }

    // Use fixed-point arithmetic to preserve fractional precision
    // (BigInt division truncates, so we scale up first)
    const SCALE = 1_000_000_000_000n;
    const scaledDifficulty = (TRUEDIFFONE * SCALE) / hashBigInt;

    return {
      submissionDifficulty: Number(scaledDifficulty) / 1e12,
    };
  }
}
