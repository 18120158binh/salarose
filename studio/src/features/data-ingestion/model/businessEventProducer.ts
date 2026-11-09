import "server-only";
import { hostname } from "node:os";
import { Kafka, type Producer } from "kafkajs";
import { parseKafkaConnection, type Env, type KafkaConnection } from "../../../shared/lib/kafkaConnection";
import { businessEventKey, type BusinessEventRecord } from "./businessEvents";
import { personEventKey, type PersonEventRecord } from "./personEvents";

interface ProducerConfig extends KafkaConnection {
  businessTopic: string;
  eventsTopic: string;
}

// Null when INGESTION_KAFKA_BROKERS is unset. Throws on a setting that is present but invalid.
export function parseProducerConfig(env: Env): ProducerConfig | null {
  const connection = parseKafkaConnection(env, "INGESTION");
  if (!connection) return null;
  return {
    ...connection,
    businessTopic: env.KAFKA_BUSINESS_EVENTS_TOPIC?.trim() || "business-events",
    eventsTopic: env.KAFKA_INGESTION_API_TOPIC?.trim() || "ingestion-api-events",
  };
}

let producer: Promise<Producer> | null = null;
// One transaction at a time: a transactional producer cannot run two at once.
let queue: Promise<unknown> = Promise.resolve();

function connectedProducer(config: ProducerConfig): Promise<Producer> {
  if (!producer) {
    const kafka = new Kafka({ clientId: "studio-ingestion", brokers: config.brokers, ssl: config.ssl, sasl: config.sasl });
    // A transactional id per process, so a restarted process fences its earlier self.
    const created = kafka.producer({
      transactionalId: `studio-ingestion-${hostname()}`,
      idempotent: true,
      maxInFlightRequests: 1,
    });
    const pending = created.connect().then(() => created);
    pending.catch(() => {
      if (producer === pending) producer = null;
    });
    producer = pending;
  }
  return producer;
}

export function publishBusinessEvents(config: ProducerConfig, records: BusinessEventRecord[]): Promise<void> {
  return publish(
    config,
    config.businessTopic,
    records.map((record) => ({ key: businessEventKey(record), value: JSON.stringify(record) })),
  );
}

export function publishPersonEvents(config: ProducerConfig, records: PersonEventRecord[]): Promise<void> {
  return publish(
    config,
    config.eventsTopic,
    records.map((record) => ({ key: personEventKey(record), value: JSON.stringify(record) })),
  );
}

// Writes the whole batch in one transaction, so a failure stores none of it (DIA-NFR-04). Both
// routes share the producer and its queue, because its transactional id is one per process.
function publish(config: ProducerConfig, topic: string, messages: { key: string; value: string }[]): Promise<void> {
  const run = queue.then(async () => {
    const connected = await connectedProducer(config);
    const transaction = await connected.transaction();
    try {
      await transaction.send({ topic, messages });
      await transaction.commit();
    } catch (error) {
      await transaction.abort().catch(() => undefined);
      throw error;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
