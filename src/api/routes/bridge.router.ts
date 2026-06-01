import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { bridgeController } from '@api/server.module';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

export class BridgeRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router = Router();

    this.router.get(this.routerPath('snapshot'), ...guards, async (req, res) => {
      const instance = req.params as unknown as InstanceDto;
      const { take, skip } = req.query as { take?: number; skip?: number };

      const response = await bridgeController.getSnapshot(instance, { take, skip });
      return res.status(HttpStatus.OK).json(response);
    });

    this.router.get(this.routerPath('conversation'), ...guards, async (req, res) => {
      const instance = req.params as unknown as InstanceDto;
      const query = req.query as { remoteJid: string; take?: number; page?: number };

      const response = await bridgeController.getConversation(instance, query);
      return res.status(HttpStatus.OK).json(response);
    });

    this.router.get(this.routerPath('labels'), ...guards, async (req, res) => {
      const instance = req.params as unknown as InstanceDto;
      const response = await bridgeController.getLabels(instance);
      return res.status(HttpStatus.OK).json(response);
    });

    this.router.get(this.routerPath('stream'), ...guards, async (req, res) => {
      const instance = req.params as unknown as InstanceDto;
      const query = req.query as { events?: string };
      await bridgeController.stream(instance, query, res);
    });
  }
}
