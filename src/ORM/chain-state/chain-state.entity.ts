import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class ChainStateEntity {
    @PrimaryColumn()
    id: number; // Always 1 (singleton row)

    @Column()
    height: number;

    @Column({ type: 'timestamptz' })
    updatedAt: Date;
}
