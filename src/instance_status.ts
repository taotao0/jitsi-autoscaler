import Redis from 'ioredis';
import logger from './logger';
import { JibriTracker, JibriState, JibriStatus, JibriMetaData } from './jibri_tracker';

const ShutdownTTL = 900;
const StatsTTL = 900;

export interface InstanceDetails {
    instanceId: string;
    instanceType: string;
    cloud?: string;
    region?: string;
    group?: string;
}

export interface StatsReport {
    instance: InstanceDetails;
    timestamp?: number;
    stats: unknown;
}

export interface InstanceStatusOptions {
    redisClient: Redis.Redis;
    jibriTracker: JibriTracker;
}

export interface JibriStats {
    status: JibriStatus;
}

export class InstanceStatus {
    private redisClient: Redis.Redis;
    private jibriTracker: JibriTracker;

    constructor(options: InstanceStatusOptions) {
        //this.setPending = this.setPending.bind(this);
        this.redisClient = options.redisClient;
        this.jibriTracker = options.jibriTracker;

        this.setShutdownStatus = this.setShutdownStatus.bind(this);
        this.getShutdownStatus = this.getShutdownStatus.bind(this);
        this.stats = this.stats.bind(this);
    }

    instanceKey(details: InstanceDetails, type = 'shutdown'): string {
        return `instance:${type}:${details.instanceId}`;
    }

    async setShutdownStatus(details: InstanceDetails, status = 'shutdown'): Promise<boolean> {
        const key = this.instanceKey(details);
        logger.debug('Writing shutdown status', { key, status });
        await this.redisClient.set(key, status, 'ex', ShutdownTTL);
        return true;
    }

    async getShutdownStatus(details: InstanceDetails): Promise<boolean> {
        const key = this.instanceKey(details);
        const res = await this.redisClient.get(key);
        logger.debug('Read shutdown status', { key, res });
        if (res == 'shutdown') {
            return true;
        }
        return false;
    }

    // @TODO: handle stats like JibriTracker does
    async stats(report: StatsReport): Promise<boolean> {
        let statsResult = false;
        let key: string;
        let jibriState: JibriState;
        let jibriStats: JibriStats;
        switch (report.instance.instanceType) {
            case 'jibri':
                jibriStats = <JibriStats>report.stats;
                jibriState = {
                    jibriId: report.instance.instanceId,
                    status: jibriStats.status,
                    timestamp: report.timestamp,
                    metadata: <JibriMetaData>{ ...report.instance },
                };
                logger.debug('Tracking jibri state', { state: jibriState });
                statsResult = await this.jibriTracker.track(jibriState);
                break;
            default:
                key = this.instanceKey(report.instance, 'stats');
                logger.debug('Writing instance stats', { key, stats: report.stats });
                await this.redisClient.set(key, JSON.stringify(report.stats), 'ex', StatsTTL);
                statsResult = true;
                break;
        }
        return statsResult;
    }
}
