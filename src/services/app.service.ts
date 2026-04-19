import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import { LeaderElectionService } from './leader-election.service';

@Injectable()
export class AppService implements OnModuleInit {

    constructor(
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientService: ClientService,
        private readonly dataSource: DataSource,
        private readonly rpcBlockService: RpcBlockService,
        private readonly leaderElectionService: LeaderElectionService,
    ) {

    }

    async onModuleInit() {

        if (this.leaderElectionService.getIsLeader()) {

            setInterval(async () => {
                await this.deleteOldStatistics();
            }, 1000 * 60 * 60);

            setInterval(async () => {
                console.log('Killing dead clients');
                await this.clientService.killDeadClients();
            }, 1000 * 60 * 5);

            setInterval(async () => {
                console.log('Deleting Old Blocks');
                await this.rpcBlockService.deleteOldBlocks();
            }, 1000 * 60 * 60 * 24);



        }

    }

    private async deleteOldStatistics() {
        console.log('Deleting statistics');

        const deletedStatistics = await this.clientStatisticsService.deleteOldStatistics();
        console.log(`Deleted ${deletedStatistics.affected} old statistics`);
        const deletedClients = await this.clientService.deleteOldClients();
        console.log(`Deleted ${deletedClients.affected} old clients`);

    }


}
