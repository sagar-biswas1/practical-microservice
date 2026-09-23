import { Module, type Provider } from '@nestjs/common';
import { connect } from 'amqplib';

import { RabbitMqClient } from './rabbitmq.client';
import { AMQP_CONNECT, type AmqpConnect } from './rabbitmq.constants';

const connectProvider: Provider = {
  provide: AMQP_CONNECT,
  useValue: connect,
};

/**
 * Connected inside the factory, as the Redis clients are, so a wrong URL or
 * password fails the bootstrap with a clear error instead of the first
 * release after the transport is flipped — and so the connection is up
 * before any importing module's `onModuleInit` registers topology on it.
 */
const clientProvider: Provider = {
  provide: RabbitMqClient,
  useFactory: async (amqpConnect: AmqpConnect) => {
    const client = new RabbitMqClient(amqpConnect);
    await client.connect();
    return client;
  },
  inject: [AMQP_CONNECT],
};

/**
 * The cart's outbound connection to RabbitMQ.
 *
 * Not `@Global()`, unlike RedisModule: a module that publishes to other
 * services should have to say so by importing this, since that is the edge
 * where a change stops being this service's business alone. The client is
 * still a singleton — Nest instantiates a module once however many times it
 * is imported.
 *
 * Inert while `RABBITMQ_URL` is unset: the client constructs, reports itself
 * disabled, and rejects any publish, without ever opening a socket.
 */
@Module({
  providers: [connectProvider, clientProvider],
  exports: [RabbitMqClient],
})
export class MessagingModule {}
