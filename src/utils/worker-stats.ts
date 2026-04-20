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
    private socketClosedWrites = 0;
    private socketWriteErrors = 0;
    private socketResets = 0;
    private socketTimeouts = 0;
    private socketUnreachable = 0;
    private socketCanceled = 0;
    private heartbeatFlushErrors = 0;
    private statsFlushErrors = 0;
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
    public onSocketClosedWrite() { this.socketClosedWrites++; }
    public onSocketWriteError(code?: string) {
        if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED') {
            this.socketResets++;
        } else if (code === 'ETIMEDOUT') {
            this.socketTimeouts++;
        } else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
            this.socketUnreachable++;
        } else if (code === 'ECANCELED') {
            this.socketCanceled++;
        } else {
            this.socketWriteErrors++;
        }
    }
    public onHeartbeatFlushError() { this.heartbeatFlushErrors++; }
    public onStatsFlushError() { this.statsFlushErrors++; }

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
        if (this.socketClosedWrites > 0) parts.push(`sockClosed=${this.socketClosedWrites}`);
        if (this.socketResets > 0) parts.push(`sockReset=${this.socketResets}`);
        if (this.socketTimeouts > 0) parts.push(`sockTimeout=${this.socketTimeouts}`);
        if (this.socketUnreachable > 0) parts.push(`sockUnreach=${this.socketUnreachable}`);
        if (this.socketCanceled > 0) parts.push(`sockCancel=${this.socketCanceled}`);
        if (this.socketWriteErrors > 0) parts.push(`sockErr=${this.socketWriteErrors}`);
        if (this.heartbeatFlushErrors > 0) parts.push(`hbErr=${this.heartbeatFlushErrors}`);
        if (this.statsFlushErrors > 0) parts.push(`statErr=${this.statsFlushErrors}`);
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
        this.socketClosedWrites = 0;
        this.socketWriteErrors = 0;
        this.socketResets = 0;
        this.socketTimeouts = 0;
        this.socketUnreachable = 0;
        this.socketCanceled = 0;
        this.heartbeatFlushErrors = 0;
        this.statsFlushErrors = 0;
    }
}
