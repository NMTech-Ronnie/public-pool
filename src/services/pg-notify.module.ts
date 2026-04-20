import { Global, Module } from '@nestjs/common';

import { PgNotifyService } from './pg-notify.service';

@Global()
@Module({
    providers: [PgNotifyService],
    exports: [PgNotifyService],
})
export class PgNotifyModule {}