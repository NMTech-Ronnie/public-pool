import { ValueTransformer } from 'typeorm';

export class DateTimeTransformer implements ValueTransformer {
  to(value: Date): any {
    // Store as ISO 8601 format that SQLite DATETIME() can parse/compare correctly.
    // toLocaleString() produces locale-dependent strings (e.g. "4/17/2026, 5:10:20 AM")
    // which SQLite's DATETIME() cannot parse, breaking time comparisons in killDeadClients.
    return value?.toISOString?.() ?? value;
  }

  from(value: any): Date {
    // Convert the stored ISO string back to a Date object
    return value ? new Date(value) : value;
  }
}
