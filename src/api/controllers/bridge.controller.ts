import { InstanceDto } from '@api/dto/instance.dto';
import { BridgeService } from '@api/services/bridge.service';
import { Response } from 'express';

export class BridgeController {
  constructor(private readonly bridgeService: BridgeService) {}

  public async getSnapshot({ instanceName }: InstanceDto, query: { take?: number; skip?: number }) {
    return await this.bridgeService.getSnapshot(instanceName, query || {});
  }

  public async getConversation(
    { instanceName }: InstanceDto,
    query: { remoteJid: string; take?: number; page?: number },
  ) {
    return await this.bridgeService.getConversation(instanceName, query);
  }

  public async getLabels({ instanceName }: InstanceDto) {
    return await this.bridgeService.getLabels(instanceName);
  }

  public async stream(
    { instanceName }: InstanceDto,
    query: { events?: string },
    res: Response,
  ) {
    await this.bridgeService.stream(instanceName, res, query || {});
  }
}
