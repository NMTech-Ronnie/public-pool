import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { DateTimeTransformer } from '../utils/DateTimeTransformer';
import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
@Index(['address', 'clientName', 'sessionId'], { unique: true })
// Index updatedAt for efficient stale connection cleanup queries
@Index(['updatedAt'])
export class ClientEntity extends TrackedEntity {


    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    @PrimaryColumn({ length: 64, type: 'varchar' })
    clientName: string;

    @PrimaryColumn({ length: 8, type: 'varchar' })
    sessionId: string;


    @Column({ length: 128, type: 'varchar', nullable: true })
    userAgent: string;



    @Column({ transformer: new DateTimeTransformer() })
    startTime: Date;

    @Column({ type: 'real', default: 0 })
    bestDifficulty: number

    @Column({ default: 0 })
    hashRate: number;

}

