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

    /**
     * Leader stores the fully-processed block template here after Merkle tree computation,
     * coinbase construction, and job ID generation. Workers read this directly via
     * getProcessedTemplate() to skip redundant CPU-heavy calculations.
     */
    @Column({ nullable: true, type: 'text' })
    processedData?: string;
}
