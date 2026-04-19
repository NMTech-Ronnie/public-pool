import { CreateDateColumn, DeleteDateColumn, UpdateDateColumn } from 'typeorm';

import { DateTimeTransformer } from './DateTimeTransformer';

const timestampType = () => (process.env.DB_TYPE === 'sqlite' ? 'datetime' : 'timestamptz');

export abstract class TrackedEntity {
    @DeleteDateColumn({ nullable: true, type: timestampType(), transformer: new DateTimeTransformer() })
    public deletedAt?: Date;

    @CreateDateColumn({ type: timestampType(), transformer: new DateTimeTransformer() })
    public createdAt?: Date;

    @UpdateDateColumn({ type: timestampType(), transformer: new DateTimeTransformer() })
    public updatedAt?: Date;
}
