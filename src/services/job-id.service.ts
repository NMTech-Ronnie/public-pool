import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class JobIdService {
    constructor(private readonly dataSource: DataSource) {}

    public async getNextJobId(): Promise<string> {
        const result = await this.dataSource.query(
            "SELECT nextval('job_id_seq') as val",
        );
        return (result[0]?.val as number).toString(16);
    }

    public async getNextTemplateId(): Promise<string> {
        const result = await this.dataSource.query(
            "SELECT nextval('job_template_id_seq') as val",
        );
        return (result[0]?.val as number).toString(16);
    }
}
