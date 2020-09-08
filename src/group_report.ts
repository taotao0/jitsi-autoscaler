import { InstanceState, InstanceTracker, JibriStatusState } from './instance_tracker';
import { Context } from './context';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import CloudManager, { CloudInstance, CloudRetryStrategy } from './cloud_manager';
import ShutdownManager from './shutdown_manager';

export interface InstanceReport {
    instanceId: string;
    displayName?: string;
    scaleStatus?: string;
    cloudStatus?: string;
    isShuttingDown?: boolean;
    isScaleDownProtected?: boolean;
    privateIp?: string;
    publicIp?: string;
}

export interface GroupReport {
    groupName: string;
    count?: number;
    desiredCount?: number;
    provisioningCount?: number;
    availableCount?: number;
    busyCount?: number;
    cloudCount?: number;
    unTrackedCount?: number;
    shuttingDownCount?: number;
    scaleDownProtectedCount?: number;
    instances?: Array<InstanceReport>;
}

export interface GroupReportGeneratorOptions {
    instanceTracker: InstanceTracker;
    instanceGroupManager: InstanceGroupManager;
    cloudManager: CloudManager;
    shutdownManager: ShutdownManager;
    reportExtCallRetryStrategy: CloudRetryStrategy;
}

export default class GroupReportGenerator {
    private instanceTracker: InstanceTracker;
    private instanceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;
    private shutdownManager: ShutdownManager;
    private reportExtCallRetryStrategy: CloudRetryStrategy;

    constructor(options: GroupReportGeneratorOptions) {
        this.instanceTracker = options.instanceTracker;
        this.instanceGroupManager = options.instanceGroupManager;
        this.cloudManager = options.cloudManager;
        this.shutdownManager = options.shutdownManager;
        this.reportExtCallRetryStrategy = options.reportExtCallRetryStrategy;

        this.generateReport = this.generateReport.bind(this);
    }

    async generateReport(ctx: Context, groupName: string): Promise<GroupReport> {
        const group: InstanceGroup = await this.instanceGroupManager.getInstanceGroup(groupName);
        if (!group) {
            throw new Error(`Group ${groupName} not found, failed to generate report`);
        }
        if (!group.type) {
            throw new Error('Only typed groups are supported for report generation');
        }

        const groupReport: GroupReport = {
            groupName: groupName,
            desiredCount: group.scalingOptions.desiredCount,
            count: 0,
            cloudCount: 0,
            provisioningCount: 0,
            availableCount: 0,
            busyCount: 0,
            unTrackedCount: 0,
            shuttingDownCount: 0,
            scaleDownProtectedCount: 0,
            instances: [],
        };

        // Get the list of instances from redis and from the cloud manager
        const instanceStates = await this.instanceTracker.getCurrent(ctx, groupName, false);
        groupReport.count = instanceStates.length;
        const cloudInstances = await this.cloudManager.getInstances(ctx, group, this.reportExtCallRetryStrategy);

        this.getInstanceReportsMap(group, instanceStates, cloudInstances).forEach((instanceReport) => {
            groupReport.instances.push(instanceReport);
        });

        await this.addShutdownStatus(ctx, groupReport.instances);
        await this.addShutdownProtectedStatus(ctx, groupReport.instances);

        groupReport.instances.forEach((instanceReport) => {
            if (instanceReport.cloudStatus === 'Provisioning' || instanceReport.cloudStatus === 'Running') {
                groupReport.cloudCount++;
            }
            if (instanceReport.isShuttingDown) {
                groupReport.shuttingDownCount++;
            }
            if (instanceReport.isScaleDownProtected) {
                groupReport.scaleDownProtectedCount++;
            }
            if (
                instanceReport.scaleStatus == 'unknown' &&
                (instanceReport.cloudStatus === 'Provisioning' || instanceReport.cloudStatus === 'Running')
            ) {
                groupReport.unTrackedCount++;
            }
            if (instanceReport.scaleStatus == 'PROVISIONING') {
                groupReport.provisioningCount++;
            }
            switch (group.type) {
                case 'jibri':
                    if (instanceReport.scaleStatus == JibriStatusState.Idle) {
                        groupReport.availableCount++;
                    }
                    if (instanceReport.scaleStatus == JibriStatusState.Busy) {
                        groupReport.busyCount++;
                    }
                    break;
                case 'JVB':
                    // @TODO: implement JVB instance counting
                    break;
            }
        });

        return groupReport;
    }

    private getInstanceReportsMap(
        group: InstanceGroup,
        instanceStates: Array<InstanceState>,
        cloudInstances: Array<CloudInstance>,
    ): Map<string, InstanceReport> {
        const instanceReports = new Map<string, InstanceReport>();

        instanceStates.forEach((instanceState) => {
            const instanceReport = <InstanceReport>{
                instanceId: instanceState.instanceId,
                displayName: 'unknown',
                scaleStatus: 'unknown',
                cloudStatus: 'unknown',
                isShuttingDown: instanceState.shutdownStatus,
                isScaleDownProtected: false,
            };
            if (instanceState.status.provisioning) {
                instanceReport.scaleStatus = 'PROVISIONING';
            } else {
                switch (group.type) {
                    case 'jibri':
                        if (instanceState.status.jibriStatus) {
                            instanceReport.scaleStatus = instanceState.status.jibriStatus.busyStatus.toString();
                        }
                        break;
                    case 'JVB':
                        // @TODO: convert JVB stats into more explict statuses
                        instanceReport.scaleStatus = 'ONLINE';
                        break;
                }
            }
            if (instanceState.metadata.publicIp) {
                instanceReport.publicIp = instanceState.metadata.publicIp;
            }
            if (instanceState.metadata.privateIp) {
                instanceReport.privateIp = instanceState.metadata.privateIp;
            }
            instanceReports.set(instanceState.instanceId, instanceReport);
        });

        cloudInstances.forEach((cloudInstance) => {
            let instanceReport = instanceReports.get(cloudInstance.instanceId);
            if (!instanceReport) {
                instanceReport = {
                    instanceId: cloudInstance.instanceId,
                    displayName: cloudInstance.displayName,
                    scaleStatus: 'unknown',
                    cloudStatus: cloudInstance.cloudStatus,
                    isShuttingDown: false,
                    isScaleDownProtected: false,
                };
            } else {
                instanceReport.displayName = cloudInstance.displayName;
                instanceReport.cloudStatus = cloudInstance.cloudStatus;
            }
            instanceReports.set(cloudInstance.instanceId, instanceReport);
        });

        return instanceReports;
    }

    private async addShutdownStatus(ctx: Context, instanceReports: Array<InstanceReport>): Promise<void> {
        const instanceReportsShutdownStatus: boolean[] = await Promise.all(
            instanceReports.map((instanceReport) => {
                return (
                    instanceReport.isShuttingDown ||
                    this.shutdownManager.getShutdownStatus(ctx, instanceReport.instanceId)
                );
            }),
        );
        instanceReports.forEach((instanceReport, index) => {
            instanceReport.isShuttingDown = instanceReportsShutdownStatus[index];
        });
    }

    private async addShutdownProtectedStatus(ctx: Context, instanceReports: Array<InstanceReport>): Promise<void> {
        const instanceReportsShutdownStatus: boolean[] = await Promise.all(
            instanceReports.map((instanceReport) => {
                return this.shutdownManager.isScaleDownProtected(ctx, instanceReport.instanceId);
            }),
        );
        instanceReports.forEach((instanceReport, index) => {
            instanceReport.isScaleDownProtected = instanceReportsShutdownStatus[index];
        });
    }
}
