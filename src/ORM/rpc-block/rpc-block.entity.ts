import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class RpcBlockEntity {

    @PrimaryColumn()
    blockHeight: number;

    @Column({ nullable: true })
    lockedBy?: string;

    @Column({ nullable: true, type: 'timestamptz' })
    lockedAt?: Date;

    @Column({ nullable: true, type: 'text' })
    data?: string;
}