import { ValueTransformer } from 'typeorm';

export class DateTimeTransformer implements ValueTransformer {
    to(value: Date): any {
        return value?.toISOString();
    }

    from(value: any): Date {
        return value ? new Date(value) : value;
    }
}
