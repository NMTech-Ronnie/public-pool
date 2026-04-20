import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AddressSettingsEntity } from './address-settings.entity';

interface CacheEntry {
    data: AddressSettingsEntity;
    timestamp: number;
}

@Injectable()
export class AddressSettingsService {

    // Simple LRU cache for address settings (60,000 addresses max per worker, 5 min TTL)
    private settingsCache = new Map<string, CacheEntry>();
    private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    private static readonly CACHE_MAX_ENTRIES = 60000; // 10,000 miners/worker × 6 = 60k total

    constructor(
        @InjectRepository(AddressSettingsEntity)
        private addressSettingsRepository: Repository<AddressSettingsEntity>
    ) {

    }

    public async getSettings(address: string, createIfNotFound: boolean) {
        const now = Date.now();

        // Check cache first
        const cached = this.settingsCache.get(address);
        if (cached && (now - cached.timestamp) < AddressSettingsService.CACHE_TTL_MS) {
            return cached.data;
        }

        // Cache miss or expired — query DB
        const settings = await this.addressSettingsRepository.findOne({ where: { address } });
        if (createIfNotFound == true && settings == null) {
            // It's possible to have a race condition here so if we get a PK violation, fetch it
            try {
                const newSettings = await this.createNew(address);
                this.cacheSettings(address, newSettings, now);
                return newSettings;
            } catch (e) {
                const found = await this.addressSettingsRepository.findOne({ where: { address } });
                if (found) this.cacheSettings(address, found, now);
                return found;
            }
        }
        if (settings) this.cacheSettings(address, settings, now);
        return settings;
    }

    private cacheSettings(address: string, settings: AddressSettingsEntity, timestamp: number) {
        // Evict oldest entry if cache is full (simple FIFO to avoid O(n) LRU)
        if (this.settingsCache.size >= AddressSettingsService.CACHE_MAX_ENTRIES) {
            const oldest = Array.from(this.settingsCache.entries())
                .reduce((min, cur) => cur[1].timestamp < min[1].timestamp ? cur : min);
            this.settingsCache.delete(oldest[0]);
        }
        this.settingsCache.set(address, { data: settings, timestamp });
    }

    public async updateBestDifficulty(address: string, bestDifficulty: number, bestDifficultyUserAgent: string) {
        const result = await this.addressSettingsRepository.update(
            { address },
            { bestDifficulty, bestDifficultyUserAgent, updatedAt: new Date() }
        );
        // Invalidate cache so next query fetches fresh data
        this.settingsCache.delete(address);
        return result;
    }

    public async getHighScores() {
        return await this.addressSettingsRepository.createQueryBuilder()
            .select('"updatedAt", "bestDifficulty", "bestDifficultyUserAgent"')
            .orderBy('"bestDifficulty"', 'DESC')
            .limit(10)
            .execute();
    }

    public async createNew(address: string) {
        return await this.addressSettingsRepository.save({ address });
    }

    public async addShares(address: string, shares: number) {
        return await this.addressSettingsRepository.createQueryBuilder()
            .update(AddressSettingsEntity)
            .set({
                shares: () => `"shares" + ${shares}` // Use the actual value of shares here
            })
            .where('address = :address', { address })
            .execute();
    }

    public async resetBestDifficultyAndShares() {
        const result = await this.addressSettingsRepository.update({}, {
            shares: 0,
            bestDifficulty: 0
        });
        // Clear entire cache since all addresses are modified
        this.settingsCache.clear();
        return result;
    }
}