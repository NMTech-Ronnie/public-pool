import { Injectable, OnModuleInit } from '@nestjs/common';
import { Block } from 'bitcoinjs-lib';

import { DiscordService } from './discord.service';
import { LeaderElectionService } from './leader-election.service';
import { TelegramService } from './telegram.service';


@Injectable()
export class NotificationService implements OnModuleInit {

    constructor(
        private readonly telegramService: TelegramService,
        private readonly discordService: DiscordService,
        private readonly leaderElectionService: LeaderElectionService,
    ) { }

    async onModuleInit(): Promise<void> {
        if (this.leaderElectionService.getIsLeader()) {
            await this.discordService.notifyRestarted();
        }
    }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        await this.discordService.notifySubscribersBlockFound(height, block, message);
        await this.telegramService.notifySubscribersBlockFound(address, height, block, message);
    }
}
