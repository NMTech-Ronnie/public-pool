/**
 * Aggregate statistics collector for a single worker process.
 * Instead of per-event console.log, this collects counters and prints
 * a summary every PRINT_INTERVAL_MS milliseconds.
 */
export class WorkerStats {
    private static instance: WorkerStats | null = null;

    private connects = 0;
    private disconnects = 0;
    private timeouts = 0;
    private sharesAccepted = 0;
    private sharesRejected = 0;
    private sharesDuplicate = 0;
    private jobsNotFound = 0;
    private blocksFound = 0;
    private activeClients = 0;
    private printTimer: NodeJS.Timer | null = null;

    private static readonly PRINT_INTERVAL_MS = 30_000; // 30 seconds

    private constructor() {}

    public static getInstance(): WorkerStats {
        if (!WorkerStats.instance) {
            WorkerStats.instance = new WorkerStats();
        }
        return WorkerStats.instance;
    }

    public start() {
        if (this.printTimer) return;
        this.printTimer = setInterval(() => this.printAndReset(), WorkerStats.PRINT_INTERVAL_MS);
        // Don't block process exit
        if (this.printTimer && typeof this.printTimer === 'object' && 'unref' in this.printTimer) {
            (this.printTimer as any).unref();
        }
    }

    public stop() {
        if (this.printTimer) {
            clearInterval(this.printTimer);
            this.printTimer = null;
        }
    }

    public onConnect() { this.connects++; this.activeClients++; }
    public onDisconnect() { this.disconnects++; if (this.activeClients > 0) this.activeClients--; }
    public onTimeout() { this.timeouts++; }
    public onShareAccepted() { this.sharesAccepted++; }
    public onShareRejected() { this.sharesRejected++; }
    public onShareDuplicate() { this.sharesDuplicate++; }
    public onJobNotFound() { this.jobsNotFound++; }
    public onBlockFound() { this.blocksFound++; }

    private printAndReset() {
        const w = process.env.NODE_APP_INSTANCE || '0';
        const parts: string[] = [
            `[W${w}]`,
            `active=${this.activeClients}`,
            `+${this.connects}/-${this.disconnects}`,
            `shares=${this.sharesAccepted}/${this.sharesRejected}`,
        ];
        if (this.sharesDuplicate > 0) parts.push(`dup=${this.sharesDuplicate}`);
        if (this.jobsNotFound > 0) parts.push(`jnf=${this.jobsNotFound}`);
        if (this.timeouts > 0) parts.push(`tout=${this.timeouts}`);
        if (this.blocksFound > 0) parts.push(`BLOCKS=${this.blocksFound}`);

        console.log(parts.join(' '));

        // Reset per-interval counters (activeClients is cumulative, not reset)
        this.connects = 0;
        this.disconnects = 0;
        this.timeouts = 0;
        this.sharesAccepted = 0;
        this.sharesRejected = 0;
        this.sharesDuplicate = 0;
        this.jobsNotFound = 0;
        this.blocksFound = 0;
    }
}
